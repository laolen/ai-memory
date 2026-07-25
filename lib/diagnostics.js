// 后端自测层：embedding / chat(llm) / kg / database 四个后端的连通性验证（admin 界面「测试连接」按钮调用）。
const config = require('./config');
const embed = require('./embed');

async function testEmbedding(b = {}) {
  const url = (b.embedding_url !== undefined) ? b.embedding_url : config.CONFIG.embedding_url;
  const key = (b.embedding_api_key !== undefined) ? b.embedding_api_key : config.CONFIG.embedding_api_key;
  const model = (b.embedding_model) ? b.embedding_model : config.CONFIG.embedding_model;
  if (!url) return { ok: false, message: '未配置 Embedding 接口 URL' };
  try {
    const isOpenAI = url.includes('/v1/embeddings');
    const body = isOpenAI ? { model, input: ['test connectivity'] } : { model, input: 'test connectivity' };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), config.CONFIG.embedding_timeout_ms || 30000);
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: embed.authHeaders(key || null), body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(to); }
    if (!r.ok) { let t = ''; try { t = await r.text(); } catch {} return { ok: false, message: `HTTP ${r.status} ${r.statusText}`, detail: t.slice(0, 200) }; }
    const d = await r.json();
    const vec = isOpenAI ? (d.data && d.data[0] && d.data[0].embedding) : (d.embeddings && d.embeddings[0]);
    if (!Array.isArray(vec) || vec.length === 0) return { ok: false, message: '返回体缺少向量（data[0].embedding 或 embeddings[0]）', detail: JSON.stringify(d).slice(0, 200) };
    return { ok: true, message: `✅ 连通，向量维度 ${vec.length}`, detail: `model=${model}` };
  } catch (e) { return { ok: false, message: '请求失败：' + e.message }; }
}

async function testChat(b = {}, jsonMode = false) {
  const url = (b.llm_url !== undefined) ? b.llm_url : config.CONFIG.llm_url;
  const key = (b.llm_api_key !== undefined) ? b.llm_api_key : config.CONFIG.llm_api_key;
  const model = (b.llm_model) ? b.llm_model : config.CONFIG.llm_model;
  if (!url) return { ok: false, message: '未配置 LLM 端点' };
  const messages = jsonMode
    ? [{ role: 'system', content: '只返回严格 JSON，不要其他任何文字。' }, { role: 'user', content: '返回 JSON：{"ok":true}' }]
    : [{ role: 'user', content: '请只回复一个字：好' }];
  try {
    const content = await embed.chatJSON({ url, model, apiKey: key || null, messages, temperature: 0.1, jsonMode });
    if (content == null) return { ok: false, message: '无返回（HTTP 非 2xx 或解析失败）' };
    return { ok: true, message: '✅ 模型有响应', detail: String(content).slice(0, 140) };
  } catch (e) { return { ok: false, message: '请求失败：' + e.message }; }
}

async function testKG(b = {}) {
  const url = (b.kg_url) ? b.kg_url : (b.llm_url) ? b.llm_url : (config.CONFIG.kg_url || (config.CONFIG.llm_enabled ? config.CONFIG.llm_url : null));
  const key = (b.kg_api_key) ? b.kg_api_key : (b.llm_api_key) ? b.llm_api_key : (config.CONFIG.kg_api_key || config.CONFIG.llm_api_key || null);
  const model = (b.kg_model) ? b.kg_model : (b.llm_model) ? b.llm_model : (config.CONFIG.kg_model || config.CONFIG.llm_model);
  if (!url) return { ok: false, message: '未配置图谱端点（kg_url 或 llm_url）' };
  const messages = [
    { role: 'system', content: '你是知识图谱抽取器。只返回严格 JSON，不要 Markdown 代码块，不要其他文字。' },
    { role: 'user', content: '从这句话抽取实体与关系，返回 JSON：{"entities":[{"type":"person","name":"小李"}],"relations":[{"from":"小李","to":"Aurora","type":"responsible_for"}]}。句子：小李负责 Aurora 项目。' }
  ];
  try {
    const content = await embed.chatJSON({ url, model, apiKey: key || null, messages, temperature: 0.1, jsonMode: true });
    if (content == null) return { ok: false, message: '无返回（HTTP 非 2xx 或解析失败）' };
    let parsed = null, perr = '';
    try { parsed = JSON.parse(content); } catch (e) { perr = e.message; }
    if (!parsed) return { ok: true, message: '⚠️ 模型有响应，但返回非严格 JSON（本地模型建议换更强模型，如 qwen3.5:9b）', detail: String(content).slice(0, 160) + (perr ? ' | parse: ' + perr : '') };
    const ents = Array.isArray(parsed.entities) ? parsed.entities.length : 0;
    const rels = Array.isArray(parsed.relations) ? parsed.relations.length : 0;
    return { ok: true, message: `✅ 图谱抽取返回合法 JSON（实体 ${ents} / 关系 ${rels}）`, detail: `model=${model}` };
  } catch (e) { return { ok: false, message: '请求失败：' + e.message }; }
}

async function testDatabase(b = {}) {
  const qUrl = (b.qdrant_url !== undefined && b.qdrant_url !== '') ? b.qdrant_url : config.CONFIG.qdrant_url;
  if (qUrl) {
    const coll = (b.qdrant_collection) ? b.qdrant_collection : (config.CONFIG.qdrant_collection || 'memories');
    try {
      const base = String(qUrl).replace(/\/+$/, '');
      const r = await fetch(base + '/healthz');
      const ok = r.ok;
      let docs = 0;
      try { const c = await fetch(base + `/collections/${encodeURIComponent(coll)}/points/count`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const cj = await c.json(); docs = (cj.result && typeof cj.result.count === 'number') ? cj.result.count : 0; } catch (e) {}
      return { ok, message: ok ? `✅ Qdrant 已连接，集合 ${coll} 文档数 ${docs}` : 'Qdrant 健康检查失败', detail: `node=${base}` };
    } catch (e) { return { ok: false, message: '连接失败：' + e.message }; }
  }
  return { ok: false, message: '未配置 Qdrant 地址（当前为本地 SQLite 降级模式，记忆存于 memories.db）' };
}

// 一次性跑全部后端自测（启动自检与 /api/diagnose 复用）
async function testAll(b = {}) {
  const tasks = {
    database: testDatabase(b),
    embedding: testEmbedding(b),
    llm: testChat(b),
    kg: testKG(b),
  };
  const out = {};
  await Promise.all(Object.keys(tasks).map(async (k) => {
    try { out[k] = await tasks[k]; } catch (e) { out[k] = { ok: false, message: '异常: ' + (e && e.message || e) }; }
  }));
  return out;
}

module.exports = { testEmbedding, testChat, testKG, testDatabase, testAll };
