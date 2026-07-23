// 后端存储层：SQLite 降级存储 + ES 底层读取 + 过滤器/去重/访问强化/实体词表。
// 该模块不依赖 intelligence（避免循环），实体词表(refreshEntityVocab)在此维护，intelligence 通过 queryEntities 读取。
const config = require('./config');
const util = require('./util');
const qdrant = require('./qdrant');

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
  // v1.9.1: 审计历史层（独立账本，不被 Qdrant upsert 覆盖）
  db.exec('CREATE TABLE IF NOT EXISTS memory_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT, op TEXT, ts TEXT, user TEXT, project TEXT, before TEXT, after TEXT, source_trigger TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_changelog_mid ON memory_changelog(memory_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_changelog_ts ON memory_changelog(ts)');
  if (!_cols.has('version')) db.exec('ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 1');
  // v1.11.0: 记忆分层 + 版本化抽取模型字段
  if (!_cols.has('mem_category')) db.exec('ALTER TABLE memories ADD COLUMN mem_category TEXT');
  if (!_cols.has('tier')) db.exec("ALTER TABLE memories ADD COLUMN tier TEXT DEFAULT 'long'");
  if (!_cols.has('org')) db.exec('ALTER TABLE memories ADD COLUMN org TEXT');
  if (!_cols.has('extract_version')) db.exec("ALTER TABLE memories ADD COLUMN extract_version TEXT DEFAULT 'v1'");
  // v1.10.0: FTS5 全文索引镜像表（独立于主存储，永远随每次写操作同步；零新依赖）。
  // id 为 UNINDEXED 主键；content/tags 参与全文检索；project/user/session 为可过滤的 UNINDEXED 列。
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content, tags, project UNINDEXED, user UNINDEXED, session UNINDEXED)");
  // v1.10.0: 持久化知识图谱（聚合跨记忆的实体/关系，供图谱查询与可视化；独立于 Qdrant payload）
  db.exec('CREATE TABLE IF NOT EXISTS kg_entities (canonical TEXT PRIMARY KEY, name TEXT, type TEXT, project TEXT, first_seen TEXT, last_seen TEXT, memory_count INTEGER DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS kg_relations (rel_id TEXT PRIMARY KEY, src TEXT, dst TEXT, type TEXT, project TEXT, first_seen TEXT, last_seen TEXT, strength REAL DEFAULT 1)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_kg_entities_proj ON kg_entities(project)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_kg_relations_src ON kg_relations(src)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_kg_relations_dst ON kg_relations(dst)');
  // v1.11.0: 短时工作记忆缓冲（独立于长期库，不污染 Qdrant/FTS/KG/审计；可 promote 到长期）
  db.exec('CREATE TABLE IF NOT EXISTS working_memories (id TEXT PRIMARY KEY, content TEXT, user TEXT, project TEXT, session TEXT, org TEXT, tags TEXT, created_at TEXT, expires_at TEXT, memory_type TEXT, meta TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_working_proj ON working_memories(project)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_working_exp ON working_memories(expires_at)');
  // v1.11.0: KV 精确匹配通道（flag/配置/短字段的确定性精确查，与语义检索解耦）
  db.exec('CREATE TABLE IF NOT EXISTS kv_store (k TEXT, org TEXT DEFAULT "", v TEXT, updated_at TEXT, PRIMARY KEY(k, org))');
  return db;
}

