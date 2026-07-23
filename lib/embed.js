const config = require('./config');

function authHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = 'Bearer ' + apiKey;
  return h;
}

async function embed(text) {
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
  if (isOpenAI) return d.data[0].embedding;
  return d.embeddings[0];
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

module.exports = { embed, authHeaders, chatJSON };
