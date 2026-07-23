// 记忆操作层（核心数据 ops，MCP + REST 共用）：doAdd/doUpdate/doDelete/doSearch/doList
// + searchProject + sqliteList/sqliteSearch + cleanupExpired/purgeMemories + getMemory/bumpCorrection。
// 依赖 backend(存储/读取/过滤/去重)、intelligence(重排)、projects(跨项目)、embed(向量)、graph(图谱)、quality(指标)、util。
const crypto = require('crypto');
const config = require('./config');
const util = require('./util');
const intelligence = require('./intelligence');
const projects = require('./projects');
const embed = require('./embed');
const graph = require('./graph');
const quality = require('./quality');
const backend = require('./backend');

async function doAdd(a) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const doc = {
    id,
    content: a.content, user: a.user, project: a.project || null, session: a.session || null,
    tags: a.tags || [], created_at: now, updated_at: now, history: [],
    type: a.type || null,
    category: a.category || 'semantic',
    confidence: (a.confidence !== undefined && a.confidence !== null) ? Number(a.confidence) : null,
    memory_type: a.memory_type || 'user',
    access_count: 0,
    last_accessed_at: now,
    expires_at: a.expires_at || null,
    source: util.normalizeSource(a.source, 'add')
  };
  // v1.5.0: session 级记忆自动过期（session_ttl_hours>0 且未显式设 expires_at 时）
  if (a.session && !a.expires_at && config.CONFIG.session_ttl_hours > 0) {
    doc.expires_at = new Date(Date.now() + config.CONFIG.session_ttl_hours * 3600000).toISOString();
  }
  if (config.CONFIG.embedding_url) { try { doc.embedding = await embed.embed(a.content); } catch (e) {} }
  await graph.attachGraph(doc, a.content);
  // v1.5.2: 若 KG 抽取（extractGraph）未得到实体，用事实抽取阶段的 fact_entities 兜底填 entity_names，
  // 保证云端模型（如 deepseek-v4-flash/pro，KG 任务保守常留空）也能有实体用于检索加权与图谱起点。
  if ((!doc.entity_names || doc.entity_names.length === 0) && Array.isArray(a.fact_entities) && a.fact_entities.length) {
    const names = a.fact_entities
      .map(e => (typeof e === 'string' ? e : (e && (e.name || e.canonical))))
      .filter(Boolean).map(String).map(s => s.trim()).filter(Boolean);
    if (names.length) {
      doc.entity_names = Array.from(new Set(names));
      if (!doc.entities || doc.entities.length === 0) {
        doc.entities = doc.entity_names.map(n => ({ type: 'other', name: n, canonical: n }));
      }
    }
  }

  // 记忆去重 / 合并：相似内容合并到已有记忆，避免重复条目
  const mergeAllowed = (a.merge !== undefined) ? a.merge : config.CONFIG.dedup_enabled;
  if (mergeAllowed && config.CONFIG.embedding_url && doc.embedding) {
    const hit = await backend.dedupFind(doc.embedding, { user: a.user, project: a.project, session: a.session });
    if (hit && hit.similarity >= config.CONFIG.dedup_threshold) {
      const srcTags = (hit.source && hit.source.tags) ? hit.source.tags : [];
      const mergedTags = Array.from(new Set([...(srcTags || []), ...(a.tags || [])]));
      const patch = {
        content: a.content,
        project: a.project || null,
        session: a.session || null,
        tags: mergedTags,
        updated_at: now,
        fact_entities: a.fact_entities
      };
      const updated = await doUpdate(hit.id, patch);
      return { id: hit.id, merged: true, merged_from: hit.id, similarity: hit.similarity, ...updated };
    }
  }

  if (config.CONFIG.es_url && config.client) {
    await config.client.index({ index: config.CONFIG.es_index, id, document: doc });
  } else {
    backend.sqliteAdd(doc);
  }
  // 生命周期：过期自动清理
  if (config.CONFIG.lifecycle_policy === 'expire' && config.CONFIG.expiry_days > 0) {
    try { await cleanupExpired(); } catch (e) {}
  }
  backend.refreshEntityVocab().catch(() => {}); // v1.5.0: 写入后刷新实体词汇表（实体链接加权用）
  return { id, ...doc };
}

