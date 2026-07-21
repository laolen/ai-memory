const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { Client } = require('@elastic/elasticsearch');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 8765;

// ---- Config (persisted to config.json, env as fallback) ----
function loadConfig() {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  return {
    es_url: (f.es_url !== undefined) ? f.es_url : (process.env.ES_URL || 'http://192.168.110.248:9200'),
    es_user: f.es_user || process.env.ES_USER || 'elastic',
    es_pwd: (f.es_pwd !== undefined) ? f.es_pwd : (process.env.ES_PWD || ''),
    es_index: f.es_index || process.env.ES_INDEX || 'ai_memories',
    embedding_url: (f.embedding_url !== undefined) ? f.embedding_url : (process.env.EMBEDDING_URL || ''),
    embedding_model: f.embedding_model || process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    embedding_api_key: f.embedding_api_key || process.env.EMBEDDING_API_KEY || '',
    dedup_enabled: (f.dedup_enabled !== undefined) ? f.dedup_enabled : true,
    dedup_threshold: (f.dedup_threshold !== undefined) ? f.dedup_threshold : 0.92,
    recency_enabled: (f.recency_enabled !== undefined) ? f.recency_enabled : true,
    recency_half_life: (f.recency_half_life !== undefined) ? f.recency_half_life : 30,
    expiry_days: (f.expiry_days !== undefined) ? f.expiry_days : 0,
    lifecycle_policy: f.lifecycle_policy || 'none',
    llm_enabled: (f.llm_enabled !== undefined) ? f.llm_enabled : false,
    llm_url: (f.llm_url !== undefined) ? f.llm_url : 'http://127.0.0.1:11434/v1/chat/completions',
    llm_model: f.llm_model || 'minicpm5-1b',
    llm_api_key: f.llm_api_key || process.env.LLM_API_KEY || '',
    capture_watch_enabled: (f.capture_watch_enabled !== undefined) ? f.capture_watch_enabled : false,
    capture_watch_path: f.capture_watch_path || '',
    capture_min_chars: (f.capture_min_chars !== undefined) ? f.capture_min_chars : 20,
    capture_keywords: f.capture_keywords || '',
    capture_max_per_call: (f.capture_max_per_call !== undefined) ? f.capture_max_per_call : 20,
    kg_enabled: (f.kg_enabled !== undefined) ? f.kg_enabled : false,
    kg_max_entities: (f.kg_max_entities !== undefined) ? f.kg_max_entities : 30,
    kg_synonyms: (f.kg_synonyms && typeof f.kg_synonyms === 'object') ? f.kg_synonyms : {},
    kg_model: f.kg_model || f.llm_model || 'minicpm5-1b',
    kg_url: f.kg_url || '',
    kg_api_key: f.kg_api_key || '',
  };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let CONFIG = loadConfig();
let client = null;
function rebuildClient() {
  client = CONFIG.es_url ? new Client({ node: CONFIG.es_url, auth: { username: CONFIG.es_user, password: CONFIG.es_pwd } }) : null;
}
rebuildClient();

// ---- SQLite 降级存储层（es_url 为空时启用，零外部依赖；单文件 memories.db） ----
let Database = null;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }
let db = null;
function sqliteInit() {
  if (db) return db;
  if (!Database) throw new Error('better-sqlite3 未安装，无法启用本地文件数据库降级。');
  db = new Database(path.join(__dirname, 'memories.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT, user TEXT, project TEXT, session TEXT, tags TEXT, embedding TEXT, created_at TEXT)');
  const _cols = new Set(db.pragma('table_info(memories)').map(c => c.name));
  if (!_cols.has('updated_at')) db.exec('ALTER TABLE memories ADD COLUMN updated_at TEXT');
  if (!_cols.has('history')) db.exec('ALTER TABLE memories ADD COLUMN history TEXT');
  if (!_cols.has('entities')) db.exec('ALTER TABLE memories ADD COLUMN entities TEXT');
  if (!_cols.has('relations')) db.exec('ALTER TABLE memories ADD COLUMN relations TEXT');
  if (!_cols.has('source')) db.exec('ALTER TABLE memories ADD COLUMN source TEXT');
  if (!_cols.has('entity_names')) db.exec('ALTER TABLE memories ADD COLUMN entity_names TEXT');
  return db;
}
function rowToDoc(r) {
  return { id: r.id, content: r.content, user: r.user, project: r.project,
    session: r.session, tags: r.tags ? JSON.parse(r.tags) : [], created_at: r.created_at,
    updated_at: r.updated_at || r.created_at, history: r.history ? JSON.parse(r.history) : [],
    entities: r.entities ? JSON.parse(r.entities) : [], relations: r.relations ? JSON.parse(r.relations) : [],
    source: r.source ? JSON.parse(r.source) : null, entity_names: r.entity_names ? JSON.parse(r.entity_names) : [] };
}
function sqliteAdd(doc) {
  const d = sqliteInit();
  d.prepare('INSERT INTO memories (id,content,user,project,session,tags,embedding,created_at,updated_at,history,entities,relations,source,entity_names) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(doc.id, doc.content, doc.user, doc.project, doc.session,
      JSON.stringify(doc.tags || []), doc.embedding ? JSON.stringify(doc.embedding) : null,
      doc.created_at, doc.updated_at || doc.created_at, JSON.stringify(doc.history || []),
      JSON.stringify(doc.entities || []), JSON.stringify(doc.relations || []),
      doc.source ? JSON.stringify(doc.source) : null, JSON.stringify(doc.entity_names || []));
}
function sqliteGet(id) {
  const r = sqliteInit().prepare('SELECT * FROM memories WHERE id=?').get(id);
  if (!r) { const e = new Error('not found'); e.statusCode = 404; throw e; }
  return rowToDoc(r);
}
function sqliteDelete(id) { sqliteInit().prepare('DELETE FROM memories WHERE id=?').run(id); }
function sqliteList(a) {
  const d = sqliteInit();
  const where = [], params = [];
  if (a.user) { where.push('user=?'); params.push(a.user); }
  if (a.project) { where.push('project=?'); params.push(a.project); }
  if (a.session) { where.push('session=?'); params.push(a.session); }
  if (a.from) { where.push('updated_at >= ?'); params.push(a.from); }
  if (a.to) { where.push('updated_at <= ?'); params.push(a.to); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = d.prepare('SELECT * FROM memories' + clause + ' ORDER BY updated_at DESC').all(...params).map(rowToDoc);
  return applyRecency(rows).slice(0, a.limit || 20);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---- temporal awareness helpers ----
function recencyFactor(ts) {
  const t = (ts && !isNaN(new Date(ts).getTime())) ? new Date(ts).getTime() : Date.now();
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  const half = (CONFIG.recency_half_life > 0) ? CONFIG.recency_half_life : 30;
  return Math.pow(0.5, ageDays / half);
}
function applyRecency(rows) {
  if (!CONFIG.recency_enabled) return rows;
  rows.forEach(r => { r.score = (r.score != null ? r.score : 1) * recencyFactor(r.updated_at || r.created_at); });
  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  return rows;
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
async function cleanupExpired() {
  if (!(CONFIG.expiry_days > 0)) return 0;
  const cutoff = new Date(Date.now() - CONFIG.expiry_days * 86400000).toISOString();
  if (CONFIG.es_url && client) {
    try { const r = await client.deleteByQuery({ index: CONFIG.es_index, body: { query: { range: { updated_at: { lt: cutoff } } } } }); return r.deleted || 0; } catch (e) { return 0; }
  }
  const d = sqliteInit();
  const res = d.prepare('DELETE FROM memories WHERE updated_at < ?').run(cutoff);
  return res.changes;
}
async function purgeMemories(scope) {
  const days = scope.days || CONFIG.expiry_days;
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  if (CONFIG.es_url && client) {
    const f = filters(scope);
    f.push({ range: { updated_at: { lt: cutoff } } });
    try { const r = await client.deleteByQuery({ index: CONFIG.es_index, body: { query: { bool: { filter: f } } } }); return r.deleted || 0; } catch (e) { return 0; }
  }
  const d = sqliteInit();
  const where = ['updated_at < ?'], params = [cutoff];
  if (scope.user) { where.push('user=?'); params.push(scope.user); }
  if (scope.project) { where.push('project=?'); params.push(scope.project); }
  if (scope.session) { where.push('session=?'); params.push(scope.session); }
  const res = d.prepare('DELETE FROM memories WHERE ' + where.join(' AND ')).run(...params);
  return res.changes;
}
async function sqliteSearch(a) {
  const mode = a.mode || 'keyword';
  const top_k = a.top_k || 5;
  if ((mode === 'semantic' || mode === 'hybrid') && !CONFIG.embedding_url) {
    throw new Error('semantic/hybrid requires embedding_url (not configured). Use mode=keyword.');
  }
  const d = sqliteInit();
  const where = [], params = [];
  if (a.user) { where.push('user=?'); params.push(a.user); }
  if (a.project) { where.push('project=?'); params.push(a.project); }
  if (a.session) { where.push('session=?'); params.push(a.session); }
  if (a.from) { where.push('updated_at >= ?'); params.push(a.from); }
  if (a.to) { where.push('updated_at <= ?'); params.push(a.to); }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  if (mode === 'keyword') {
    const q = (a.query || '').trim();
    if (!q) {
      const rows = d.prepare('SELECT * FROM memories' + clause + ' ORDER BY updated_at DESC').all(...params);
      return applyRecency(rows.map(r => ({ ...rowToDoc(r), score: 1 }))).slice(0, top_k);
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const like = where.length ? where.map(w => w + ' AND content LIKE ?').join(' AND ') : 'content LIKE ?';
    const lp = params.slice();
    terms.forEach(t => lp.push('%' + t + '%'));
    const rows = d.prepare('SELECT * FROM memories WHERE ' + like).all(...lp);
    const scored = rows.map(r => { let sc = 0; terms.forEach(t => { if (r.content && r.content.includes(t)) sc++; }); return { ...rowToDoc(r), score: sc }; });
    return applyRecency(scored).slice(0, top_k);
  }
  const vec = await embed(a.query);
  const all = d.prepare('SELECT * FROM memories' + clause).all(...params);
  const withVec = all.filter(r => r.embedding).map(r => ({ r, v: JSON.parse(r.embedding) }));
  const sem = withVec.map(({ r, v }) => ({ ...rowToDoc(r), score: cosine(vec, v) }))
    .sort((x, y) => y.score - x.score);
  if (mode === 'semantic') return applyRecency(sem).slice(0, top_k);
  let kwRows = [];
  const q = (a.query || '').trim();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    const like = where.length ? where.map(w => w + ' AND content LIKE ?').join(' AND ') : 'content LIKE ?';
    const lp = params.slice();
    terms.forEach(t => lp.push('%' + t + '%'));
    kwRows = d.prepare('SELECT * FROM memories WHERE ' + like).all(...lp)
      .map(r => { let sc = 0; terms.forEach(t => { if (r.content && r.content.includes(t)) sc++; }); return { ...rowToDoc(r), score: sc }; });
  }
  const K = 60;
  const merged = new Map();
  const add = (list) => list.forEach((item, i) => {
    const cur = merged.get(item.id) || { ...item, score: 0 };
    cur.score += 1 / (K + i + 1);
    merged.set(item.id, cur);
  });
  add(kwRows); add(sem);
  return applyRecency([...merged.values()].sort((x, y) => y.score - x.score)).slice(0, top_k);
}
async function sqliteUpdate(id, patch) {
  const now = new Date().toISOString();
  const prev = sqliteGet(id);
  const sets = [], params = [];
  if (patch.content !== undefined) { sets.push('content=?'); params.push(patch.content); }
  if (patch.project !== undefined) { sets.push('project=?'); params.push(patch.project || null); }
  if (patch.session !== undefined) { sets.push('session=?'); params.push(patch.session || null); }
  if (patch.tags !== undefined) { sets.push('tags=?'); params.push(JSON.stringify(patch.tags || [])); }
  if (patch.updated_at !== undefined) { sets.push('updated_at=?'); params.push(patch.updated_at); }
  else { sets.push('updated_at=?'); params.push(now); }
  if (CONFIG.embedding_url && patch.content !== undefined) {
    try { const v = await embed(patch.content); sets.push('embedding=?'); params.push(JSON.stringify(v)); } catch (e) {}
  }
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

// ---- knowledge graph: entity normalization, extraction, query ----
function canon(name) {
  if (!name) return name;
  const s = String(name).trim().replace(/\s+/g, ' ');
  const key = s.toLowerCase();
  const syn = CONFIG.kg_synonyms || {};
  if (syn[key]) return syn[key];
  for (const [a, c] of Object.entries(syn)) { if (String(c).toLowerCase() === key) return c; }
  return s;
}
function normalizeGraph(ents, rels) {
  const seen = {};
  const entities = [];
  for (const e of (ents || [])) {
    let raw, type;
    if (typeof e === 'string') { raw = e.trim(); type = 'other'; }
    else if (e && e.name) { raw = String(e.name).trim(); type = e.type || 'other'; }
    else continue;
    if (!raw) continue;
    const c = canon(raw);
    if (seen[c]) { if (type && seen[c].type === 'other') seen[c].type = type; continue; }
    const obj = { type, name: raw, canonical: c, aliases: (raw !== c ? [raw] : []) };
    seen[c] = obj; entities.push(obj);
  }
  const cap = (CONFIG.kg_max_entities > 0) ? CONFIG.kg_max_entities : 30;
  const relations = (rels || [])
    .filter(r => r && r.from && r.to)
    .map(r => ({ from: canon(r.from), to: canon(r.to), type: r.type || 'related' }))
    .filter(r => seen[r.from] && seen[r.to] && r.from !== r.to);
  return { entities: entities.slice(0, cap), relations: relations.slice(0, cap * 3), entity_names: entities.map(e => e.canonical) };
}
async function extractGraph(content) {
  // 图谱抽取可独立指向云端（kg_url），否则回退到自动捕获的 llm 配置；两者都支持本地/云端
  const url = CONFIG.kg_url || (CONFIG.llm_enabled ? CONFIG.llm_url : null);
  const key = CONFIG.kg_api_key || CONFIG.llm_api_key || null;
  const model = CONFIG.kg_model || CONFIG.llm_model;
  if (!(CONFIG.kg_enabled && url)) return { entities: [], relations: [], entity_names: [] };
  const sys = 'You are a knowledge-graph extractor. From the text extract entities and relations.\n' +
    'Entity types: person, project, system, file, concept, decision, other.\n' +
    'Respond with ONLY JSON: {"entities":[{"type":"...","name":"..."}],"relations":[{"from":"entity name","to":"entity name","type":"owns|uses|responsible_for|depends_on|part_of|decided|located_in|other"}]}.\n' +
    'Use the exact entity names as they appear in the text.\n' +
    'STRICT CONSTRAINTS:\n' +
    '1) Every relation "from" and "to" MUST be the EXACT "name" of an entity listed in "entities" — never a new, partial, or different name. If a relation cannot reference a listed entity, omit it.\n' +
    '2) Never create self-loops (from === to).\n' +
    '3) No markdown, no commentary. If nothing, return {"entities":[],"relations":[]}.';
  try {
    const c = await chatJSON({ url, model, apiKey: key, messages: [
      { role: 'system', content: sys },
      { role: 'user', content: content } ], temperature: 0.1, jsonMode: true });
    if (!c) return { entities: [], relations: [], entity_names: [] };
    c = c.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(c);
    return normalizeGraph(parsed.entities, parsed.relations);
  } catch (e) { return { entities: [], relations: [], entity_names: [] }; }
}
async function attachGraph(doc, content) {
  if (CONFIG.kg_enabled) {
    try { const g = await extractGraph(content); doc.entities = g.entities; doc.relations = g.relations; doc.entity_names = g.entity_names || []; }
    catch (e) { doc.entities = []; doc.relations = []; doc.entity_names = []; }
  } else { doc.entities = []; doc.relations = []; doc.entity_names = []; }
}
async function graphFetch(entity) {
  const c = canon(entity);
  if (CONFIG.es_url && client) {
    const body = { query: { bool: { filter: [{ terms: { 'entity_names.keyword': [c, entity] } }] } }, size: 300,
      _source: ['id', 'content', 'entities', 'relations', 'source', 'project', 'user', 'updated_at'] };
    try { const res = await client.search({ index: CONFIG.es_index, body }); return res.hits.hits.map(h => ({ id: h._id, ...h._source })); } catch (e) { return []; }
  }
  const all = sqliteInit().prepare('SELECT * FROM memories').all().map(rowToDoc);
  return all.filter(m => (m.entity_names || []).includes(c) || (m.entities || []).some(e => e.canonical === c || e.name === entity));
}
async function relatedTo(entity, relType, limit) {
  const docs = await graphFetch(entity);
  const c = canon(entity);
  const neighbors = new Map();
  const memories = [];
  for (const doc of docs) {
    for (const r of (doc.relations || [])) {
      if (relType && r.type !== relType) continue;
      let other = null;
      if (r.from === c) other = r.to; else if (r.to === c) other = r.from; else continue;
      const key = other + '|' + r.type;
      if (!neighbors.has(key)) neighbors.set(key, { name: other, relation_type: r.type, count: 0 });
      neighbors.get(key).count++;
    }
    memories.push({ id: doc.id, content: doc.content, project: doc.project, source: doc.source || null });
  }
  const neighborsArr = [...neighbors.values()].sort((a, b) => b.count - a.count).slice(0, limit || 20);
  return { entity: c, docs_count: docs.length, neighbors: neighborsArr, memories };
}
async function pathBetween(a, b) {
  const ca = canon(a), cb = canon(b);
  const docsA = await graphFetch(a);
  const docsB = await graphFetch(b);
  const byId = new Map();
  for (const d of docsA.concat(docsB)) byId.set(d.id, d);
  const adj = new Map();
  const addEdge = (x, y, t) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push({ to: y, type: t }); };
  for (const doc of byId.values()) { for (const r of (doc.relations || [])) { addEdge(r.from, r.to, r.type); addEdge(r.to, r.from, r.type); } }
  const prev = new Map(); const q = [ca]; prev.set(ca, null); let found = false;
  while (q.length) {
    const cur = q.shift();
    if (cur === cb) { found = true; break; }
    for (const e of (adj.get(cur) || [])) { if (!prev.has(e.to)) { prev.set(e.to, { from: cur, type: e.type }); q.push(e.to); } }
  }
  if (!found) return { from: ca, to: cb, path: null };
  const path = []; let node = cb;
  while (node) { const p = prev.get(node); path.unshift({ entity: node, via: p ? p.type : null, from: p ? p.from : null }); node = p ? p.from : null; }
  return { from: ca, to: cb, path };
}

// ---- MCP tool schema ----
const TOOLS = [
  { name: 'add_memory', description: 'Store a memory (text) into the AI memory store. When dedup_enabled is on (default) and a vector embedding is available, an incoming memory whose content is highly similar to an existing one (cosine >= dedup_threshold, default 0.92) is merged into that memory instead of creating a duplicate. Pass merge:false to force a new entry.',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' },
      session: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      merge: { type: 'boolean', description: 'Allow merging with a highly similar existing memory. Default: follows global dedup_enabled config. Set false to always create a new entry.' },
      source: { type: 'object', description: 'Optional provenance, e.g. {type:"doc", ref:"docs-mcp-server://.../page"} — recorded on the memory and shown in the knowledge graph.' } },
      required: ['content', 'user'] } },
  { name: 'search_memories', description: 'Search memories. mode: keyword (BM25), semantic (kNN), hybrid (RRF). Results are time-decay weighted (recent first) when recency_enabled. Use from/to (ISO date/time or YYYY-MM-DD) to limit to a time window by updated_at.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], default: 'keyword' }, top_k: { type: 'number', default: 5 },
      from: { type: 'string', description: 'Lower bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      to: { type: 'string', description: 'Upper bound (ISO date/time or YYYY-MM-DD) on updated_at.' } },
      required: ['query'] } },
  { name: 'list_memories', description: 'List recent memories, recency-weighted when recency_enabled. from/to limit to a time window by updated_at.',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' }, limit: { type: 'number', default: 20 },
      from: { type: 'string', description: 'Lower bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      to: { type: 'string', description: 'Upper bound (ISO date/time or YYYY-MM-DD) on updated_at.' } } } },
  { name: 'delete_memory', description: 'Delete a memory by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'purge_memories', description: 'Lifecycle cleanup: delete memories older than N days (by updated_at) within an optional user/project/session scope. If expired_only is true, uses configured expiry_days; otherwise the days argument is used. Nothing happens if neither is set.',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      days: { type: 'number', description: 'Delete memories older than this many days.' },
      expired_only: { type: 'boolean', description: 'If true, use configured expiry_days instead of the days argument.' } },
      required: [] } },
  { name: 'capture_memory', description: 'Auto-capture memories from raw conversation text or notes. If an LLM (llm_url) is configured, the text is intelligently extracted into structured memory items (content+tags+importance) before storage; otherwise a heuristic fallback splits into sentences and stores novel chunks with dedup applied. All captured items are tagged auto-captured.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Raw conversation text, notes, or transcript to capture from.' },
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      source: { type: 'object', description: 'Optional provenance, e.g. {type:"doc", ref:"docs-mcp-server://.../page"} — recorded on captured memories.' } },
      required: ['text'] } },
  { name: 'related_to', description: 'Knowledge-graph: given an entity (person/project/system/...), return the entities connected to it via relations (with relation type and occurrence count) across all memories, plus the source memories. Use type to filter by relation (e.g. responsible_for). Requires kg_enabled + extracted graph data.',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string', description: 'Entity name (alias accepted, normalized via kg_synonyms).' },
      type: { type: 'string', description: 'Optional relation type filter, e.g. responsible_for / uses / depends_on.' },
      limit: { type: 'number', default: 20 } },
      required: ['entity'] } },
  { name: 'graph_query', description: 'Knowledge-graph: return the raw entities and relations of all memories mentioning the given entity. Use it to build/visualize a subgraph. Requires kg_enabled.',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string' }, limit: { type: 'number', default: 50 } },
      required: ['entity'] } },
  { name: 'path_between', description: 'Knowledge-graph: find a relation path between two entities across memories (BFS over extracted relations). Returns null path if not connected. Requires kg_enabled.',
    inputSchema: { type: 'object', properties: {
      a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'] } },
];

async function embed(text) {
  if (!CONFIG.embedding_url) throw new Error('EMBEDDING_URL not configured');
  const isOpenAI = CONFIG.embedding_url.includes('/v1/embeddings');
  const body = isOpenAI
    ? { model: CONFIG.embedding_model, input: [text] }
    : { model: CONFIG.embedding_model, input: text };
  const r = await fetch(CONFIG.embedding_url, {
    method: 'POST', headers: authHeaders(CONFIG.embedding_api_key || null),
    body: JSON.stringify(body) });
  if (!r.ok) throw new Error('embed http ' + r.status);
  const d = await r.json();
  // OpenAI format: { data: [{ embedding: [...] }] }; Ollama format: { embeddings: [[...]] }
  if (isOpenAI) return d.data[0].embedding;
  return d.embeddings[0];
}

// ---- unified OpenAI-compatible chat helper (local or cloud; api_key optional) ----
// 本地 Ollama 无需鉴权（api_key 留空）；云端填对应 key 会自动注入 Authorization: Bearer。
function authHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = 'Bearer ' + apiKey;
  return h;
}
async function chatJSON({ url, model, apiKey, messages, temperature = 0.1, jsonMode = false }) {
  if (!url) return null;
  const body = { model, messages, temperature };
  // 云端（有 api_key）且要求 JSON 时，启用 response_format 强约束；本地 Ollama 通常靠 prompt 约束即可
  if (jsonMode && apiKey) body.response_format = { type: 'json_object' };
  const r = await fetch(url, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) });
  if (!r.ok) return null;
  const d = await r.json();
  const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  return c || null;
}

