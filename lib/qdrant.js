// Qdrant 存储适配层（v1.9.0）：向量主存储。
// 实测 Qdrant 1.18.3：唯一可用的写是 PUT /collections/{c}/points（全量覆盖 payload+vector）；
// 无 PATCH / points/operations 部分更新端点（返回 404），故部分更新走 get→改→upsert。
// 读取用 query(向量检索) / scroll(过滤列举) / get(单条) / count。过滤条件 is_empty 表示字段缺失。
const config = require('./config');
const errC = config.errStats;

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
    try { json = text ? JSON.parse(text) : null; } catch (e) { errC.other++; }
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
// wait=true：保证写入并（HNSW）入图后才返回，使紧接其后的 dedupFind 即时查询能命中刚写入的点，
// 避免「同一内容连续两次 capture 因索引异步而漏判、产生重复记忆」（qdrant_regression 第4项）。
async function upsert(points) {
  return await req('PUT', `/collections/${coll()}/points?wait=true`, { points });
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
async function scroll({ filter, limit = 100, withVector = false, offset = null }) {
  const body = { filter: filter || undefined, limit, with_payload: true, with_vector: withVector };
  if (offset) body.offset = offset;
  const j = await req('POST', `/collections/${coll()}/points/scroll`, body);
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
// 获取集合向量维度（缓存）。用于「嵌入失败但需写入 Qdrant」时用零向量占位，
// 避免读写分叉（详见 memory.js doAdd）。同时兼容单向量与命名向量配置。
let _vecSize = null;
async function vectorSize() {
  if (_vecSize) return _vecSize;
  const j = await req('GET', '/collections/' + coll());
  const v = j && j.result && j.result.config && j.result.config.params && j.result.config.params.vectors;
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.size === 'number') _vecSize = v.size;
  else if (Array.isArray(v) && v[0] && typeof v[0].size === 'number') _vecSize = v[0].size;
  return _vecSize;
}
async function deleteIds(ids) {
  return await req('POST', `/collections/${coll()}/points/delete`, { points: ids });
}
async function deleteByFilter(filter) {
  return await req('POST', `/collections/${coll()}/points/delete`, { filter });
}
// 部分更新：单条 get→merge→upsert，或批量 {id,fields}[]（v1.13.0 backfill 用）
async function setPayload(id, fields) {
  if (Array.isArray(id)) {
    // 批量：id = [{id, content_hash}, ...]
    const pts = await Promise.all(id.map(async item => {
      const cur = await get(item.id);
      if (!cur) return null;
      const payload = Object.assign({}, cur.payload, item.fields || { content_hash: item.content_hash });
      return { id: item.id, vector: cur.vector, payload };
    }));
    const valid = pts.filter(Boolean);
    if (valid.length) await upsert(valid);
    return valid.length;
  }
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
  // v1.15.0: 间隔重复——每次访问翻倍间隔（SM-2 风格）
  const count = payload.access_count || 0;
  const intervalHours = Math.min(720, Math.max(4, Math.pow(2, count) * 2)); // 2h → 4h → 8h → 16h → 32h → max 30d
  payload.next_review_at = new Date(Date.now() + intervalHours * 3600000).toISOString();
  await upsert([{ id, vector: cur.vector, payload }]);
}
// 注意：Qdrant 的 /healthz 返回纯文本（"healthz check passed"）而非 JSON，
// 故健康检查改探 /collections/{coll}（JSON，且能顺带确认目标集合已存在；不存在返回 404）。
async function health() {
  try { const j = await req('GET', '/collections/' + coll()); return !!(j && j.result); } catch (e) { return false; }
}

// v1.20.0 (#4c): 为高频过滤字段创建 payload 索引，加速 Qdrant 过滤查询。
// 幂等——已存在的索引会返回 409/400，静默忽略。启动时调用一次。
async function ensureIndexes() {
  const fields = [
    { name: 'user', schema: 'keyword' },
    { name: 'project', schema: 'keyword' },
    { name: 'session', schema: 'keyword' },
    { name: 'tags', schema: 'keyword' },
    { name: 'type', schema: 'keyword' },
    { name: 'memory_type', schema: 'keyword' },
    { name: 'mem_category', schema: 'keyword' },
    { name: 'content_hash', schema: 'keyword' },
    { name: 'pinned', schema: 'bool' },
    { name: 'expires_at', schema: 'datetime' },
    { name: 'updated_at', schema: 'datetime' },
    { name: 'next_review_at', schema: 'datetime' },
  ];
  let created = 0;
  for (const f of fields) {
    try {
      await req('PUT', '/collections/' + coll() + '/index', { field_name: f.name, schema: f.schema });
      created++;
    } catch (e) { /* 已存在或 Qdrant 版本不支持，静默 */ }
  }
  return { created, total: fields.length };
}

module.exports = {
  useQdrant, upsert, get, query, scroll, scrollAll, count, vectorSize, deleteIds, deleteByFilter, setPayload, incrAccess, health, ensureIndexes,
};