async function searchProject(project, a, vec) {
  const fa = Object.assign({}, a, { project });
  const filter = backend.filters(fa);
  filter.push(...backend.timeFilter(fa));
  const mode = a.mode || 'keyword';
  const top_k = a.top_k || 5;
  if (mode === 'keyword') {
    const must = a.query ? [{ match: { content: a.query } }] : [{ match_all: {} }];
    const body = { query: { bool: { must, filter } }, size: top_k };
    return intelligence.applyRecency(intelligence.rerankWithContext(backend.hitsToRows(await config.client.search({ index: config.CONFIG.es_index, body })), a.query || ''));
  }
  if (mode === 'semantic') {
    const v = vec || await embed.embed(a.query);
    const body = { query: { bool: { filter } }, knn: { field: 'embedding', query_vector: v, k: top_k, num_candidates: 100 }, size: top_k };
    return intelligence.applyRecency(intelligence.rerankWithContext(backend.hitsToRows(await config.client.search({ index: config.CONFIG.es_index, body })), a.query || ''));
  }
  const v = vec || await embed.embed(a.query);
  const kwBody = { query: { bool: { must: a.query ? [{ match: { content: a.query } }] : [{ match_all: {} }], filter } }, size: top_k };
  const knnBody = { query: { bool: { filter } }, knn: { field: 'embedding', query_vector: v, k: top_k, num_candidates: 100 }, size: top_k };
  const [kwRes, knnRes] = await Promise.all([
    config.client.search({ index: config.CONFIG.es_index, body: kwBody }),
    config.client.search({ index: config.CONFIG.es_index, body: knnBody }),
  ]);
  const K = 60;
  const merged = new Map();
  const add = (hits) => hits.forEach((h, i) => {
    const id = h._id;
    const rrf = 1 / (K + i + 1);
    if (merged.has(id)) merged.get(id).score += rrf;
    else merged.set(id, { id, score: rrf, content: h._source.content, user: h._source.user,
      project: h._source.project, session: h._source.session, tags: h._source.tags || [], created_at: h._source.created_at, updated_at: h._source.updated_at,
      entity_names: h._source.entity_names || [],
      type: h._source.type || null,
      category: h._source.category || 'semantic',
      confidence: (h._source.confidence !== undefined && h._source.confidence !== null) ? Number(h._source.confidence) : null,
      access_count: (h._source.access_count !== undefined && h._source.access_count !== null) ? Number(h._source.access_count) : 0,
      last_accessed_at: h._source.last_accessed_at || null,
      memory_type: h._source.memory_type || 'user',
      expires_at: h._source.expires_at || null });
  });
  add(kwRes.hits.hits);
  add(knnRes.hits.hits);
  return intelligence.applyRecency(intelligence.rerankWithContext([...merged.values()].sort((x, y) => y.score - x.score), a.query || '')).slice(0, top_k);
}

