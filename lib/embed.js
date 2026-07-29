const config = require('./config');
const util = require('./util');
const { embedQueue } = require('./queue'); // v1.18.0 (#4): 可配置并发队列

// v1.17.0 (#101): 嵌入结果缓存——相同文本（按内容归一化哈希）不重复调用远端 embedding，降延迟省调用。
// 内存 Map 为主（进程生命周期，封顶 500 条），并惰性持久化到 kv（'embed:<hash>'）跨重启复用。
const _embedCache = new Map();
let _hits = 0, _miss = 0;
function _cacheKey(text) { return util.hashContent(text); }

// v1.22.1 (#137): 带重试的远端嵌入——首次超时/失败自动重试 2 次（指数退避 + 渐进超时）
async function _embedRemote(text) {
  const C = config.CONFIG;
  if (!C.embedding_url) throw new Error('EMBEDDING_URL not configured');
  const isOpenAI = C.embedding_url.includes('/v1/embeddings');
  const body = isOpenAI
    ? { model: C.embedding_model, input: [text] }
    : { model: C.embedding_model, input: text };
  const baseTimeout = C.embedding_timeout_ms || 60000; // v1.22.1: 默认改为 60s（原 30s 在冷启动时不够）
  const maxRetries = 2;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeout = baseTimeout * (1 + attempt * 0.5); // 渐进：60s → 90s → 120s
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(C.embedding_url, {
        method: 'POST', headers: authHeaders(C.embedding_api_key || null),
        body: JSON.stringify(body), signal: ctrl.signal });
      if (r.ok) {
        const d = await r.json();
        return isOpenAI ? d.data[0].embedding : d.embeddings[0];
      }
      lastError = new Error('embed http ' + r.status);
    } catch (e) {
      lastError = e;
    } finally { clearTimeout(to); }
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 4000); // 1s → 2s
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError || new Error('embed failed after retries');
}

// v1.22.1 (#137): 冷启动预热——服务启动时提前加载 embedding 模型，避免首次调用超时
let _warmedUp = false;
async function warmupEmbedding() {
  if (_warmedUp) return true;
  if (!config.CONFIG.embedding_url) return false;
  try {
    // 用一个极短文本触发模型加载，给予充足超时（冷启动可能较慢）
    const C = config.CONFIG;
    const isOpenAI = C.embedding_url.includes('/v1/embeddings');
    const body = isOpenAI
      ? { model: C.embedding_model, input: ['warmup'] }
      : { model: C.embedding_model, input: 'warmup' };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 120000); // 冷启动给 2 分钟
    try {
      const r = await fetch(C.embedding_url, {
        method: 'POST', headers: authHeaders(C.embedding_api_key || null),
        body: JSON.stringify(body), signal: ctrl.signal });
      if (r.ok) { _warmedUp = true; return true; }
    } finally { clearTimeout(to); }
  } catch (e) { /* 预热失败静默，后续调用会触发 retry */ }
  return false;
}

async function embed(text) {
  const key = _cacheKey(text);
  if (_embedCache.has(key)) { _hits++; return _embedCache.get(key); }
  // 持久层命中（惰性 require 避免与 backend 的循环依赖）
  try { const backend = require('./backend'); const v = backend.kvGet('embed:' + key, ''); if (v) { const arr = JSON.parse(v); _embedCache.set(key, arr); _hits++; return arr; } } catch (e) {}
  _miss++;
  // v1.18.0 (#4): 通过可配置并发队列执行远端调用
  const qr = await embedQueue.enqueue(() => _embedRemote(text));
  if (!qr.ok) throw new Error('embed queue: ' + (qr.error || 'failed'));
  const vec = qr.result;
  _embedCache.set(key, vec);
  if (_embedCache.size > 500) _embedCache.delete(_embedCache.keys().next().value);
  try { const backend = require('./backend'); backend.kvSet('embed:' + key, JSON.stringify(vec), ''); } catch (e) {}
  return vec;
}

function cacheStats() { return { hits: _hits, misses: _miss, size: _embedCache.size }; }

// v1.20.0 (#4a): 批量嵌入——一次 HTTP 请求嵌入多段文本，减少 N 次串行 HTTP 到 1 次。
// 先查缓存，未命中的批量请求远端。返回 number[][]（与 texts 顺序对齐）。
async function embedBatch(texts) {
  if (!texts || !texts.length) return [];
  const C = config.CONFIG;
  if (!C.embedding_url) throw new Error('EMBEDDING_URL not configured');
  // 先查缓存，收集需要远端计算的
  const results = new Array(texts.length);
  const missIdx = [];
  const missTexts = [];
  for (let i = 0; i < texts.length; i++) {
    const key = _cacheKey(texts[i]);
    if (_embedCache.has(key)) { _hits++; results[i] = _embedCache.get(key); }
    else {
      // 持久层
      let cached = null;
      try { const backend = require('./backend'); const v = backend.kvGet('embed:' + key, ''); if (v) cached = JSON.parse(v); } catch (e) {}
      if (cached) { _embedCache.set(key, cached); _hits++; results[i] = cached; }
      else { _miss++; missIdx.push(i); missTexts.push(texts[i]); }
    }
  }
  if (!missTexts.length) return results;
  // 批量请求远端
  const isOpenAI = C.embedding_url.includes('/v1/embeddings');
  const body = isOpenAI
    ? { model: C.embedding_model, input: missTexts }
    : { model: C.embedding_model, input: missTexts }; // Ollama 也支持 input 数组
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), C.embedding_timeout_ms || 30000);
  let r;
  try {
    r = await fetch(C.embedding_url, {
      method: 'POST', headers: authHeaders(C.embedding_api_key || null),
      body: JSON.stringify(body), signal: ctrl.signal });
  } finally { clearTimeout(to); }
  if (!r.ok) throw new Error('embedBatch http ' + r.status);
  const d = await r.json();
  // OpenAI 格式：d.data[i].embedding（按 index 排序保证顺序）
  // Ollama 格式：d.embeddings[i]
  let vecs;
  if (isOpenAI) {
    vecs = d.data.sort((a, b) => a.index - b.index).map(x => x.embedding);
  } else {
    vecs = d.embeddings || (d.embedding ? [d.embedding] : []);
  }
  // 写回缓存 + results
  for (let j = 0; j < missIdx.length && j < vecs.length; j++) {
    const idx = missIdx[j];
    const vec = vecs[j];
    results[idx] = vec;
    const key = _cacheKey(missTexts[j]);
    _embedCache.set(key, vec);
    if (_embedCache.size > 500) _embedCache.delete(_embedCache.keys().next().value);
    try { const backend = require('./backend'); backend.kvSet('embed:' + key, JSON.stringify(vec), ''); } catch (e) {}
  }
  return results;
}

function authHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = 'Bearer ' + apiKey;
  return h;
}

// 统一 OpenAI 兼容 chat 助手（本地或云端；api_key 可选）。返回 null 表示失败（让上层走容错/启发式分支）
async function chatJSON({ url, model, apiKey, messages, temperature = 0.1, jsonMode = false }) {
  if (!url) return null;
  const body = { model, messages, temperature };
  if (jsonMode && apiKey) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), config.CONFIG.llm_timeout_ms || 90000);
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    return null;
  } finally { clearTimeout(to); }
  if (!r.ok) return null;
  const d = await r.json();
  const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  return c || null;
}

module.exports = { embed, embedBatch, authHeaders, chatJSON, cacheStats, warmupEmbedding };