// ---- 后端连通性 / 可用性自测（本地或云端；接受表单覆盖值，便于「先测试再保存」）----
async function testEmbedding(b = {}) {
  const url = (b.embedding_url !== undefined) ? b.embedding_url : CONFIG.embedding_url;
  const key = (b.embedding_api_key !== undefined) ? b.embedding_api_key : CONFIG.embedding_api_key;
  const model = (b.embedding_model) ? b.embedding_model : CONFIG.embedding_model;
  if (!url) return { ok: false, message: '未配置 Embedding 接口 URL' };
  try {
    const isOpenAI = url.includes('/v1/embeddings');
    const body = isOpenAI ? { model, input: ['test connectivity'] } : { model, input: 'test connectivity' };
    const r = await fetch(url, { method: 'POST', headers: authHeaders(key || null), body: JSON.stringify(body) });
    if (!r.ok) { let t = ''; try { t = await r.text(); } catch {} return { ok: false, message: `HTTP ${r.status} ${r.statusText}`, detail: t.slice(0, 200) }; }
    const d = await r.json();
    const vec = isOpenAI ? (d.data && d.data[0] && d.data[0].embedding) : (d.embeddings && d.embeddings[0]);
    if (!Array.isArray(vec) || vec.length === 0) return { ok: false, message: '返回体缺少向量（data[0].embedding 或 embeddings[0]）', detail: JSON.stringify(d).slice(0, 200) };
    return { ok: true, message: `✅ 连通，向量维度 ${vec.length}`, detail: `model=${model}` };
  } catch (e) { return { ok: false, message: '请求失败：' + e.message }; }
}