async function doSearch(a) {
  // v1.7.0 修复③：跨项目借鉴的记忆(related_project)属于其它项目，不应对其做访问强化——
  // 否则在 A 项目检索会"刷新"B 项目记忆的 last_accessed_at，使其在本项目常驻新鲜、recency 永不衰减。
  const finish = (res) => { if (res && res.length) backend.bumpAccess(res.filter(r => !r.related_project).map(r => r.id)).catch(() => {}); return res; };
  // SQLite 路径：主项目 + 关联项目(按强度衰减)
  if (!config.CONFIG.es_url || !config.client) {
    let rows = await sqliteSearch(a);
    if (util.relEnabled(a) && a.project) {
      const links = projects.getProjectLinks(a.project);
      for (const lk of links) {
        const rel = await sqliteSearch(Object.assign({}, a, { project: lk.to_project }));
        const decay = util.relationDecay(lk.strength);
        rel.forEach(r => { r.related_project = lk.to_project; r.relation_strength = lk.strength; r.relation_note = lk.note || null; r.score = (r.score != null ? r.score : 1) * decay; });
        rows = rows.concat(rel);
      }
      rows.sort((x, y) => (y.score || 0) - (x.score || 0));
    }
    return finish(rows);
  }
  const mode = a.mode || 'keyword';
  const needVec = (mode === 'semantic' || mode === 'hybrid');
  if (needVec && !config.CONFIG.embedding_url) throw new Error('semantic/hybrid requires embedding_url (not configured). Use mode=keyword.');
  const vec = needVec ? await embed.embed(a.query) : null;
  let rows = await searchProject(a.project || null, a, vec);
  if (util.relEnabled(a) && a.project) {
    const links = projects.getProjectLinks(a.project);
    for (const lk of links) {
      const rel = await searchProject(lk.to_project, a, vec);
      const decay = util.relationDecay(lk.strength);
      rel.forEach(r => { r.related_project = lk.to_project; r.relation_strength = lk.strength; r.relation_note = lk.note || null; r.score = (r.score != null ? r.score : 1) * decay; });
      rows = rows.concat(rel);
    }
    rows.sort((x, y) => (y.score || 0) - (x.score || 0));
  }
  return finish(rows);
}

async function doList(a) {
  const listProject = async (project) => {
    if (!config.CONFIG.es_url || !config.client) return sqliteList(Object.assign({}, a, { project }));
    const fa = Object.assign({}, a, { project });
    const filter = backend.filters(fa); filter.push(...backend.timeFilter(fa));
    const body = { query: { bool: { filter } }, sort: [{ updated_at: { order: 'desc' } }], size: a.limit || 20 };
    const res = await config.client.search({ index: config.CONFIG.es_index, body });
    return backend.hitsToRows(res);
  };
  // v1.7.0 修复①补充：doList 走 bool.filter 查询，ES 返回的 _score 恒为 0；
  // 若不归一化，关联记忆的 *decay 会变成 0*decay=0，衰减失效、与 doSearch 语义不一致。
  // 故主项目记忆基准分=1，关联记忆基准分=decay（与 doSearch 对齐：借来的记忆更弱、排在后面）。
  const baseScore = (r) => (typeof r.score === 'number' && r.score > 0 ? r.score : 1);
  let rows = (await listProject(a.project || null)).map(r => { r.related_project = null; r.score = baseScore(r); return r; });
  if (util.relEnabled(a) && a.project) {
    const links = projects.getProjectLinks(a.project);
    for (const lk of links) {
      const rel = await listProject(lk.to_project);
      const decay = util.relationDecay(lk.strength);
      rel.forEach(r => { r.related_project = lk.to_project; r.relation_strength = lk.strength; r.relation_note = lk.note || null; r.score = baseScore(r) * decay; });
      rows = rows.concat(rel);
    }
  }
  rows.sort((x, y) => new Date(y.updated_at || 0) - new Date(x.updated_at || 0));
  return intelligence.applyRecency(intelligence.rerankWithContext(rows, '')).slice(0, a.limit || 20);
}

async function doDelete(id) {
  if (!config.CONFIG.es_url || !config.client) { backend.sqliteDelete(id); return; }
  await config.client.delete({ index: config.CONFIG.es_index, id });
}

