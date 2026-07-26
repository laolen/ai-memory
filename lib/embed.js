const config = require('./config');
const util = require('./util');
const { embedQueue } = require('./queue'); // v1.18.0 (#4): 可配置并发队列

// v1.17.0 (#101): 嵌入结果缓存——相同文本（按内容归一化哈希）不重复调用远端 embedding，降延迟省调用。
// 内存 Map 为主（进程生命周期，封顶 500 条），并惰性持久化到 kv（'embed:<hash>'）跨重启复用。
const _embedCache = new Map();
let _hits = 0, _miss = 0;
function _cacheKey(text) { return util.hashContent(text); }

// 远端真实嵌入（原 embed 主体，抽出为底层函数）
async function _embedRemote(text) {
  const C = config.CONFIG;
  if (!C.embedding_url) throw new Error('EMBEDDING_URL not configured');
  const isOpenAI = C.embedding_url.includes('/v1/embeddings');
  const body = isOpenAI
    ? { model: C.embedding_model, input: [text] }
    : { model: C.embedding_model, input: text };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), C.embedding_timeout_ms || 30000);
  let r;
  try {
    r = await fetch(C.embedding_url, {
      method: 'POST', headers: authHeaders(C.embedding_api_key || null),
      body: JSON.stringify(body), signal: ctrl.signal });
  } finally { clearTimeout(to); }
  if (!r.ok) throw new Error('embed http ' + r.status);
  const d = await r.json();
  return isOpenAI ? d.data[0].embedding : d.embeddings[0];
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

module.exports = { embed, authHeaders, chatJSON, cacheStats };