// v1.10.0: FTS5 全文索引——本地文本镜像（即使 Qdrant 作主存储，也在此维护可 BM25 检索的副本）
function ftsUpsert(id, content, tags, project, user, session) {
  try {
    const d = sqliteInit();
    d.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
    d.prepare('INSERT INTO memory_fts (id, content, tags, project, user, session) VALUES (?,?,?,?,?,?)')
      .run(id, content || '', (tags || []).join(' '), project || '', user || '', session || '');
  } catch (e) {}
}
function ftsDelete(id) {
  try { sqliteInit().prepare('DELETE FROM memory_fts WHERE id=?').run(id); } catch (e) {}
}
// 返回 [{id, score}]，score 越高越相关（bm25 越负越好，这里取反）。project 可进一步过滤。
function ftsSearch(query, limit, project) {
  try {
    const terms = (query || '').trim().split(/\s+/).filter(Boolean).map(t => t.replace(/["*]/g, '')).filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map(t => '"' + t + '"*').join(' ');
    const params = [match];
    let sql = 'SELECT id, bm25(memory_fts) AS r FROM memory_fts WHERE memory_fts MATCH ?';
    if (project) { sql += ' AND project = ?'; params.push(project); }
    sql += ' ORDER BY r LIMIT ?';
    params.push(limit || 20);
    return sqliteInit().prepare(sql).all(...params).map(r => ({ id: r.id, score: -r.r }));
  } catch (e) { return []; }
}
async function ftsReindexAll() {
  let items = [];
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    const pts = await qdrant.scrollAll({});
    for (const p of pts) {
      const pl = p.payload || {};
      items.push({ id: p.id, content: pl.content || '', tags: pl.tags || [], project: pl.project || null, user: pl.user || null, session: pl.session || null });
    }
  } else {
    const all = sqliteInit().prepare('SELECT * FROM memories').all();
    for (const r of all) items.push({ id: r.id, content: r.content || '', tags: JSON.parse(r.tags || '[]'), project: r.project, user: r.user, session: r.session });
  }
  const d = sqliteInit();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM memory_fts').run();
    const ins = d.prepare('INSERT INTO memory_fts (id, content, tags, project, user, session) VALUES (?,?,?,?,?,?)');
    for (const it of items) ins.run(it.id, it.content || '', (it.tags || []).join(' '), it.project || '', it.user || '', it.session || '');
  });
  tx();
  return items.length;
}