async function doUpdate(id, patch) {
  const now = new Date().toISOString();
  if (!config.CONFIG.es_url || !config.client) {
    const prev = backend.sqliteGet(id);
    const sets = [], params = [];
    if (patch.content !== undefined) { sets.push('content=?'); params.push(patch.content); }
    if (patch.project !== undefined) { sets.push('project=?'); params.push(patch.project || null); }
    if (patch.session !== undefined) { sets.push('session=?'); params.push(patch.session || null); }
    if (patch.tags !== undefined) { sets.push('tags=?'); params.push(JSON.stringify(patch.tags || [])); }
    if (patch.updated_at !== undefined) { sets.push('updated_at=?'); params.push(patch.updated_at); }
    else { sets.push('updated_at=?'); params.push(now); }
    if (config.CONFIG.embedding_url && patch.content !== undefined) {
      try { const v = await embed.embed(patch.content); sets.push('embedding=?'); params.push(JSON.stringify(v)); } catch (e) {}
    }
    if (config.CONFIG.kg_enabled && patch.content !== undefined) {
      let gEntities = null, gRelations = null, gNames = [];
      try { const g = await graph.extractGraph(patch.content); gEntities = g.entities; gRelations = g.relations; gNames = g.entity_names || []; } catch (e) {}
      // v1.5.3: 若 KG 抽取（extractGraph）未得到实体，用事实抽取阶段的 fact_entities 兜底（与 doAdd 一致）
      if ((!gNames || gNames.length === 0) && Array.isArray(patch.fact_entities) && patch.fact_entities.length) {
        const names = patch.fact_entities.map(e => (typeof e === 'string' ? e : (e && (e.name || e.canonical)))).filter(Boolean).map(String).map(s => s.trim()).filter(Boolean);
        if (names.length) {
          gNames = Array.from(new Set(names));
          if (!gEntities || gEntities.length === 0) gEntities = gNames.map(n => ({ type: 'other', name: n, canonical: n }));
        }
      }
      sets.push('entities=?'); params.push(JSON.stringify(gEntities));
      sets.push('relations=?'); params.push(JSON.stringify(gRelations));
      sets.push('entity_names=?'); params.push(JSON.stringify(gNames || []));
    }
    if (patch.type !== undefined) { sets.push('type=?'); params.push(patch.type || null); }
    if (patch.category !== undefined) { sets.push('category=?'); params.push(patch.category || 'semantic'); }
    if (patch.confidence !== undefined) { sets.push('confidence=?'); params.push(patch.confidence); }
    if (patch.memory_type !== undefined) { sets.push('memory_type=?'); params.push(patch.memory_type); }
    if (patch.access_count !== undefined) { sets.push('access_count=?'); params.push(patch.access_count); }
    if (patch.last_accessed_at !== undefined) { sets.push('last_accessed_at=?'); params.push(patch.last_accessed_at); }
    if (patch.expires_at !== undefined) { sets.push('expires_at=?'); params.push(patch.expires_at || null); }
    if (patch.correction_count !== undefined) { sets.push('correction_count=?'); params.push(patch.correction_count); }
    if (patch.corrected_at !== undefined) { sets.push('corrected_at=?'); params.push(patch.corrected_at || null); }
    if (patch.source !== undefined) { sets.push('source=?'); params.push(patch.source ? JSON.stringify(patch.source) : null); }
    const history = (prev.history || []).slice();
    if (patch.content !== undefined && patch.content !== prev.content) {
      history.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
    }
    sets.push('history=?'); params.push(JSON.stringify(history.slice(-10)));
    params.push(id);
    const d = backend.sqliteInit();
    d.prepare('UPDATE memories SET ' + sets.join(', ') + ' WHERE id=?').run(...params);
    backend.refreshEntityVocab().catch(() => {});
    return backend.sqliteGet(id);
  }
  const cur = await config.client.get({ index: config.CONFIG.es_index, id });
  const prev = cur._source;
  const doc = {};
  if (patch.content !== undefined) doc.content = patch.content;
  if (patch.project !== undefined) doc.project = patch.project || null;
  if (patch.session !== undefined) doc.session = patch.session || null;
  if (patch.tags !== undefined) doc.tags = patch.tags || [];
  if (patch.updated_at !== undefined) doc.updated_at = patch.updated_at;
  else doc.updated_at = now;
  if (config.CONFIG.embedding_url && patch.content !== undefined) { try { doc.embedding = await embed.embed(patch.content); } catch (e) {} }
  if (config.CONFIG.kg_enabled && patch.content !== undefined) {
    let gEntities = null, gRelations = null, gNames = [];
    try { const g = await graph.extractGraph(patch.content); gEntities = g.entities; gRelations = g.relations; gNames = g.entity_names || []; } catch (e) {}
    if ((!gNames || gNames.length === 0) && Array.isArray(patch.fact_entities) && patch.fact_entities.length) {
      const names = patch.fact_entities.map(e => (typeof e === 'string' ? e : (e && (e.name || e.canonical)))).filter(Boolean).map(String).map(s => s.trim()).filter(Boolean);
      if (names.length) {
        gNames = Array.from(new Set(names));
        if (!gEntities || gEntities.length === 0) gEntities = gNames.map(n => ({ type: 'other', name: n, canonical: n }));
      }
    }
    doc.entities = gEntities; doc.relations = gRelations; doc.entity_names = gNames || [];
  }
  if (patch.type !== undefined) doc.type = patch.type || null;
  if (patch.category !== undefined) doc.category = patch.category || 'semantic';
  if (patch.confidence !== undefined) doc.confidence = patch.confidence;
  if (patch.memory_type !== undefined) doc.memory_type = patch.memory_type;
  if (patch.access_count !== undefined) doc.access_count = patch.access_count;
  if (patch.last_accessed_at !== undefined) doc.last_accessed_at = patch.last_accessed_at;
  if (patch.expires_at !== undefined) doc.expires_at = patch.expires_at || null;
  if (patch.correction_count !== undefined) doc.correction_count = patch.correction_count;
  if (patch.corrected_at !== undefined) doc.corrected_at = patch.corrected_at;
  if (patch.source !== undefined) doc.source = util.normalizeSource(patch.source);
  const prevHistory = (prev.history || []);
  if (patch.content !== undefined && patch.content !== prev.content) {
    const hist = prevHistory.slice();
    hist.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
    doc.history = hist.slice(-10);
  }
  await config.client.update({ index: config.CONFIG.es_index, id, doc });
  backend.refreshEntityVocab().catch(() => {});
  return { id, ...doc };
}