async function testChat(b = {}, jsonMode = false) {
  const url = (b.llm_url !== undefined) ? b.llm_url : CONFIG.llm_url;
  const key = (b.llm_api_key !== undefined) ? b.llm_api_key : CONFIG.llm_api_key;
  const model = (b.llm_model) ? b.llm_model : CONFIG.llm_model;
  if (!url) return { ok: false, message: '未配置 LLM 端点' };
  const messages = jsonMode
    ? [{ role: 'system', content: '只返回严格 JSON，不要其他任何文字。' }, { role: 'user', content: '返回 JSON：{"ok":true}' }]
    : [{ role: 'user', content: '请只回复一个字：好' }];
  try {
    const content = await chatJSON({ url, model, apiKey: key || null, messages, temperature: 0.1, jsonMode });
    if (content == null) return { ok: false, message: '无返回（HTTP 非 2xx 或解析失败）' };
    return { ok: true, message: '✅ 模型有响应', detail: String(content).slice(0, 140) };
  } catch (e) { return { ok: false, message: '请求失败：' + e.message }; }
}

async function testKG(b = {}) {
  const url = (b.kg_url) ? b.kg_url : (b.llm_url) ? b.llm_url : (CONFIG.kg_url || (CONFIG.llm_enabled ? CONFIG.llm_url : null));
  const key = (b.kg_api_key) ? b.kg_api_key : (b.llm_api_key) ? b.llm_api_key : (CONFIG.kg_api_key || CONFIG.llm_api_key || null);
  const model = (b.kg_model) ? b.kg_model : (b.llm_model) ? b.llm_model : (CONFIG.kg_model || CONFIG.llm_model);
  if (!url) return { ok: false, message: '未配置图谱端点（kg_url 或 llm_url）' };
  const messages = [
    { role: 'system', content: '你是知识图谱抽取器。只返回严格 JSON，不要 Markdown 代码块，不要其他文字。' },
    { role: 'user', content: '从这句话抽取实体与关系，返回 JSON：{"entities":[{"type":"person","name":"小李"}],"relations":[{"from":"小李","to":"Aurora","type":"responsible_for"}]}。句子：小李负责 Aurora 项目。' }
  ];
  try {
    const content = await chatJSON({ url, model, apiKey: key || null, messages, temperature: 0.1, jsonMode: true });
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
  const esUrl = (b.es_url !== undefined && b.es_url !== '') ? b.es_url : CONFIG.es_url;
  if (!esUrl) return { ok: false, message: '未配置 ES 地址（当前为本地 SQLite 降级模式，记忆存于 memories.db）' };
  const esUser = (b.es_user !== undefined && b.es_user !== '') ? b.es_user : CONFIG.es_user;
  const esPwd = (b.es_pwd !== undefined && b.es_pwd !== '') ? b.es_pwd : CONFIG.es_pwd;
  const esIndex = (b.es_index !== undefined && b.es_index !== '') ? b.es_index : CONFIG.es_index;
  let c;
  try {
    c = new Client({ node: esUrl, auth: { username: esUser, password: esPwd } });
  } catch (e) { return { ok: false, message: '创建 ES 客户端失败：' + e.message }; }
  try {
    const ping = await c.ping();
    let indexExists = false, docs = 0;
    try { indexExists = await c.indices.exists({ index: esIndex }); } catch {}
    if (indexExists) {
      try { const cc = await c.count({ index: esIndex }); docs = cc.count; } catch {}
      return { ok: true, message: `✅ ES 已连接，索引 ${esIndex} 存在，文档数 ${docs}`, detail: `node=${esUrl}` };
    }
    let indices = [];
    try { const ali = await c.cat.indices({ format: 'json' }); indices = (ali || []).map(x => x.index); } catch {}
    return { ok: true, message: `⚠️ ES 已连接，但索引 ${esIndex} 不存在`, detail: '可用索引：' + (indices.length ? indices.join(', ') : '（无）') };
  } catch (e) {
    const detail = (e && e.body) ? JSON.stringify(e.body).slice(0, 200) : '';
    return { ok: false, message: '连接失败：' + (e && e.message ? e.message : '未知错误'), detail };
  }
}

function filters(p) {
  const f = [];
  if (p.user) f.push({ term: { user: p.user } });
  if (p.project) f.push({ term: { project: p.project } });
  if (p.session) f.push({ term: { session: p.session } });
  return f;
}

// ---- dedup: find most similar existing memory (cosine similarity) ----
async function dedupFind(vec, scope) {
  scope = scope || {};
  if (CONFIG.es_url && client) {
    try {
      const filter = filters(scope);
      const body = { query: { bool: { filter } }, knn: { field: 'embedding', query_vector: vec, k: 1, num_candidates: 50 }, size: 1,
        _source: ['content', 'user', 'project', 'session', 'tags', 'embedding', 'created_at', 'updated_at', 'history'] };
      const res = await client.search({ index: CONFIG.es_index, body });
      const hits = res.hits.hits;
      if (hits.length && hits[0]._source && hits[0]._source.embedding) {
        const sim = cosine(vec, hits[0]._source.embedding);
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
      const sim = cosine(vec, JSON.parse(r.embedding));
      if (!best || sim > best.similarity) best = { id: r.id, similarity: sim, source: rowToDoc(r) };
    }
    return best;
  } catch (e) { return null; }
}

// ---- auto-capture: hybrid extraction (LLM when configured, else heuristic) ----
function splitSentences(text) {
  const raw = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  const punct = /[。！？!?；;]/;
  for (const line of raw) {
    let buf = '', seg = '';
    const flush = () => { if (buf.trim().length >= CONFIG.capture_min_chars) out.push(buf.trim()); buf = ''; };
    for (const ch of line) {
      seg += ch;
      if (punct.test(ch)) { buf += seg; seg = ''; flush(); }
    }
    if (seg.trim()) { buf += seg; flush(); }
  }
  return out;
}
function keywordAllowed(text) {
  const kw = (CONFIG.capture_keywords || '').trim();
  if (!kw) return true;
  try { return new RegExp(kw, 'i').test(text); } catch (e) { return true; }
}
async function llmExtract(text) {
  if (!CONFIG.llm_enabled || !CONFIG.llm_url) return null;
  const sys = 'You are a memory extraction engine. Given a conversation or notes, extract durable, self-contained memory items worth remembering long-term: facts, decisions, user preferences, commitments, and useful context. Ignore chit-chat, greetings, and ephemeral content. Respond with ONLY a JSON array of objects, each: {"content": string, "tags": string[], "importance": number (1-5)}. No markdown, no commentary. If nothing is worth remembering, return [].';
  try {
    const content = await chatJSON({ url: CONFIG.llm_url, model: CONFIG.llm_model, apiKey: CONFIG.llm_api_key || null,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: 'Extract memory items from the following:\n\n' + text } ], temperature: 0.2, jsonMode: false });
    if (!content) return [];
    let c = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let parsed; try { parsed = JSON.parse(c); } catch (e) { return []; }
    const arr = Array.isArray(parsed) ? parsed : (parsed.items || parsed.memories || []);
    return arr.filter(x => x && x.content).map(x => ({ content: String(x.content), tags: Array.isArray(x.tags) ? x.tags : [], importance: Number(x.importance) || 3 }));
  } catch (e) { return []; }
}
async function captureText(text, scope) {
  scope = scope || {};
  let mode = (CONFIG.llm_enabled && CONFIG.llm_url) ? 'llm' : 'heuristic';
  let candidates = [];
  if (mode === 'llm') {
    try { candidates = (await llmExtract(text)) || []; }
    catch (e) { candidates = []; mode = 'heuristic'; }
  }
  if (mode !== 'llm') {
    candidates = splitSentences(text)
      .filter(c => c.length >= CONFIG.capture_min_chars && keywordAllowed(c))
      .map(c => ({ content: c, tags: [], importance: 2 }));
  }
  const cap = CONFIG.capture_max_per_call || 20;
  candidates = candidates.slice(0, cap);
  const items = [];
  let captured = 0, skipped = 0;
  for (const c of candidates) {
    const m = { content: c.content, user: scope.user || 'auto', project: scope.project || null,
      session: scope.session || null, tags: Array.from(new Set([...(scope.tags || []), ...(c.tags || []), 'auto-captured'])) };
    if (scope.source) m.source = scope.source;
    try { const r = await doAdd(m); captured++; items.push({ id: r.id, merged: !!r.merged, content: c.content }); }
    catch (e) { skipped++; }
  }
  return { captured, skipped, mode, items };
}
// ---- auto-capture: file/dir watcher ----
const _capturing = new Set();
let watchOffsets = {};
try { watchOffsets = JSON.parse(fs.readFileSync(path.join(__dirname, '.capture.offsets.json'), 'utf8')); } catch (e) {}
function saveWatchOffsets() { try { fs.writeFileSync(path.join(__dirname, '.capture.offsets.json'), JSON.stringify(watchOffsets)); } catch (e) {} }
async function tailAndCapture(filepath, scope) {
  if (_capturing.has(filepath)) return;
  _capturing.add(filepath);
  try {
    const stat = fs.statSync(filepath);
    const start = watchOffsets[filepath] || 0;
    const off = (stat.size < start) ? 0 : start;
    const fd = fs.openSync(filepath, 'r');
    const len = stat.size - off;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      watchOffsets[filepath] = stat.size; saveWatchOffsets();
      const newText = buf.toString('utf8');
      fs.closeSync(fd);
      if (newText.trim()) await captureText(newText, scope);
    } else { fs.closeSync(fd); }
  } catch (e) {} finally { _capturing.delete(filepath); }
}
function startWatcher() {
  if (!CONFIG.capture_watch_enabled || !CONFIG.capture_watch_path) return;
  const p = CONFIG.capture_watch_path;
  const scope = { user: 'auto', project: 'watched', session: null, tags: ['watched'] };
  try {
    const st = fs.statSync(p);
    if (st.isFile()) { tailAndCapture(p, scope); fs.watch(p, () => tailAndCapture(p, scope)); }
    else if (st.isDirectory()) {
      const processDir = () => { try { for (const f of fs.readdirSync(p)) { if (!/\.(log|txt|md|jsonl)$/i.test(f)) continue; tailAndCapture(path.join(p, f), scope); } } catch (e) {} };
      processDir(); fs.watch(p, () => processDir());
    }
  } catch (e) {}
}

