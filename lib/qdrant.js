// Qdrant 存储适配层（v1.9.0）：替代 Elasticsearch 作为向量主存储。
// 实测 Qdrant 1.18.3：唯一可用的写是 PUT /collections/{c}/points（全量覆盖 payload+vector）；
// 无 PATCH / points/operations 部分更新端点（返回 404），故部分更新走 get→改→upsert。
// 读取用 query(向量检索) / scroll(过滤列举) / get(单条) / count。过滤条件 is_empty 表示字段缺失。
const config = require('./config');

function base() {
  const url = config.CONFIG.qdrant_url;
  if (!url) return null;
  try { return new URL(url).origin; } catch (e) { return String(url).replace(/\/+$/, ''); }
}
function coll() { return config.CONFIG.qdrant_collection || 'memories'; }
function useQdrant() { return !!config.CONFIG.qdrant_url; }

async function req(method, path, body) {
  const b = base();
  if (!b) throw new Error('qdrant_url 未配置');
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(b + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (r.status === 404) return null;
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!r.ok) {
      const msg = (json && (json.status || json.message || JSON.stringify(json))) || (text || r.statusText);
      const err = new Error('Qdrant ' + method + ' ' + path + ' -> ' + r.status + ' ' + msg);
      err.status = r.status;
      throw err;
    }
    return json;
  } finally { clearTimeout(to); }
}

// points: [{id, vector, payload}]
async function upsert(points) {
  return await req('PUT', `/collections/${coll()}/points`, { points });
}
async function get(id) {
  const j = await req('GET', `/collections/${coll()}/points/${encodeURIComponent(id)}?with_payload=true&with_vector=true`);
  if (!j || !j.result) return null;
  return { id: j.result.id, vector: j.result.vector, payload: j.result.payload || {} };
}
// vector: number[]; filter: Qdrant filter object
async function query({ vector, filter, limit = 5, withVector = false }) {
  const j = await req('POST', `/collections/${coll()}/points/query`, {
    query: vector, filter: filter || undefined, limit, with_payload: true, with_vector: withVector,
  });
  if (!j || !j.result) return [];
  return (j.result.points || []).map(p => ({ id: p.id, score: p.score != null ? p.score : 0, payload: p.payload || {} }));
}
async function scroll({ filter, limit = 100, withVector = false }) {
  const j = await req('POST', `/collections/${coll()}/points/scroll`, {
    filter: filter || undefined, limit, with_payload: true, with_vector: withVector,
  });
  if (!j || !j.result) return { points: [], nextOffset: null };
  return { points: j.result.points || [], nextOffset: j.result.next_page_offset || null };
}
// 全量 scroll（分页循环），用于实体词表刷新等
async function scrollAll(filter, limit = 256) {
  let offset = null, out = [];
  while (true) {
    const body = { filter: filter || undefined, limit, with_payload: true, with_vector: false };
    if (offset) body.offset = offset;
    const j = await req('POST', `/collections/${coll()}/points/scroll`, body);
    const pts = (j && j.result && j.result.points) || [];
    out = out.concat(pts);
    offset = j && j.result && j.result.next_page_offset;
    if (!offset || pts.length === 0) break;
  }
  return out;
}
async function count(filter) {
  const j = await req('POST', `/collections/${coll()}/points/count`, { filter: filter || undefined, exact: false });
  return (j && j.result && typeof j.result.count === 'number') ? j.result.count : 0;
}
async function deleteIds(ids) {
  return await req('POST', `/collections/${coll()}/points/delete`, { points: ids });
}
async function deleteByFilter(filter) {
  return await req('POST', `/collections/${coll()}/points/delete`, { filter });
}
// 部分更新：get→merge→upsert（Qdrant 无 partial PATCH 端点）
async function setPayload(id, fields) {
  const cur = await get(id);
  if (!cur) return null;
  const payload = Object.assign({}, cur.payload, fields);
  await upsert([{ id, vector: cur.vector, payload }]);
  return { id, vector: cur.vector, payload };
}
// 访问强化：access_count+1, last_accessed_at=now
async function incrAccess(id, now) {
  const cur = await get(id);
  if (!cur) return;
  const payload = Object.assign({}, cur.payload);
  payload.access_count = (payload.access_count != null ? Number(payload.access_count) : 0) + 1;
  payload.last_accessed_at = now;
  await upsert([{ id, vector: cur.vector, payload }]);
}
// 注意：Qdrant 的 /healthz 返回纯文本（"healthz check passed"）而非 JSON，
// 故健康检查改探 /collections/{coll}（JSON，且能顺带确认目标集合已存在；不存在返回 404）。
async function health() {
  try { const j = await req('GET', '/collections/' + coll()); return !!(j && j.result); } catch (e) { return false; }
}

module.exports = {
  useQdrant, upsert, get, query, scroll, scrollAll, count, deleteIds, deleteByFilter, setPayload, incrAccess, health,
};