// ---- SQLite 检索（ES 不可用时的降级路径，被 doSearch/doList 复用）----
function sqliteList(a) {
  const d = backend.sqliteInit();
  const where = [], params = [];
  if (a.user) { where.push('user=?'); params.push(a.user); }
  if (a.project) { where.push('project=?'); params.push(a.project); }
  if (a.session) { where.push('session=?'); params.push(a.session); }
  if (a.from) { where.push('updated_at >= ?'); params.push(a.from); }
  if (a.to) { where.push('updated_at <= ?'); params.push(a.to); }
  if (a.type) { where.push('type=?'); params.push(a.type); }
  if (a.category) { where.push('category=?'); params.push(a.category); }
  if (a.memory_type) { where.push('memory_type=?'); params.push(a.memory_type); }
  if (a.min_confidence !== undefined && a.min_confidence !== null) { where.push('confidence >= ?'); params.push(Number(a.min_confidence)); }
  where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(new Date().toISOString());
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const rows = d.prepare('SELECT * FROM memories' + clause + ' ORDER BY updated_at DESC').all(...params).map(backend.rowToDoc);
  return intelligence.applyRecency(intelligence.rerankWithContext(rows, a.query || '')).slice(0, a.limit || 20);
}

async function sqliteSearch(a) {
  const mode = a.mode || 'keyword';
  const top_k = a.top_k || 5;
  if ((mode === 'semantic' || mode === 'hybrid') && !config.CONFIG.embedding_url) {
    throw new Error('semantic/hybrid requires embedding_url (not configured). Use mode=keyword.');
  }
  const d = backend.sqliteInit();
  const where = [], params = [];
  if (a.user) { where.push('user=?'); params.push(a.user); }
  if (a.project) { where.push('project=?'); params.push(a.project); }
  if (a.session) { where.push('session=?'); params.push(a.session); }
  if (a.from) { where.push('updated_at >= ?'); params.push(a.from); }
  if (a.to) { where.push('updated_at <= ?'); params.push(a.to); }
  if (a.type) { where.push('type=?'); params.push(a.type); }
  if (a.category) { where.push('category=?'); params.push(a.category); }
  if (a.memory_type) { where.push('memory_type=?'); params.push(a.memory_type); }
  if (a.min_confidence !== undefined && a.min_confidence !== null) { where.push('confidence >= ?'); params.push(Number(a.min_confidence)); }
  where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(new Date().toISOString());
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  if (mode === 'keyword') {
    const q = (a.query || '').trim();
    if (!q) {
      const rows = d.prepare('SELECT * FROM memories' + clause + ' ORDER BY updated_at DESC').all(...params);
      return intelligence.applyRecency(intelligence.rerankWithContext(rows.map(r => ({ ...backend.rowToDoc(r), score: 1 })), a.query || '')).slice(0, top_k);
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const like = where.length ? where.map(w => w + ' AND content LIKE ?').join(' AND ') : 'content LIKE ?';
    const lp = params.slice();
    terms.forEach(t => lp.push('%' + t + '%'));
    const rows = d.prepare('SELECT * FROM memories WHERE ' + like).all(...lp);
    const scored = rows.map(r => { let sc = 0; terms.forEach(t => { if (r.content && r.content.includes(t)) sc++; }); return { ...backend.rowToDoc(r), score: sc }; });
    return intelligence.applyRecency(intelligence.rerankWithContext(scored, a.query || '')).slice(0, top_k);
  }
  const vec = await embed.embed(a.query);
  const all = d.prepare('SELECT * FROM memories' + clause).all(...params);
  const withVec = all.filter(r => r.embedding).map(r => ({ r, v: JSON.parse(r.embedding) }));
  const sem = withVec.map(({ r, v }) => ({ ...backend.rowToDoc(r), score: util.cosine(vec, v) }))
    .sort((x, y) => y.score - x.score);
  if (mode === 'semantic') return intelligence.applyRecency(intelligence.rerankWithContext(sem, a.query || '')).slice(0, top_k);
  let kwRows = [];
  const q = (a.query || '').trim();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    const like = where.length ? where.map(w => w + ' AND content LIKE ?').join(' AND ') : 'content LIKE ?';
    const lp = params.slice();
    terms.forEach(t => lp.push('%' + t + '%'));
    kwRows = d.prepare('SELECT * FROM memories WHERE ' + like).all(...lp)
      .map(r => { let sc = 0; terms.forEach(t => { if (r.content && r.content.includes(t)) sc++; }); return { ...backend.rowToDoc(r), score: sc }; });
  }
  const K = 60;
  const merged = new Map();
  const add = (list) => list.forEach((item, i) => {
    const cur = merged.get(item.id) || { ...item, score: 0 };
    cur.score += 1 / (K + i + 1);
    merged.set(item.id, cur);
  });
  add(kwRows); add(sem);
  return intelligence.applyRecency(intelligence.rerankWithContext([...merged.values()].sort((x, y) => y.score - x.score), a.query || '')).slice(0, top_k);
}