// v1.10.0: 持久化图谱——聚合跨记忆的实体/关系（canonical 由调用方传入，避免与 graph.js 循环依赖）
function kgUpsert(memId, entities, relations, project) {
  try {
    const d = sqliteInit();
    const now = new Date().toISOString();
    const eIns = d.prepare('INSERT INTO kg_entities (canonical, name, type, project, first_seen, last_seen, memory_count) VALUES (?,?,?,?,?,?,1) ON CONFLICT(canonical) DO UPDATE SET last_seen=excluded.last_seen, memory_count=memory_count+1');
    const rIns = d.prepare('INSERT INTO kg_relations (rel_id, src, dst, type, project, first_seen, last_seen, strength) VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(rel_id) DO UPDATE SET last_seen=excluded.last_seen, strength=strength+1');
    const entMap = {};
    for (const e of (entities || [])) {
      if (!e || !e.canonical) continue;
      const c = String(e.canonical);
      if (entMap[c]) continue;
      entMap[c] = e;
      eIns.run(c, e.name || e.canonical, e.type || 'other', project || null, now, now);
    }
    for (const r of (relations || [])) {
      if (!r || !r.from || !r.to || r.from === r.to) continue;
      const relId = r.from + '|' + r.to + '|' + (r.type || 'related') + '|' + (project || '');
      rIns.run(relId, r.from, r.to, r.type || 'related', project || null, now, now);
    }
  } catch (e) {}
}
async function kgReindexAll() {
  let items = [];
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    const pts = await qdrant.scrollAll({});
    for (const p of pts) {
      const pl = p.payload || {};
      items.push({ entities: pl.entities || [], relations: pl.relations || [], project: pl.project || null });
    }
  } else {
    const all = sqliteInit().prepare('SELECT * FROM memories').all();
    for (const r of all) items.push({ entities: JSON.parse(r.entities || '[]'), relations: JSON.parse(r.relations || '[]'), project: r.project || null });
  }
  const d = sqliteInit();
  const entAgg = new Map(); const relAgg = new Map();
  for (const it of items) {
    const seen = new Set();
    for (const e of (it.entities || [])) { if (!e || !e.canonical) continue; const c = String(e.canonical); if (seen.has(c)) continue; seen.add(c); const k = c; const cur = entAgg.get(k) || { canonical: c, name: e.name || c, type: e.type || 'other', project: it.project || null, count: 0 }; cur.count++; cur.project = it.project || cur.project; entAgg.set(k, cur); }
    for (const r of (it.relations || [])) { if (!r || !r.from || !r.to || r.from === r.to) continue; const k = r.from + '|' + r.to + '|' + (r.type || 'related') + '|' + (it.project || ''); const cur = relAgg.get(k) || { rel_id: k, src: r.from, dst: r.to, type: r.type || 'related', project: it.project || null, strength: 0 }; cur.strength++; relAgg.set(k, cur); }
  }
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM kg_entities').run();
    d.prepare('DELETE FROM kg_relations').run();
    const ei = d.prepare('INSERT INTO kg_entities (canonical, name, type, project, first_seen, last_seen, memory_count) VALUES (?,?,?,?,?,?,?)');
    const ri = d.prepare('INSERT INTO kg_relations (rel_id, src, dst, type, project, first_seen, last_seen, strength) VALUES (?,?,?,?,?,?,?,?)');
    for (const e of entAgg.values()) ei.run(e.canonical, e.name, e.type, e.project, now, now, e.count);
    for (const r of relAgg.values()) ri.run(r.rel_id, r.src, r.dst, r.type, r.project, now, now, r.strength);
  });
  tx();
  return { entities: entAgg.size, relations: relAgg.size };
}
function kgExport(project, limit) {
  try {
    const d = sqliteInit();
    const lim = limit || 200;
    let eSql = 'SELECT canonical, name, type, project, memory_count FROM kg_entities';
    let rSql = 'SELECT src, dst, type, project, strength FROM kg_relations';
    const ep = [], rp = [];
    if (project) { eSql += ' WHERE project=?'; rSql += ' WHERE project=?'; ep.push(project); rp.push(project); }
    eSql += ' ORDER BY memory_count DESC LIMIT ?'; ep.push(lim);
    rSql += ' LIMIT ?'; rp.push(lim);
    const entities = d.prepare(eSql).all(...ep).map(r => ({ canonical: r.canonical, name: r.name, type: r.type, project: r.project, memory_count: r.memory_count }));
    const relations = d.prepare(rSql).all(...rp).map(r => ({ source: r.src, target: r.dst, type: r.type, project: r.project, strength: r.strength }));
    return { count: entities.length, entities, relations };
  } catch (e) { return { count: 0, entities: [], relations: [] }; }
}
function kgNeighbors(entity, limit) {
  try {
    const d = sqliteInit();
    const c = String(entity || '').toLowerCase();
    const rows = d.prepare('SELECT src, dst, type, strength FROM kg_relations WHERE lower(src)=? OR lower(dst)=?').all(c, c);
    const neigh = new Map();
    for (const r of rows) {
      const other = (r.src.toLowerCase() === c) ? r.dst : r.src;
      const key = other + '|' + r.type;
      if (!neigh.has(key)) neigh.set(key, { name: other, relation_type: r.type, strength: 0, count: 0 });
      const o = neigh.get(key); o.strength += (r.strength || 1); o.count++;
    }
    return [...neigh.values()].sort((a, b) => b.strength - a.strength).slice(0, limit || 30);
  } catch (e) { return []; }
}
// v1.9.1: 审计历史层——独立于主存储的变更账本。
// 每次 ADD/UPDATE/DELETE/CLEANUP 成功后记一条（失败静默，不影响主流程）。
function recordChangelog(op, info) {
  try {
    const d = sqliteInit();
    d.prepare('INSERT INTO memory_changelog (memory_id, op, ts, user, project, before, after, source_trigger) VALUES (?,?,?,?,?,?,?,?)')
      .run(info.id || null, op, new Date().toISOString(), info.user || null, info.project || null,
        info.before != null ? JSON.stringify(info.before) : null,
        info.after != null ? JSON.stringify(info.after) : null,
        info.trigger || null);
  } catch (e) {}
}
function _clRow(r) {
  return { id: r.id, memory_id: r.memory_id, op: r.op, ts: r.ts, user: r.user, project: r.project,
    before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null, trigger: r.source_trigger };
}
function getChangelog(memoryId, limit) {
  try {
    const d = sqliteInit();
    const rows = d.prepare('SELECT * FROM memory_changelog WHERE memory_id=? ORDER BY id DESC LIMIT ?').all(memoryId, limit || 50);
    return rows.map(_clRow);
  } catch (e) { return []; }
}
function getChangelogAll(limit) {
  try {
    const d = sqliteInit();
    const rows = d.prepare('SELECT * FROM memory_changelog ORDER BY id DESC LIMIT ?').all(limit || 100);
    return rows.map(_clRow);
  } catch (e) { return []; }
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
    corrected_at: r.corrected_at || null,
    version: (r.version !== undefined && r.version !== null) ? Number(r.version) : 1,
    mem_category: r.mem_category || null,
    tier: r.tier || 'long',
    org: r.org || null,
    extract_version: r.extract_version || 'v1' };
}
function sqliteAdd(doc) {
  const d = sqliteInit();
  d.prepare('INSERT INTO memories (id,content,user,project,session,tags,embedding,created_at,updated_at,history,entities,relations,source,entity_names,type,category,confidence,access_count,last_accessed_at,expires_at,memory_type,correction_count,corrected_at,version,mem_category,tier,org,extract_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(doc.id, doc.content, doc.user, doc.project, doc.session,
      JSON.stringify(doc.tags || []), doc.embedding ? JSON.stringify(doc.embedding) : null,
      doc.created_at, doc.updated_at || doc.created_at, JSON.stringify(doc.history || []),
      JSON.stringify(doc.entities || []), JSON.stringify(doc.relations || []),
      doc.source ? JSON.stringify(doc.source) : null, JSON.stringify(doc.entity_names || []),
      doc.type || null, doc.category || 'semantic', (doc.confidence !== undefined && doc.confidence !== null) ? Number(doc.confidence) : null,
      doc.access_count || 0, doc.last_accessed_at || null, doc.expires_at || null, doc.memory_type || 'user',
      doc.correction_count || 0, doc.corrected_at || null, doc.version || 1,
      doc.mem_category || null, doc.tier || 'long', doc.org || null, doc.extract_version || 'v1');
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
  if (patch.mem_category !== undefined) { sets.push('mem_category=?'); params.push(patch.mem_category || null); }
  if (patch.tier !== undefined) { sets.push('tier=?'); params.push(patch.tier || 'long'); }
  if (patch.org !== undefined) { sets.push('org=?'); params.push(patch.org || null); }
  if (patch.extract_version !== undefined) { sets.push('extract_version=?'); params.push(patch.extract_version || 'v1'); }
  if (patch.correction_count !== undefined) { sets.push('correction_count=?'); params.push(patch.correction_count); }
  if (patch.corrected_at !== undefined) { sets.push('corrected_at=?'); params.push(patch.corrected_at || null); }
  const history = (prev.history || []).slice();
  if (patch.content !== undefined && patch.content !== prev.content) {
    history.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
  }
  sets.push('history=?'); params.push(JSON.stringify(history.slice(-10)));
  // v1.9.1: version 乐观锁（SQLite 路径串行，直接递增；Qdrant 路径用重试）
  if (patch.version !== undefined) { sets.push('version=?'); params.push(Number(patch.version)); }
  else { sets.push('version=?'); params.push((prev.version || 1) + 1); }
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
    corrected_at: h._source.corrected_at || null,
    mem_category: h._source.mem_category || null,
    tier: h._source.tier || 'long',
    org: h._source.org || null,
    extract_version: h._source.extract_version || 'v1' }));
}
// v1.9.0: Qdrant 读取结果的行转换（payload 即记忆文档，vector 独立存储）
function payloadToRow(id, score, payload) {
  payload = payload || {};
  return {
    id, score: (typeof score === 'number' && score > 0) ? score : 1,
    content: payload.content, user: payload.user, project: payload.project, session: payload.session,
    tags: payload.tags || [], created_at: payload.created_at, updated_at: payload.updated_at,
    history: payload.history || [], entities: payload.entities || [], relations: payload.relations || [],
    source: payload.source || null, entity_names: payload.entity_names || [], type: payload.type || null,
    category: payload.category || 'semantic',
    confidence: (payload.confidence !== undefined && payload.confidence !== null) ? Number(payload.confidence) : null,
    access_count: (payload.access_count !== undefined && payload.access_count !== null) ? Number(payload.access_count) : 0,
    last_accessed_at: payload.last_accessed_at || null, memory_type: payload.memory_type || 'user',
    expires_at: payload.expires_at || null,
    correction_count: (payload.correction_count !== undefined && payload.correction_count !== null) ? Number(payload.correction_count) : 0,
    corrected_at: payload.corrected_at || null,
    mem_category: payload.mem_category || null,
    tier: payload.tier || 'long',
    org: payload.org || null,
    extract_version: payload.extract_version || 'v1',
  };
}
function pointsToRows(points) { return (points || []).map(p => payloadToRow(p.id, p.score, p.payload)); }
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
// v1.9.0: Qdrant 等价过滤器（与 filters()+timeFilter() 语义一致）。
// 关键：Qdrant 1.18.3 的 should/min_should 结构非标准（min_should 结构体字段不确定，
// 易触发 400），故「未过期」改用 must_not 排除「expires_at 存在且 < now」：
// 缺失 expires_at 的项不会被 range 命中，因此自然保留（等价旧 ES 的 keep-unexpired）。
// is_empty value:true 表示字段缺失/空；range 对 ISO 字符串按字典序比较，格式统一即可。
function qdrantFilter(p) {
  const must = [];
  if (p.user) must.push({ key: 'user', match: { value: p.user } });
  if (p.project) must.push({ key: 'project', match: { value: p.project } });
  if (p.session) must.push({ key: 'session', match: { value: p.session } });
  if (p.type) must.push({ key: 'type', match: { value: p.type } });
  if (p.category) must.push({ key: 'category', match: { value: p.category } });
  if (p.memory_type) must.push({ key: 'memory_type', match: { value: p.memory_type } });
  if (p.min_confidence !== undefined && p.min_confidence !== null) must.push({ key: 'confidence', range: { gte: Number(p.min_confidence) } });
  if (p.from) must.push({ key: 'updated_at', range: { gte: normDate(p.from, false) } });
  if (p.to) must.push({ key: 'updated_at', range: { lte: normDate(p.to, true) } });
  const nowIso = new Date().toISOString();
  const must_not = [{ key: 'expires_at', range: { lt: nowIso } }];
  return { must, must_not };
}
// ---- dedup: find most similar existing memory (cosine similarity) ----
// v1.10.0(P3): 始终按 project 作用域隔离——scope.project 显式为 null 时匹配「无项目」桶，
// 避免空 project 的全局 dedup 跨项目污染。session 同理。
async function dedupFind(vec, scope) {
  scope = scope || {};
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    try {
      const filter = qdrantFilter(scope);
      // 强制 project 作用域（qdrantFilter 仅在 truthy 时加条件；这里补 null 桶）
      if (scope.project !== undefined) {
        filter.must = filter.must.filter(c => c.key !== 'project');
        if (scope.project) filter.must.push({ key: 'project', match: { value: scope.project } });
        else filter.must.push({ key: 'project', is_empty: { value: true } });
      }
      if (scope.session !== undefined) {
        filter.must = filter.must.filter(c => c.key !== 'session');
        if (scope.session) filter.must.push({ key: 'session', match: { value: scope.session } });
        else filter.must.push({ key: 'session', is_empty: { value: true } });
      }
      const res = await qdrant.query({ vector: vec, filter, limit: 1 });
      if (res.length && res[0].payload && res[0].payload.content) {
        // Qdrant (Cosine 距离) 的 score 即余弦相似度；可直接比对 dedup_threshold
        const sim = (res[0].score != null) ? res[0].score : 0;
        return { id: res[0].id, similarity: sim, source: res[0].payload };
      }
    } catch (e) {}
    return null;
  }
  // SQLite path: full scan, compare by cosine
  try {
    const d = sqliteInit();
    const where = [], params = [];
    if (scope.user) { where.push('user=?'); params.push(scope.user); }
    if (scope.project !== undefined) {
      if (scope.project) { where.push('project=?'); params.push(scope.project); }
      else { where.push('(project IS NULL OR project = ?)'); params.push(''); }
    }
    if (scope.session !== undefined) {
      if (scope.session) { where.push('session=?'); params.push(scope.session); }
      else { where.push('(session IS NULL OR session = ?)'); params.push(''); }
    }
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
  try {
    if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
      await Promise.all(ids.map(id => qdrant.incrAccess(id, now).catch(() => {})));
      return;
    }
    const d = sqliteInit();
    const ph = ids.map(() => '?').join(',');
    d.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id IN (' + ph + ')').run(now, ...ids);
  } catch (e) {}
}

