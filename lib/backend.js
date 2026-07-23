// 后端存储层：SQLite 降级存储 + ES 底层读取 + 过滤器/去重/访问强化/实体词表。
// 该模块不依赖 intelligence（避免循环），实体词表(refreshEntityVocab)在此维护，intelligence 通过 queryEntities 读取。
const config = require('./config');
const util = require('./util');

let Database = null;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }
let db = null;
function sqliteInit() {
  if (db) return db;
  if (!Database) throw new Error('better-sqlite3 未安装，无法启用本地文件数据库降级。');
  db = new Database(config.ROOT ? require('path').join(config.ROOT, 'memories.db') : 'memories.db');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT, user TEXT, project TEXT, session TEXT, tags TEXT, embedding TEXT, created_at TEXT)');
  const _cols = new Set(db.pragma('table_info(memories)').map(c => c.name));
  if (!_cols.has('updated_at')) db.exec('ALTER TABLE memories ADD COLUMN updated_at TEXT');
  if (!_cols.has('history')) db.exec('ALTER TABLE memories ADD COLUMN history TEXT');
  if (!_cols.has('entities')) db.exec('ALTER TABLE memories ADD COLUMN entities TEXT');
  if (!_cols.has('relations')) db.exec('ALTER TABLE memories ADD COLUMN relations TEXT');
  if (!_cols.has('source')) db.exec('ALTER TABLE memories ADD COLUMN source TEXT');
  if (!_cols.has('entity_names')) db.exec('ALTER TABLE memories ADD COLUMN entity_names TEXT');
  if (!_cols.has('type')) db.exec('ALTER TABLE memories ADD COLUMN type TEXT');
  if (!_cols.has('confidence')) db.exec('ALTER TABLE memories ADD COLUMN confidence REAL');
  if (!_cols.has('access_count')) db.exec('ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0');
  if (!_cols.has('last_accessed_at')) db.exec('ALTER TABLE memories ADD COLUMN last_accessed_at TEXT');
  if (!_cols.has('expires_at')) db.exec('ALTER TABLE memories ADD COLUMN expires_at TEXT');
  if (!_cols.has('category')) db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
  if (!_cols.has('memory_type')) db.exec('ALTER TABLE memories ADD COLUMN memory_type TEXT');
  // v1.8.0: 用户纠正学习（B1）字段
  if (!_cols.has('correction_count')) db.exec('ALTER TABLE memories ADD COLUMN correction_count INTEGER DEFAULT 0');
  if (!_cols.has('corrected_at')) db.exec('ALTER TABLE memories ADD COLUMN corrected_at TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS project_links (from_project TEXT, to_project TEXT, strength REAL, note TEXT, created_at TEXT, PRIMARY KEY(from_project, to_project))');
  return db;
}
function rowToDoc(r) {
  return { id: r.id, content: r.content, user: r.user, project: r.project,
    session: r.session, tags: r.tags ? JSON.parse(r.tags) : [], created_at: r.created_at,
    updated_at: r.updated_at || r.created_at, history: r.history ? JSON.parse(r.history) : [],
    entities: r.entities ? JSON.parse(r.entities) : [], relations: r.relations ? JSON.parse(r.relations) : [],
    source: r.source ? JSON.parse(r.source) : null, entity_names: r.entity_names ? JSON.parse(r.entity_names) : [],
    type: r.type || null, category: r.category || 'semantic', confidence: (r.confidence !== undefined && r.confidence !== null) ? Number(r.confidence) : null,
    access_count: (r.access_count !== undefined && r.access_count !== null) ? Number(r.access_count) : 0,
    last_accessed_at: r.last_accessed_at || null, expires_at: r.expires_at || null,
    memory_type: r.memory_type || 'user',
    correction_count: (r.correction_count !== undefined && r.correction_count !== null) ? Number(r.correction_count) : 0,
    corrected_at: r.corrected_at || null };
}
function sqliteAdd(doc) {
  const d = sqliteInit();
  d.prepare('INSERT INTO memories (id,content,user,project,session,tags,embedding,created_at,updated_at,history,entities,relations,source,entity_names,type,category,confidence,access_count,last_accessed_at,expires_at,memory_type,correction_count,corrected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(doc.id, doc.content, doc.user, doc.project, doc.session,
      JSON.stringify(doc.tags || []), doc.embedding ? JSON.stringify(doc.embedding) : null,
      doc.created_at, doc.updated_at || doc.created_at, JSON.stringify(doc.history || []),
      JSON.stringify(doc.entities || []), JSON.stringify(doc.relations || []),
      doc.source ? JSON.stringify(doc.source) : null, JSON.stringify(doc.entity_names || []),
      doc.type || null, doc.category || 'semantic', (doc.confidence !== undefined && doc.confidence !== null) ? Number(doc.confidence) : null,
      doc.access_count || 0, doc.last_accessed_at || null, doc.expires_at || null, doc.memory_type || 'user',
      doc.correction_count || 0, doc.corrected_at || null);
}
function sqliteGet(id) {
  const r = sqliteInit().prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!r) { const e = new Error('not found'); e.statusCode = 404; throw e; }
  return rowToDoc(r);
}
function sqliteDelete(id) { sqliteInit().prepare('DELETE FROM memories WHERE id=?').run(id); }
function sqliteUpdate(id, patch) {
  const now = new Date().toISOString();
  const prev = sqliteGet(id);
  const sets = [], params = [];
  if (patch.content !== undefined) { sets.push('content=?'); params.push(patch.content); }
  if (patch.project !== undefined) { sets.push('project=?'); params.push(patch.project || null); }
  if (patch.session !== undefined) { sets.push('session=?'); params.push(patch.session || null); }
  if (patch.tags !== undefined) { sets.push('tags=?'); params.push(JSON.stringify(patch.tags || [])); }
  if (patch.updated_at !== undefined) { sets.push('updated_at=?'); params.push(patch.updated_at); }
  else { sets.push('updated_at=?'); params.push(now); }
  if (config.CONFIG.embedding_url && patch.content !== undefined) {
    try { const v = require('./embed').embed(patch.content); sets.push('embedding=?'); params.push(JSON.stringify(v)); } catch (e) {}
  }
  if (patch.type !== undefined) { sets.push('type=?'); params.push(patch.type || null); }
  if (patch.category !== undefined) { sets.push('category=?'); params.push(patch.category || 'semantic'); }
  if (patch.confidence !== undefined) { sets.push('confidence=?'); params.push(patch.confidence); }
  if (patch.memory_type !== undefined) { sets.push('memory_type=?'); params.push(patch.memory_type); }
  if (patch.access_count !== undefined) { sets.push('access_count=?'); params.push(patch.access_count); }
  if (patch.last_accessed_at !== undefined) { sets.push('last_accessed_at=?'); params.push(patch.last_accessed_at); }
  if (patch.expires_at !== undefined) { sets.push('expires_at=?'); params.push(patch.expires_at || null); }
  if (patch.source !== undefined) { sets.push('source=?'); params.push(patch.source ? JSON.stringify(patch.source) : null); }
  if (patch.correction_count !== undefined) { sets.push('correction_count=?'); params.push(patch.correction_count); }
  if (patch.corrected_at !== undefined) { sets.push('corrected_at=?'); params.push(patch.corrected_at || null); }
  const history = (prev.history || []).slice();
  if (patch.content !== undefined && patch.content !== prev.content) {
    history.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
  }
  sets.push('history=?'); params.push(JSON.stringify(history.slice(-10)));
  params.push(id);
  const d = sqliteInit();
  d.prepare('UPDATE memories SET ' + sets.join(', ') + ' WHERE id=?').run(...params);
  return sqliteGet(id);
}
function hitsToRows(res) {
  return res.hits.hits.map(h => ({
    id: h._id, score: h._score, content: h._source.content, user: h._source.user,
    project: h._source.project, session: h._source.session, tags: h._source.tags || [], created_at: h._source.created_at,
    updated_at: h._source.updated_at, history: h._source.history || [],
    entities: h._source.entities || [], relations: h._source.relations || [],
    source: h._source.source || null, entity_names: h._source.entity_names || [],
    type: h._source.type || null,
    category: h._source.category || 'semantic',
    confidence: (h._source.confidence !== undefined && h._source.confidence !== null) ? Number(h._source.confidence) : null,
    access_count: (h._source.access_count !== undefined && h._source.access_count !== null) ? Number(h._source.access_count) : 0,
    last_accessed_at: h._source.last_accessed_at || null,
    memory_type: h._source.memory_type || 'user',
    expires_at: h._source.expires_at || null,
    correction_count: (h._source.correction_count !== undefined && h._source.correction_count !== null) ? Number(h._source.correction_count) : 0,
    corrected_at: h._source.corrected_at || null }));
}
function normDate(s, isEnd) {
  if (!s) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + (isEnd ? 'T23:59:59.999Z' : 'T00:00:00.000Z');
  return s;
}
function timeFilter(a) {
  const f = [];
  if (a.from) f.push({ range: { updated_at: { gte: normDate(a.from, false) } } });
  if (a.to) f.push({ range: { updated_at: { lte: normDate(a.to, true) } } });
  return f;
}
function filters(p) {
  const f = [];
  if (p.user) f.push({ term: { user: p.user } });
  if (p.project) f.push({ term: { project: p.project } });
  if (p.session) f.push({ term: { session: p.session } });
  // type 字段：索引可能是显式 keyword 映射，或动态映射为 text(带 .keyword 子字段)。
  // 用 bool.should 同时兼容两种情形；必须 minimum_should_match:1 否则在 filter 上下文里 should 默认 0 匹配即视为通过，过滤失效。
  if (p.type) f.push({ bool: { should: [ { term: { type: p.type } }, { term: { 'type.keyword': p.type } } ], minimum_should_match: 1 } });
  if (p.category) f.push({ bool: { should: [ { term: { category: p.category } }, { term: { 'category.keyword': p.category } } ], minimum_should_match: 1 } });
  if (p.memory_type) f.push({ bool: { should: [ { term: { memory_type: p.memory_type } }, { term: { 'memory_type.keyword': p.memory_type } } ], minimum_should_match: 1 } });
  if (p.min_confidence !== undefined && p.min_confidence !== null) f.push({ range: { confidence: { gte: Number(p.min_confidence) } } });
  // 过期记忆不参与检索/去重召回（无 expires_at 或尚未过期才返回）；minimum_should_match:1 否则 should 在 filter 上下文恒通过
  f.push({ bool: { should: [ { bool: { must_not: { exists: { field: 'expires_at' } } } }, { range: { expires_at: { gt: new Date().toISOString() } } } ], minimum_should_match: 1 } });
  return f;
}
// ---- dedup: find most similar existing memory (cosine similarity) ----
async function dedupFind(vec, scope) {
  scope = scope || {};
  const client = config.client;
  if (config.CONFIG.es_url && client) {
    try {
      const filter = filters(scope);
      const body = { query: { bool: { filter } }, knn: { field: 'embedding', query_vector: vec, k: 1, num_candidates: 50 }, size: 1,
        _source: ['content', 'user', 'project', 'session', 'tags', 'embedding', 'created_at', 'updated_at', 'history'] };
      const res = await client.search({ index: config.CONFIG.es_index, body });
      const hits = res.hits.hits;
      if (hits.length && hits[0]._source && hits[0]._source.embedding) {
        const sim = util.cosine(vec, hits[0]._source.embedding);
        return { id: hits[0]._id, similarity: sim, source: hits[0]._source };
      }
    } catch (e) {}
    return null;
  }
  // SQLite path: full scan, compare by cosine
  try {
    const d = sqliteInit();
    const where = [], params = [];
    if (scope.user) { where.push('user=?'); params.push(scope.user); }
    if (scope.project) { where.push('project=?'); params.push(scope.project); }
    if (scope.session) { where.push('session=?'); params.push(scope.session); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const all = d.prepare('SELECT * FROM memories' + clause).all(...params);
    let best = null;
    for (const r of all) {
      if (!r.embedding) continue;
      const sim = util.cosine(vec, JSON.parse(r.embedding));
      if (!best || sim > best.similarity) best = { id: r.id, similarity: sim, source: rowToDoc(r) };
    }
    return best;
  } catch (e) { return null; }
}

// v1.6.0: 强化回环——每次搜索返回的记忆，其 access_count+1、last_accessed_at=now（fire-and-forget，不阻塞响应）
async function bumpAccess(ids) {
  if (!ids || !ids.length) return;
  const now = new Date().toISOString();
  const client = config.client;
  try {
    if (config.CONFIG.es_url && client) {
      await Promise.all(ids.map(id => client.update({
        index: config.CONFIG.es_index, id,
        script: { source: 'ctx._source.access_count = (ctx._source.access_count ?: 0) + 1; ctx._source.last_accessed_at = params.t', lang: 'painless', params: { t: now } },
        retry_on_conflict: 2
      }).catch(() => {})));
    } else {
      const d = sqliteInit();
      const ph = ids.map(() => '?').join(',');
      d.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (' + ph + ')').run(now, ...ids);
    }
  } catch (e) {}
}

// ---- 实体词汇表（canonical 名集合），启动/写入后刷新，用于查询时实体匹配加权 ----
let _entityVocab = null;
async function refreshEntityVocab() {
  try {
    const names = new Set();
    const client = config.client;
    if (config.CONFIG.es_url && client) {
      const res = await client.search({ index: config.CONFIG.es_index, body: { query: { match_all: {} }, size: 10000, _source: ['entity_names'] } });
      for (const h of (res.hits && res.hits.hits) || []) { for (const e of (h._source && h._source.entity_names) || []) names.add(String(e)); }
    } else {
      const all = sqliteInit().prepare('SELECT entity_names FROM memories').all();
      for (const r of all) { try { const arr = JSON.parse(r.entity_names || '[]'); for (const e of arr) names.add(String(e)); } catch (e2) {} }
    }
    _entityVocab = names;
  } catch (e) { _entityVocab = _entityVocab || new Set(); }
  return _entityVocab;
}
function getEntityVocab() { return _entityVocab || new Set(); }
function queryEntities(q) {
  const s = (q || '').toLowerCase(); if (!s) return [];
  const v = getEntityVocab(); const out = new Set();
  for (const e of v) { if (e && s.includes(String(e).toLowerCase())) out.add(String(e).toLowerCase()); }
  return [...out];
}

module.exports = {
  sqliteInit, rowToDoc, sqliteAdd, sqliteGet, sqliteDelete, sqliteUpdate, hitsToRows,
  filters, timeFilter, normDate, dedupFind, bumpAccess, refreshEntityVocab, getEntityVocab, queryEntities,
};