// ---- core data ops (return plain JS, reused by MCP + REST) ----
async function doAdd(a) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const doc = {
    id,
    content: a.content, user: a.user, project: a.project || null, session: a.session || null,
    tags: a.tags || [], created_at: now, updated_at: now, history: [] };
  if (CONFIG.embedding_url) { try { doc.embedding = await embed(a.content); } catch (e) {} }
  await attachGraph(doc, a.content);
  if (a.source) doc.source = a.source;

  // 记忆去重 / 合并：相似内容合并到已有记忆，避免重复条目
  const mergeAllowed = (a.merge !== undefined) ? a.merge : CONFIG.dedup_enabled;
  if (mergeAllowed && CONFIG.embedding_url && doc.embedding) {
    const hit = await dedupFind(doc.embedding, { user: a.user, project: a.project, session: a.session });
    if (hit && hit.similarity >= CONFIG.dedup_threshold) {
      const srcTags = (hit.source && hit.source.tags) ? hit.source.tags : [];
      const mergedTags = Array.from(new Set([...(srcTags || []), ...(a.tags || [])]));
      const patch = {
        content: a.content,
        project: a.project || null,
        session: a.session || null,
        tags: mergedTags,
        updated_at: now
      };
      const updated = await doUpdate(hit.id, patch);
      return { id: hit.id, merged: true, merged_from: hit.id, similarity: hit.similarity, ...updated };
    }
  }

  if (CONFIG.es_url && client) {
    await client.index({ index: CONFIG.es_index, id, document: doc });
  } else {
    sqliteAdd(doc);
  }
  // 生命周期：过期自动清理
  if (CONFIG.lifecycle_policy === 'expire' && CONFIG.expiry_days > 0) {
    try { await cleanupExpired(); } catch (e) {}
  }
  return { id, ...doc };
}
function hitsToRows(res) {
  return res.hits.hits.map(h => ({
    id: h._id, score: h._score, content: h._source.content, user: h._source.user,
    project: h._source.project, session: h._source.session, tags: h._source.tags || [], created_at: h._source.created_at,
    updated_at: h._source.updated_at, history: h._source.history || [],
    entities: h._source.entities || [], relations: h._source.relations || [], source: h._source.source || null, entity_names: h._source.entity_names || [] }));
}
async function doSearch(a) {
  if (!CONFIG.es_url || !client) return sqliteSearch(a);
  const mode = a.mode || 'keyword';
  const top_k = a.top_k || 5;
  const filter = filters(a);
  filter.push(...timeFilter(a));
  if ((mode === 'semantic' || mode === 'hybrid') && !CONFIG.embedding_url) {
    throw new Error('semantic/hybrid requires embedding_url (not configured). Use mode=keyword.');
  }
  if (mode === 'keyword') {
    const must = a.query ? [{ match: { content: a.query } }] : [{ match_all: {} }];
    const body = { query: { bool: { must, filter } }, size: top_k };
    return applyRecency(hitsToRows(await client.search({ index: CONFIG.es_index, body })));
  }
  if (mode === 'semantic') {
    const vec = await embed(a.query);
    const body = { query: { bool: { filter } }, knn: { field: 'embedding', query_vector: vec, k: top_k, num_candidates: 100 }, size: top_k };
    return applyRecency(hitsToRows(await client.search({ index: CONFIG.es_index, body })));
  }
  // hybrid: client-side Reciprocal Rank Fusion (avoids ES RRF license requirement)
  const vec = await embed(a.query);
  const kwBody = { query: { bool: { must: a.query ? [{ match: { content: a.query } }] : [{ match_all: {} }], filter } }, size: top_k };
  const knnBody = { query: { bool: { filter } }, knn: { field: 'embedding', query_vector: vec, k: top_k, num_candidates: 100 }, size: top_k };
  const [kwRes, knnRes] = await Promise.all([
    client.search({ index: CONFIG.es_index, body: kwBody }),
    client.search({ index: CONFIG.es_index, body: knnBody }),
  ]);
  const K = 60;
  const merged = new Map();
  const add = (hits) => hits.forEach((h, i) => {
    const id = h._id;
    const rrf = 1 / (K + i + 1);
    if (merged.has(id)) merged.get(id).score += rrf;
    else merged.set(id, { id, score: rrf, content: h._source.content, user: h._source.user,
      project: h._source.project, session: h._source.session, tags: h._source.tags || [], created_at: h._source.created_at, updated_at: h._source.updated_at });
  });
  add(kwRes.hits.hits);
  add(knnRes.hits.hits);
  return applyRecency([...merged.values()].sort((a, b) => b.score - a.score)).slice(0, top_k);
}
async function doList(a) {
  if (!CONFIG.es_url || !client) return sqliteList(a);
  const filter = filters(a);
  filter.push(...timeFilter(a));
  const body = { query: { bool: { filter } }, sort: [{ updated_at: { order: 'desc' } }], size: a.limit || 20 };
  const res = await client.search({ index: CONFIG.es_index, body });
  const rows = res.hits.hits.map(h => ({
    id: h._id, content: h._source.content, user: h._source.user, project: h._source.project,
    session: h._source.session, tags: h._source.tags || [], created_at: h._source.created_at,
    updated_at: h._source.updated_at, history: h._source.history || [],
    entities: h._source.entities || [], relations: h._source.relations || [], source: h._source.source || null, entity_names: h._source.entity_names || [] }));
  return applyRecency(rows).slice(0, a.limit || 20);
}
async function doDelete(id) {
  if (!CONFIG.es_url || !client) { sqliteDelete(id); return; }
  await client.delete({ index: CONFIG.es_index, id });
}
async function doUpdate(id, patch) {
  const now = new Date().toISOString();
  if (!CONFIG.es_url || !client) {
    const prev = sqliteGet(id);
    const sets = [], params = [];
    if (patch.content !== undefined) { sets.push('content=?'); params.push(patch.content); }
    if (patch.project !== undefined) { sets.push('project=?'); params.push(patch.project || null); }
    if (patch.session !== undefined) { sets.push('session=?'); params.push(patch.session || null); }
    if (patch.tags !== undefined) { sets.push('tags=?'); params.push(JSON.stringify(patch.tags || [])); }
    if (patch.updated_at !== undefined) { sets.push('updated_at=?'); params.push(patch.updated_at); }
    else { sets.push('updated_at=?'); params.push(now); }
    if (CONFIG.embedding_url && patch.content !== undefined) {
      try { const v = await embed(patch.content); sets.push('embedding=?'); params.push(JSON.stringify(v)); } catch (e) {}
    }
    if (CONFIG.kg_enabled && patch.content !== undefined) {
      try { const g = await extractGraph(patch.content); sets.push('entities=?'); params.push(JSON.stringify(g.entities)); sets.push('relations=?'); params.push(JSON.stringify(g.relations)); sets.push('entity_names=?'); params.push(JSON.stringify(g.entity_names || [])); } catch (e) {}
    }
    if (patch.source !== undefined) { sets.push('source=?'); params.push(patch.source ? JSON.stringify(patch.source) : null); }
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
  const cur = await client.get({ index: CONFIG.es_index, id });
  const prev = cur._source;
  const doc = {};
  if (patch.content !== undefined) doc.content = patch.content;
  if (patch.project !== undefined) doc.project = patch.project || null;
  if (patch.session !== undefined) doc.session = patch.session || null;
  if (patch.tags !== undefined) doc.tags = patch.tags || [];
  if (patch.updated_at !== undefined) doc.updated_at = patch.updated_at;
  else doc.updated_at = now;
  if (CONFIG.embedding_url && patch.content !== undefined) { try { doc.embedding = await embed(patch.content); } catch (e) {} }
  if (CONFIG.kg_enabled && patch.content !== undefined) { try { const g = await extractGraph(patch.content); doc.entities = g.entities; doc.relations = g.relations; doc.entity_names = g.entity_names || []; } catch (e) {} }
  if (patch.source !== undefined) doc.source = patch.source || null;
  const prevHistory = (prev.history || []);
  if (patch.content !== undefined && patch.content !== prev.content) {
    const hist = prevHistory.slice();
    hist.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
    doc.history = hist.slice(-10);
  }
  await client.update({ index: CONFIG.es_index, id, doc });
  return { id, ...doc };
}

// ---- MCP server factory (one instance per SSE connection) ----
function createServer() {
  const server = new Server({ name: 'ai-memory', version: '1.3.3' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'add_memory') {
        const r = await doAdd(args);
        const text = r.merged ? ('Memory merged with ' + r.merged_from + ' (similarity ' + (r.similarity || 0).toFixed(3) + ')') : ('Memory added: ' + r.id);
        return { content: [{ type: 'text', text }] };
      }
      if (name === 'search_memories') { const r = await doSearch(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'list_memories') { const r = await doList(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'delete_memory') { await doDelete(args.id); return { content: [{ type: 'text', text: 'Deleted: ' + args.id }] }; }
      if (name === 'purge_memories') {
        const days = args.expired_only ? CONFIG.expiry_days : (args.days != null ? args.days : CONFIG.expiry_days);
        if (!(days > 0)) return { content: [{ type: 'text', text: 'Nothing to purge (no expiry_days configured and no days given).' }] };
        const n = await purgeMemories({ user: args.user, project: args.project, session: args.session, days });
        return { content: [{ type: 'text', text: 'Purged ' + n + ' memories older than ' + days + ' days.' }] };
      }
      if (name === 'capture_memory') {
        const r = await captureText(args.text || '', { user: args.user, project: args.project, session: args.session, tags: args.tags, source: args.source });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'related_to') {
        const r = await relatedTo(args.entity, args.type, args.limit);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'graph_query') {
        const r = await relatedTo(args.entity, null, args.limit);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'path_between') {
        const r = await pathBetween(args.a, args.b);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
    } catch (e) { return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }; }
  });
  return server;
}

// ---- REST helpers ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => data += c);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

let ADMIN_HTML = '';
try { ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8'); } catch (e) {}

// ---- Docs (interface reference for admin help page; TOOLS reused so it stays in sync) ----
const DOCS = {
  server_version: '1.3.3',
  overview: 'AI Memory 是记忆体 MCP 服务：默认基于 Elasticsearch，当 es_url 留空时自动降级为本地 SQLite 文件库（memories.db），均无需额外部署即可运行。提供记忆的存储(add)、查询(search/list)、编辑、删除能力，支持关键词(BM25)、语义(kNN 向量)与混合(RRF 应用层融合)三种检索模式。本管理界面可管理记忆数据、配置数据库与嵌入模型。',
  transport: 'MCP 通过 SSE 暴露：客户端连接 GET /sse 建立会话，工具调用经 POST /message 转发(JSON-RPC 2.0)。',
  tools: TOOLS,
  rest_api: [
    { method: 'GET', path: '/api/health', desc: '服务健康与配置摘要：ES 是否连接、向量检索是否启用、当前参数。' },
    { method: 'GET', path: '/api/config', desc: '读取当前配置（密码以 ****** 掩码返回）。' },
    { method: 'POST', path: '/api/config', desc: '保存配置到 config.json，并自动 systemctl restart ai-memory 生效。' },
    { method: 'GET', path: '/api/memories?q=&mode=&limit=&project=&user=', desc: '搜索或列出记忆。q 为空则按时间倒序列出全部。' },
    { method: 'GET', path: '/api/memories/:id', desc: '读取单条记忆原始文档。' },
    { method: 'PUT', path: '/api/memories/:id', desc: '编辑记忆（content/project/tags；改内容会异步重算向量）。' },
    { method: 'DELETE', path: '/api/memories/:id', desc: '删除指定记忆。' },
    { method: 'DELETE', path: '/api/memories/cleanup?expired=1&days=&user=&project=&session=', desc: '生命周期清理：删除超过 N 天的记忆（按 updated_at）。expired=1 用配置的 expiry_days，或传 days 指定天数。' },
    { method: 'POST', path: '/api/capture', desc: '自动捕获：把原始对话/文本提炼成记忆并入库。text 必填；可选 user/project/session/tags。配了 llm_enabled+llm_url 时走 LLM 智能提取，否则启发式按句切分去重入库。返回 {captured,skipped,mode,items}。' },
    { method: 'GET', path: '/api/graph?entity=&type=&limit=', desc: '知识图谱：返回与某实体相连的所有实体（含关系类型与出现次数）及来源记忆。type 可过滤关系类型。需 kg_enabled 且已有抽取数据。' },
    { method: 'GET', path: '/api/graph/path?a=&b=', desc: '知识图谱：在两实体间做关系路径查找（BFS）。无路径返回 path:null。需 kg_enabled。' },
    { method: 'POST', path: '/api/test-backend', desc: '后端自测：验证嵌入/捕获 LLM/图谱三后端是否可用（本地或云端）。body:{type:"embedding"|"llm"|"kg"} 可选覆盖字段 embedding_url/embedding_model/embedding_api_key/llm_url/llm_model/llm_api_key/kg_url/kg_model/kg_api_key（未传则用已保存配置）。返回 {ok,message,detail}。管理界面各模型区有「测试」按钮、数据库区有「测试连接」按钮调用此接口。db 覆盖字段：es_url/es_index/es_user/es_pwd。' },
  ],
  config_fields: [
    { key: 'es_url', desc: 'Elasticsearch 节点地址，如 http://192.168.110.248:9200。' },
    { key: 'es_index', desc: '记忆存储索引名，默认 ai_memories。embedding 字段为 dense_vector 768 维。' },
    { key: 'es_user', desc: 'ES 用户名，如 elastic。' },
    { key: 'es_pwd', desc: 'ES 密码。界面留空表示不修改。' },
    { key: 'embedding_url', desc: '嵌入服务接口 URL。兼容 Ollama /api/embed 或 OpenAI /v1/embeddings（云端）。留空则关闭向量检索（仅关键词可用）。' },
    { key: 'embedding_model', desc: '嵌入模型名，如 qwen3-embedding（本地，输出 1024 维向量）或云端 text-embedding-3-small 等。' },
    { key: 'embedding_api_key', desc: '云端 Embedding 的 API Key（OpenAI 兼容 /v1/embeddings 需要 Bearer 鉴权）。本地 Ollama 嵌入留空即可。' },
    { key: 'dedup_enabled', desc: '记忆去重合并开关（true/false），默认 true。开启后相似内容会合并到已有记忆而非新增。' },
    { key: 'dedup_threshold', desc: '合并相似度阈值（0.7~1.0），默认 0.92。余弦相似度 >= 阈值才合并。' },
    { key: 'recency_enabled', desc: '时序加权开关（true/false），默认 true。检索/列出时对结果按更新时间做指数衰减加权（近期记忆优先）。' },
    { key: 'recency_half_life', desc: '时序半衰期（天），默认 30。记忆年龄每过这么多天，检索权重衰减一半。' },
    { key: 'expiry_days', desc: '记忆过期天数（0=不过期），默认 0。配合 lifecycle_policy=expire 自动/手动清理超期记忆。' },
    { key: 'lifecycle_policy', desc: '生命周期策略：none（永久保留，仅时序加权）/ expire（超过 expiry_days 的记忆被清理）。默认 none。' },
    { key: 'llm_enabled', desc: '自动捕获的 LLM 智能提取开关（true/false），默认 false。开启且配了 llm_url 时，capture 会先把文本交给 chat 模型提炼成结构化记忆，否则走启发式。' },
    { key: 'llm_url', desc: 'chat 补全端点（OpenAI 兼容 /v1/chat/completions）。可填本地 Ollama（如 http://127.0.0.1:11434/v1/chat/completions）或云端（如 https://api.deepseek.com/v1/chat/completions，需配 llm_api_key）。需填「服务器能连到」的地址。留空则 capture 走启发式。' },
    { key: 'llm_model', desc: '用于提取的 chat 模型名，如 minicpm5-1b（本地）或云端模型 id。需在对应端点已可用。' },
    { key: 'llm_api_key', desc: '云端 chat 服务的 API Key（如 DeepSeek/OpenAI/硅基流动）。本地 Ollama 留空即无鉴权。' },
    { key: 'capture_watch_enabled', desc: '自动捕获文件监听开关（true/false），默认 false。开启后服务器会 tail 监听 capture_watch_path（文件或目录）的新增内容并自动捕获。' },
    { key: 'capture_watch_path', desc: '监听路径：单个日志文件，或一个目录（.log/.txt/.md/.jsonl）。留空则不开监听。' },
    { key: 'capture_min_chars', desc: '启发式捕获的单条最小字符数，默认 20。太短的碎片不入。' },
    { key: 'capture_keywords', desc: '可选关键词/正则白名单（留空=全部捕获）。仅匹配的文本才被启发式捕获。' },
    { key: 'capture_max_per_call', desc: '单次捕获最多入库条数，默认 20，防止一次塞爆。' },
    { key: 'kg_enabled', desc: '知识图谱开关（true/false），默认 false。开启后写入/编辑记忆会用 LLM（llm_url/llm_model，复用自动捕获的同款配置）抽取实体与关系，存入 entities/relations 字段。无 LLM 时不抽取（图谱字段留空）。' },
    { key: 'kg_max_entities', desc: '单条记忆最多抽取的实体数，默认 30，防止实体爆炸。' },
    { key: 'kg_synonyms', desc: '实体同义词/别名归一表（JSON 对象，alias→canonical）。抽取出的实体名先经此表归一为 canonical，跨记忆按 canonical 聚合，从而实现消歧。如 {"李工":"小李","Aurora 项目":"Aurora"}。' },
    { key: 'kg_model', desc: '知识图谱抽取专用 chat 模型名（默认回退到 llm_model）。建议用更强模型（如本地 qwen3.5:9b 或云端 deepseek 系列）以获得更稳定的实体/关系抽取；minicpm5-1b 对嵌套图 schema 不稳定。' },
    { key: 'kg_url', desc: '知识图谱抽取专用的 chat 端点（OpenAI 兼容）。留空则复用自动捕获的 llm_url（即与捕获共用同一端点）。可独立指向云端，让图谱抽取走云、捕获留本地，二者解耦。' },
    { key: 'kg_api_key', desc: '图谱抽取端点（kg_url）的 API Key。留空则复用 llm_api_key。本地 Ollama 留空即无鉴权。' },
  ],
  search_modes: [
    { mode: 'keyword', desc: 'BM25 关键词匹配。不依赖嵌入服务，始终可用。' },
    { mode: 'semantic', desc: 'kNN 向量检索。需 embedding_url 已配置；按余弦相似度返回最相近记忆。' },
    { mode: 'hybrid', desc: '关键词 + 语义 的应用层 RRF 融合排序。规避 ES basic 许可证不支持服务端 RRF 的限制。' },
  ],
  architecture: 'ai-memory.service(Node, :8765) ── 直连 ──> Elasticsearch(:9200)。向量由 llama-embed.service(llama.cpp，CPU 运行，:11435，OpenAI /v1/embeddings) 用 Qwen3-Embedding-0.6B 生成 1024 维向量。配置持久化于 /opt/ai-memory/config.json。',
  notes: [
    '当前 ES 为 basic 许可证，混合检索使用「应用层 RRF」而非服务端 RRF。',
    '向量在 CPU 上生成，单次嵌入约数百毫秒；修改记忆内容会异步重算向量（失败静默跳过）。',
    'Elasticsearch 近实时刷新：写入后约 1 秒才可被搜索到，属正常现象。',
    '管理界面当前无访问鉴权，仅限受信任的内网环境访问。',
    '在 WorkBuddy/opencode 中使用前，需先在连接器页对该 MCP 端点点「信任」/重启加载。',
    '无 ES 降级：config 的 es_url 留空时自动改用本地 SQLite 文件库（memories.db），无需任何外部服务即可存储/检索；embedding 仍可选配（语义检索需要）。',
    '记忆去重合并：dedup_enabled=true 且已配 embedding_url 时，写入内容若与某条已有记忆余弦相似度 >= dedup_threshold（默认 0.92），则合并到该记忆（内容覆盖为最新、标签取并集、重算向量、更新合并时间），而非新增重复条目。add_memory 传 merge:false 可强制新增。',
    '时序感知：每条记忆带 created_at（创建时间）与 updated_at（末次修改）。检索/列出受 recency_enabled 控制做时间衰减加权（近期优先），并可用 from/to 按 updated_at 做时间窗过滤。合并/编辑内容时会把旧版本压入 history（保留最近 10 条），可用 get_memory / GET /api/memories/:id 查看演变。lifecycle_policy=expire 且 expiry_days>0 时，超期记忆在写入时自动清理，也可用 purge_memories 工具或 DELETE /api/memories/cleanup 手动清理。',
    '自动捕获：新增 capture_memory 工具与 POST /api/capture 端点，把原始对话/文本自动提炼成记忆。配了 llm_enabled+llm_url 时走 LLM 智能提取（文本→结构化 {content,tags,importance} 候选），否则走启发式（按句切分、关键词白名单过滤、单条最小字符数、去重合并）入库。所有捕获项打 auto-captured 标签便于回溯清理。另支持 capture_watch_enabled + capture_watch_path 服务端文件/目录监听，tail 新增内容自动捕获（offset 持久化到 .capture.offsets.json，重启续传）。',
    '知识图谱：kg_enabled 开启且配了可用端点（kg_url 或 llm_url+llm_enabled）时，写入/编辑记忆会用 LLM 抽取实体与关系，存入 entities/relations/source/entity_names 字段。实体名经 kg_synonyms 同义词表归一为 canonical，跨记忆按 canonical 聚合实现消歧。新增 related_to / graph_query / path_between 三个 MCP 工具与 GET /api/graph、GET /api/graph/path 两个 REST 端点。图谱节点携带 source（如来自 docs-mcp-server 的文档引用），与文档检索层互补而不冲突。无可用端点时不抽取，图谱字段留空。',
    '云端模型支持（本地优先亦可）：嵌入(embedding_url+embedding_api_key)、捕获(llm_url+llm_model+llm_api_key)、图谱(kg_url+kg_model+kg_api_key) 三个后端均支持「本地或云端」——本地 Ollama/llama-embed 留空对应 api_key 即无鉴权；云端填 OpenAI 兼容端点 + API Key 即可（会自动注入 Authorization: Bearer）。图谱抽取可经独立 kg_url 指向云端，与捕获端点彻底解耦。注意 128 服务器需能出网访问云端 HTTPS，且每条记忆写入会打到云端（延迟+计费+记忆内容出网，请评估隐私）。',
  ],
};

// ---- HTTP server (MCP SSE + Admin UI + REST) ----
const transports = {};
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // --- MCP SSE ---
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/message', res);
      transports[transport.sessionId] = transport;
      res.on('close', () => { delete transports[transport.sessionId]; });
      const server = createServer();
      await server.connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/message') {
      const sid = url.searchParams.get('sessionId');
      const t = transports[sid];
      if (!t) { res.writeHead(400); res.end('unknown session'); return; }
      await t.handlePostMessage(req, res);
      return;
    }
    // --- Admin UI ---
    if (req.method === 'GET' && url.pathname === '/admin') {
      if (!ADMIN_HTML) { res.writeHead(500); res.end('admin.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ADMIN_HTML);
      return;
    }
    // --- REST: docs (interface reference for admin help page) ---
    if (url.pathname === '/api/docs' && req.method === 'GET') {
      return sendJson(res, 200, DOCS);
    }
    // --- REST: health ---
    // --- REST: diagnose (test ES + embedding end-to-end) ---
    if (url.pathname === '/api/diagnose' && req.method === 'POST') {
      const out = { es: null, embedding: null };
      if (!client) {
        out.es = { ok: false, reason: 'es_url 未配置，记忆使用本地 SQLite 文件存储（memories.db）' };
      } else {
        try {
          const ping = await client.ping();
          let docs = null;
          try { const c = await client.count({ index: CONFIG.es_index }); docs = c.count; } catch (e2) {}
          out.es = { ok: true, connected: !!ping, index: CONFIG.es_index, docs };
        } catch (e) { out.es = { ok: false, error: String(e && e.message || e) }; }
      }
      out.store = CONFIG.es_url ? 'elasticsearch' : 'sqlite';
      if (CONFIG.embedding_url) {
        try {
          const t0 = Date.now();
          const vec = await embed('connectivity test 连接测试');
          out.embedding = { ok: true, model: CONFIG.embedding_model, url: CONFIG.embedding_url, dims: Array.isArray(vec) ? vec.length : 0, ms: Date.now() - t0, sample: Array.isArray(vec) ? vec.slice(0,3) : [] };
        } catch (e) { out.embedding = { ok: false, model: CONFIG.embedding_model, url: CONFIG.embedding_url, error: String(e && e.message || e) }; }
      } else {
        out.embedding = { ok: false, reason: 'embedding_url 未配置，向量检索关闭' };
      }
      return sendJson(res, 200, out);
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
      let esOk = false;
      if (client) { try { esOk = await client.ping(); } catch (e) {} }
      return sendJson(res, 200, {
        ok: true, store: CONFIG.es_url ? 'elasticsearch' : 'sqlite', es_connected: esOk,
        config: { es_url: CONFIG.es_url, es_index: CONFIG.es_index, es_user: CONFIG.es_user,
          embedding_url: CONFIG.embedding_url, embedding_model: CONFIG.embedding_model,
          embedding_enabled: !!CONFIG.embedding_url, llm_enabled: CONFIG.llm_enabled,
          capture_watch_enabled: CONFIG.capture_watch_enabled, kg_enabled: CONFIG.kg_enabled } });
    }
    // --- REST: config GET ---
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const masked = { ...CONFIG,
        es_pwd: CONFIG.es_pwd || '',
        embedding_api_key: CONFIG.embedding_api_key ? '******' : '',
        llm_api_key: CONFIG.llm_api_key ? '******' : '',
        kg_api_key: CONFIG.kg_api_key ? '******' : '' };
      return sendJson(res, 200, masked);
    }
    // --- REST: config POST (save + restart) ---
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      const newCfg = loadConfig();
      if (b.es_url) newCfg.es_url = b.es_url;
      if (b.es_user) newCfg.es_user = b.es_user;
      if (b.es_pwd && b.es_pwd !== '******') newCfg.es_pwd = b.es_pwd; // keep old if masked
      if (b.es_index) newCfg.es_index = b.es_index;
      if (b.embedding_url !== undefined) newCfg.embedding_url = b.embedding_url;
      if (b.embedding_model) newCfg.embedding_model = b.embedding_model;
      if (b.embedding_api_key !== undefined && b.embedding_api_key !== '******') newCfg.embedding_api_key = b.embedding_api_key;
      if (b.dedup_enabled !== undefined) newCfg.dedup_enabled = b.dedup_enabled;
      if (b.dedup_threshold !== undefined) newCfg.dedup_threshold = Number(b.dedup_threshold) || 0.92;
      if (b.recency_enabled !== undefined) newCfg.recency_enabled = b.recency_enabled;
      if (b.recency_half_life !== undefined) newCfg.recency_half_life = Number(b.recency_half_life) || 30;
      if (b.expiry_days !== undefined) newCfg.expiry_days = Number(b.expiry_days) || 0;
      if (b.lifecycle_policy !== undefined) newCfg.lifecycle_policy = b.lifecycle_policy;
      if (b.llm_enabled !== undefined) newCfg.llm_enabled = b.llm_enabled;
      if (b.llm_url !== undefined) newCfg.llm_url = b.llm_url;
      if (b.llm_model !== undefined) newCfg.llm_model = b.llm_model;
      if (b.llm_api_key !== undefined && b.llm_api_key !== '******') newCfg.llm_api_key = b.llm_api_key;
      if (b.capture_watch_enabled !== undefined) newCfg.capture_watch_enabled = b.capture_watch_enabled;
      if (b.capture_watch_path !== undefined) newCfg.capture_watch_path = b.capture_watch_path;
      if (b.capture_min_chars !== undefined) newCfg.capture_min_chars = Number(b.capture_min_chars) || 20;
      if (b.capture_keywords !== undefined) newCfg.capture_keywords = b.capture_keywords;
      if (b.capture_max_per_call !== undefined) newCfg.capture_max_per_call = Number(b.capture_max_per_call) || 20;
      if (b.kg_enabled !== undefined) newCfg.kg_enabled = b.kg_enabled;
      if (b.kg_max_entities !== undefined) newCfg.kg_max_entities = Number(b.kg_max_entities) || 30;
      if (b.kg_synonyms !== undefined) newCfg.kg_synonyms = (b.kg_synonyms && typeof b.kg_synonyms === 'object') ? b.kg_synonyms : {};
      if (b.kg_model !== undefined) newCfg.kg_model = b.kg_model || CONFIG.llm_model;
      if (b.kg_url !== undefined) newCfg.kg_url = b.kg_url;
      if (b.kg_api_key !== undefined && b.kg_api_key !== '******') newCfg.kg_api_key = b.kg_api_key;
      saveConfig(newCfg);
      sendJson(res, 200, { ok: true, restarting: true, config: { ...newCfg, es_pwd: newCfg.es_pwd || '' } });
      setTimeout(() => { exec('systemctl restart ai-memory'); }, 400);
      return;
    }
    // --- REST: auto-capture ---
    if (url.pathname === '/api/capture' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await captureText(b.text || '', { user: b.user, project: b.project, session: b.session, tags: b.tags, source: b.source });
      return sendJson(res, 200, { ok: true, ...r });
    }
    // --- REST: backend self-test (embedding / llm / kg; local or cloud) ---
    if (url.pathname === '/api/test-backend' && req.method === 'POST') {
      const b = await readBody(req);
      let r;
      if (b.type === 'embedding') r = await testEmbedding(b);
      else if (b.type === 'llm') r = await testChat(b, false);
      else if (b.type === 'kg') r = await testKG(b);
      else if (b.type === 'db') r = await testDatabase(b);
      else return sendJson(res, 400, { ok: false, message: '未知 type：' + b.type });
      return sendJson(res, 200, r);
    }
    // --- REST: knowledge graph ---
    if (url.pathname === '/api/graph' && req.method === 'GET') {
      const entity = url.searchParams.get('entity') || '';
      const relType = url.searchParams.get('type') || '';
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      return sendJson(res, 200, await relatedTo(entity, relType, limit));
    }
    if (url.pathname === '/api/graph/path' && req.method === 'GET') {
      const a = url.searchParams.get('a') || ''; const b = url.searchParams.get('b') || '';
      return sendJson(res, 200, await pathBetween(a, b));
    }
    // --- REST: memories list / search ---
    if (url.pathname === '/api/memories' && req.method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const mode = url.searchParams.get('mode') || 'keyword';
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const project = url.searchParams.get('project') || '';
      const user = url.searchParams.get('user') || '';
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      let rows;
      if (q) rows = await doSearch({ query: q, mode, top_k: limit, project, user, from, to });
      else rows = await doList({ limit, project, user, from, to });
      return sendJson(res, 200, { count: rows.length, rows });
    }
    // --- REST: memories cleanup (lifecycle) ---
    if (url.pathname === '/api/memories/cleanup' && req.method === 'DELETE') {
      const days = url.searchParams.get('days');
      const expiredOnly = url.searchParams.get('expired') === '1';
      const scope = { user: url.searchParams.get('user') || '', project: url.searchParams.get('project') || '',
        session: url.searchParams.get('session') || '', days: days != null ? Number(days) : (expiredOnly ? CONFIG.expiry_days : CONFIG.expiry_days) };
      const n = await purgeMemories(scope);
      return sendJson(res, 200, { ok: true, purged: n });
    }
    // --- REST: memory get / put / delete by id ---
    const m = url.pathname.match(/^\/api\/memories\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        try {
          if (client) { const r = await client.get({ index: CONFIG.es_index, id }); return sendJson(res, 200, { id: r._id, ...r._source }); }
          return sendJson(res, 200, sqliteGet(id));
        } catch (e) { return sendJson(res, 404, { error: e.message }); }
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        const r = await doUpdate(id, b);
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (req.method === 'DELETE') {
        await doDelete(id);
        return sendJson(res, 200, { ok: true, id });
      }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end('error: ' + e.message);
  }
});

httpServer.listen(PORT, () => {
  console.log('ai-memory MCP+Admin server listening on port ' + PORT);
  startWatcher();
});