// ---- 实体词汇表（canonical 名集合），启动/写入后刷新，用于查询时实体匹配加权 ----
let _entityVocab = null;
async function refreshEntityVocab() {
  try {
    const names = new Set();
    if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
      const pts = await qdrant.scrollAll({});
      for (const p of pts) { const arr = (p.payload && p.payload.entity_names) || []; for (const e of arr) names.add(String(e)); }
    } else {
      const all = sqliteInit().prepare('SELECT entity_names FROM memories').all();
      for (const r of all) { try { const arr = JSON.parse(r.entity_names || '[]'); for (const e of arr) names.add(String(e)); } catch (e2) {} }
    }
    _entityVocab = names;
  } catch (e) { _entityVocab = _entityVocab || new Set(); }
  return _entityVocab;
}
function getEntityVocab() { return _entityVocab || new Set(); }
// v1.10.0: 实体词汇表增量更新（避免每次写入全量 scrollAll 扫描 O(n)）。仅在启动时跑一次全量 refreshEntityVocab。
function addEntityVocab(names) {
  if (!_entityVocab) _entityVocab = new Set();
  if (Array.isArray(names)) for (const e of names) if (e) _entityVocab.add(String(e));
}
function queryEntities(q) {
  const s = (q || '').toLowerCase(); if (!s) return [];
  const v = getEntityVocab(); const out = new Set();
  for (const e of v) { if (e && s.includes(String(e).toLowerCase())) out.add(String(e).toLowerCase()); }
  return [...out];
}