// v1.8.0 修复②：生命周期清理——过期(expires_at<now)或(无 expires_at 且 updated_at<cutoff) 的记忆才删，
// 不再只按 updated_at（否则 session/TTL 过期记忆被 filters 隐藏却永不真正删除，索引膨胀）。
async function cleanupExpired() {
  if (!(config.CONFIG.expiry_days > 0)) return 0;
  const cutoff = new Date(Date.now() - config.CONFIG.expiry_days * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  if (config.CONFIG.es_url && config.client) {
    try {
      const r = await config.client.deleteByQuery({ index: config.CONFIG.es_index, body: { query: { bool: { should: [
        { range: { expires_at: { lt: nowIso } } },
        { bool: { must_not: { exists: { field: 'expires_at' } } }, range: { updated_at: { lt: cutoff } } }
      ], minimum_should_match: 1 } } } });
      return r.deleted || 0;
    } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const res = d.prepare('DELETE FROM memories WHERE expires_at < ? OR (expires_at IS NULL AND updated_at < ?)').run(nowIso, cutoff);
  return res.changes;
}
async function purgeMemories(scope) {
  scope = scope || {};
  const days = scope.days || config.CONFIG.expiry_days;
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  if (config.CONFIG.es_url && config.client) {
    // 注意：不能用 backend.filters(scope)——它会注入「隐藏过期项」的 expires_at should 子句，与本清理条件互斥导致 0 删除。
    // 这里仅按 scope 维度(用户/项目/会话) + 过期/陈旧条件手动构建。
    const f = [];
    if (scope.user) f.push({ term: { user: scope.user } });
    if (scope.project) f.push({ term: { project: scope.project } });
    if (scope.session) f.push({ term: { session: scope.session } });
    f.push({ bool: { should: [
      { range: { expires_at: { lt: nowIso } } },
      { bool: { must_not: { exists: { field: 'expires_at' } } }, range: { updated_at: { lt: cutoff } } }
    ], minimum_should_match: 1 } });
    try { const r = await config.client.deleteByQuery({ index: config.CONFIG.es_index, body: { query: { bool: { filter: f } } } }); return r.deleted || 0; } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const where = ['(expires_at < ? OR (expires_at IS NULL AND updated_at < ?))'], params = [nowIso, cutoff];
  if (scope.user) { where.push('user=?'); params.push(scope.user); }
  if (scope.project) { where.push('project=?'); params.push(scope.project); }
  if (scope.session) { where.push('session=?'); params.push(scope.session); }
  const res = d.prepare('DELETE FROM memories WHERE ' + where.join(' AND ')).run(...params);
  return res.changes;
}

// v1.8.0 B1 辅助：按 id 读取完整记忆（ES / SQLite 双路径）
async function getMemory(id) {
  if (config.CONFIG.es_url && config.client) {
    const r = await config.client.get({ index: config.CONFIG.es_index, id });
    return { id: r._id, ...r._source };
  }
  return backend.sqliteGet(id);
}
// v1.8.0 B1 辅助：纠正计数 +1（通过 doUpdate 的 correction_count 补丁）
async function bumpCorrection(id) {
  const cur = await getMemory(id);
  const n = (cur.correction_count || 0) + 1;
  return await doUpdate(id, { correction_count: n });
}

// 指标装饰器：透明包裹核心操作，采集计数/延迟/错误率（不影响原逻辑）
function track(name, fn) {
  return async function (...args) {
    const t0 = Date.now();
    try {
      const r = await fn.apply(this, args);
      quality.recordOp(name, Date.now() - t0, false);
      return r;
    } catch (e) {
      quality.recordOp(name, Date.now() - t0, true);
      throw e;
    }
  };
}

module.exports = {
  doAdd: track('add', doAdd),
  doUpdate: track('update', doUpdate),
  doDelete: track('delete', doDelete),
  doSearch: track('search', doSearch),
  doList: track('list', doList),
  doListRaw: doList,
  searchProject,
  sqliteList,
  sqliteSearch,
  cleanupExpired: track('cleanup', cleanupExpired),
  purgeMemories: track('purge', purgeMemories),
  getMemory,
  bumpCorrection,
};
