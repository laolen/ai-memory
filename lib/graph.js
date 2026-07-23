// 知识图谱层：实体归一(canon) + 抽取(extractGraph) + 挂载(attachGraph) + 查询(relatedTo/pathBetween/graphFetch)。
// 依赖 backend(存储/读取)、embed(LLM chat)、util(无直接依赖但保持单向)、config。
const config = require('./config');
const backend = require('./backend');
const qdrant = require('./qdrant');
const embed = require('./embed');

function canon(name) {
  if (!name) return name;
  const s = String(name).trim().replace(/\s+/g, ' ');
  const key = s.toLowerCase();
  const syn = config.CONFIG.kg_synonyms || {};
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
  const cap = (config.CONFIG.kg_max_entities > 0) ? config.CONFIG.kg_max_entities : 30;
  const relations = (rels || [])
    .filter(r => r && r.from && r.to)
    .map(r => ({ from: canon(r.from), to: canon(r.to), type: r.type || 'related' }))
    .filter(r => seen[r.from] && seen[r.to] && r.from !== r.to);
  return { entities: entities.slice(0, cap), relations: relations.slice(0, cap * 3), entity_names: entities.map(e => e.canonical) };
}
async function extractGraph(content) {
  // 图谱抽取可独立指向云端（kg_url），否则回退到自动捕获的 llm 配置；两者都支持本地/云端
  const url = config.CONFIG.kg_url || (config.CONFIG.llm_enabled ? config.CONFIG.llm_url : null);
  const key = config.CONFIG.kg_api_key || config.CONFIG.llm_api_key || null;
  const model = config.CONFIG.kg_model || config.CONFIG.llm_model;
  if (!(config.CONFIG.kg_enabled && url)) return { entities: [], relations: [], entity_names: [] };
  const sys = 'You are a knowledge-graph extractor. From the text extract entities and relations.\n' +
    'Entity types: person, project, system, file, concept, decision, other.\n' +
    'Respond with ONLY JSON: {"entities":[{"type":"...","name":"..."}],"relations":[{"from":"entity name","to":"entity name","type":"owns|uses|responsible_for|depends_on|part_of|decided|located_in|other"}]}.\n' +
    'Use the exact entity names as they appear in the text.\n' +
    'STRICT CONSTRAINTS:\n' +
    '1) Every relation "from" and "to" MUST be the EXACT "name" of an entity listed in "entities" — never a new, partial, or different name. If a relation cannot reference a listed entity, omit it.\n' +
    '2) Never create self-loops (from === to).\n' +
    '3) No markdown, no commentary. If nothing, return {"entities":[],"relations":[]}.\n' +
    '语言约束：保持输入原文的【语言】，不要翻译（中文输入必须输出中文，英文输入输出英文）；实体 name 必须与原文逐字一致。';
  try {
    const c = await embed.chatJSON({ url, model, apiKey: key, messages: [
      { role: 'system', content: sys },
      { role: 'user', content: content } ], temperature: 0.1, jsonMode: true });
    if (!c) return { entities: [], relations: [], entity_names: [] };
    c = c.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(c);
    return normalizeGraph(parsed.entities, parsed.relations);
  } catch (e) { return { entities: [], relations: [], entity_names: [] }; }
}
async function attachGraph(doc, content) {
  if (config.CONFIG.kg_enabled) {
    try { const g = await extractGraph(content); doc.entities = g.entities; doc.relations = g.relations; doc.entity_names = g.entity_names || []; }
    catch (e) { doc.entities = []; doc.relations = []; doc.entity_names = []; }
  } else { doc.entities = []; doc.relations = []; doc.entity_names = []; }
}
async function graphFetch(entity) {
  const c = canon(entity);
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    try {
      const filter = { must: [{ key: 'entity_names', match: { any: [c, entity] } }] };
      const { points } = await qdrant.scroll({ filter, limit: 300, withVector: false });
      return backend.pointsToRows(points);
    } catch (e) { return []; }
  }
  const all = backend.sqliteInit().prepare('SELECT * FROM memories').all().map(backend.rowToDoc);
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

module.exports = { canon, normalizeGraph, extractGraph, attachGraph, graphFetch, relatedTo, pathBetween };