// v1.11.0 (gap④): 通用嵌套过滤器（客户端谓词，对检索/列表返回的行做后过滤，统一覆盖 Qdrant 与 SQLite 双路径，
// 避开 Qdrant 1.18.3 的 should/min_should 非标准结构）。支持：
//   { all: [cond...] }            —— 全部满足（默认顶层对象也按 all 处理）
//   { any: [cond...] }            —— 任一满足
//   { not: cond }                 —— 取反
//   leaf { key, op, value }       —— op ∈ eq,ne,gt,gte,lt,lte,contains,in,exists,between
// 对数组字段（tags/entity_names）contains/in 视同「数组含该值」。
function _matchLeaf(row, leaf) {
  const key = leaf.key; if (key == null) return true;
  let val = row[key];
  if (val === undefined && (key === 'org' || key === 'mem_category' || key === 'tier' || key === 'extract_version')) val = (row[key] !== undefined) ? row[key] : null;
  const op = (leaf.op || 'eq').toLowerCase();
  const target = leaf.value;
  if (op === 'exists') { const has = (val !== undefined && val !== null && val !== ''); return target ? has : !has; }
  // 数组字段特殊处理
  if (Array.isArray(val)) {
    if (op === 'contains') return val.some(x => String(x).toLowerCase().includes(String(target).toLowerCase()));
    if (op === 'in') return val.map(String).includes(String(target));
    if (op === 'eq') return val.map(String).includes(String(target));
    if (op === 'ne') return !val.map(String).includes(String(target));
    return false;
  }
  const sval = (val === undefined || val === null) ? null : val;
  switch (op) {
    case 'eq': return sval === target || String(sval) === String(target);
    case 'ne': return !(sval === target || String(sval) === String(target));
    case 'gt': return sval !== null && Number(sval) > Number(target);
    case 'gte': return sval !== null && Number(sval) >= Number(target);
    case 'lt': return sval !== null && Number(sval) < Number(target);
    case 'lte': return sval !== null && Number(sval) <= Number(target);
    case 'contains': return sval !== null && String(sval).toLowerCase().includes(String(target).toLowerCase());
    case 'in': return Array.isArray(target) ? target.map(String).includes(String(sval)) : (String(sval) === String(target));
    case 'between': return sval !== null && Number(sval) >= Number(target[0]) && Number(sval) <= Number(target[1]);
    default: return true;
  }
}
function matchFilters(row, f) {
  if (!f || typeof f !== 'object') return true;
  if (Array.isArray(f)) return f.every(c => matchFilters(row, c));
  if (f.all) return (f.all || []).every(c => matchFilters(row, c));
  if (f.any) return (f.any || []).some(c => matchFilters(row, c));
  if (f.not) return !matchFilters(row, f.not);
  // v1.11.0 修复：裸叶子 { key, op?, value? } —— 识别为单条件谓词。
  // 否则会被下面「顶层普通对象」分支误解成 row['key']/row['op']/row['value'] 三个 eq 条件，
  // 导致 delete_by_filter 等传单叶子过滤器时匹配不到任何行（deleted:0）。
  if (typeof f.key === 'string' && ('value' in f || 'op' in f)) return _matchLeaf(row, f);
  // 顶层普通对象：每个 key 当作 eq 叶子 AND
  const keys = Object.keys(f);
  if (keys.length === 0) return true;
  return keys.every(k => _matchLeaf(row, { key: k, op: 'eq', value: f[k] }));
}

// v1.11.0 (gap①): 短时工作记忆缓冲——独立于长期库，不污染 Qdrant/FTS/KG/审计；可 promote 至长期。
function addWorkingMemory(doc) {
  const d = sqliteInit();
  d.prepare('INSERT OR REPLACE INTO working_memories (id,content,user,project,session,org,tags,created_at,expires_at,memory_type,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(doc.id, doc.content || '', doc.user || null, doc.project || null, doc.session || null, doc.org || null,
      JSON.stringify(doc.tags || []), doc.created_at || new Date().toISOString(), doc.expires_at || null, doc.memory_type || 'user',
      doc.meta ? JSON.stringify(doc.meta) : null);
  return doc.id;
}
function getWorkingMemory(id) {
  const r = sqliteInit().prepare('SELECT * FROM working_memories WHERE id=?').get(id);
  if (!r) return null;
  return { id: r.id, content: r.content, user: r.user, project: r.project, session: r.session, org: r.org,
    tags: r.tags ? JSON.parse(r.tags) : [], created_at: r.created_at, expires_at: r.expires_at, memory_type: r.memory_type || 'user',
    meta: r.meta ? JSON.parse(r.meta) : null };
}
function listWorkingMemory(scope) {
  scope = scope || {};
  const d = sqliteInit();
  const where = [], params = [];
  if (scope.project) { where.push('project=?'); params.push(scope.project); }
  if (scope.session) { where.push('session=?'); params.push(scope.session); }
  if (scope.org) { where.push('org=?'); params.push(scope.org); }
  if (scope.user) { where.push('user=?'); params.push(scope.user); }
  if (scope.tier) { /* working 表无 tier 概念，忽略 */ }
  where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(new Date().toISOString());
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return d.prepare('SELECT * FROM working_memories' + clause + ' ORDER BY created_at DESC').all(...params)
    .map(r => ({ id: r.id, content: r.content, user: r.user, project: r.project, session: r.session, org: r.org,
      tags: r.tags ? JSON.parse(r.tags) : [], created_at: r.created_at, expires_at: r.expires_at, memory_type: r.memory_type || 'user' }));
}
function deleteWorkingMemory(id) {
  try { sqliteInit().prepare('DELETE FROM working_memories WHERE id=?').run(id); } catch (e) {}
  return { id, deleted: true };
}
// 清理过期工作记忆（由 cleanup 周期调用）
function cleanupWorking(nowIso) {
  try { return sqliteInit().prepare('DELETE FROM working_memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(nowIso).changes; }
  catch (e) { return 0; }
}

// v1.11.0 (gap③): KV 精确匹配通道——flag/配置/短字段的确定性精确查，与语义检索解耦。
function kvGet(k, org) {
  const r = sqliteInit().prepare('SELECT v FROM kv_store WHERE k=? AND org=?').get(k, org || '');
  return r ? r.v : null;
}
function kvSet(k, v, org) {
  const d = sqliteInit();
  d.prepare('INSERT INTO kv_store (k,org,v,updated_at) VALUES (?,?,?,?) ON CONFLICT(k,org) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at')
    .run(k, org || '', String(v), new Date().toISOString());
  return { ok: true, key: k, org: org || '' };
}
function kvDelete(k, org) {
  sqliteInit().prepare('DELETE FROM kv_store WHERE k=? AND org=?').run(k, org || '');
  return { ok: true, key: k, org: org || '' };
}
function kvList(org) {
  const d = sqliteInit();
  const rows = org ? d.prepare('SELECT k,org,v,updated_at FROM kv_store WHERE org=? ORDER BY k').all(org) : d.prepare('SELECT k,org,v,updated_at FROM kv_store ORDER BY k').all();
  return rows.map(r => ({ key: r.k, org: r.org, value: r.v, updated_at: r.updated_at }));
}

module.exports = {
  sqliteInit, rowToDoc, sqliteAdd, sqliteGet, sqliteDelete, sqliteUpdate, hitsToRows,
  filters, timeFilter, normDate, qdrantFilter, payloadToRow, pointsToRows,
  dedupFind, bumpAccess, refreshEntityVocab, getEntityVocab, queryEntities, addEntityVocab,
  recordChangelog, getChangelog, getChangelogAll,
  ftsUpsert, ftsDelete, ftsSearch, ftsReindexAll,
  kgUpsert, kgReindexAll, kgExport, kgNeighbors,
  matchFilters, _matchLeaf,
  addWorkingMemory, getWorkingMemory, listWorkingMemory, deleteWorkingMemory, cleanupWorking,
  kvGet, kvSet, kvDelete, kvList,
};
