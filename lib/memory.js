// 记忆操作层（核心数据 ops，MCP + REST 共用）：doAdd/doUpdate/doDelete/doSearch/doList
// + searchProject + sqliteList/sqliteSearch + cleanupExpired/purgeMemories + getMemory/bumpCorrection。
// v1.9.0：主存储由 Elasticsearch 切换为 Qdrant（向量+结构化 payload，过滤+语义检索）。
// 当 qdrant_url 未配置或无 embedding 时降级到本地 SQLite。依赖 backend/intelligence/projects/embed/graph/quality/util。
const crypto = require('crypto');
const config = require('./config');
const util = require('./util');
const intelligence = require('./intelligence');
const projects = require('./projects');
const embed = require('./embed');
const graph = require('./graph');
const quality = require('./quality');
const backend = require('./backend');
const qdrant = require('./qdrant');

// Qdrant 是否作为主存储：需配置 qdrant_url 且开启 embedding（语义检索依赖向量）
const Q = () => qdrant.useQdrant() && !!config.CONFIG.embedding_url;

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
  // v1.5.2: 若 KG 抽取（extractGraph）未得到实体，用事实抽取阶段的 fact_entities 兜底填 entity_names
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

  // 主存储：Qdrant（需向量）；否则本地 SQLite 降级
  if (Q() && doc.embedding) {
    const { embedding, ...payload } = doc;
    await qdrant.upsert([{ id, vector: embedding, payload }]);
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

// v1.9.0: Qdrant 检索（语义为主，keyword/hybrid 以语义候选 + 子串/词项加权实现）。
// 注：Qdrant 无原生 BM25，keyword 模式用「语义检索候选 + content/tags 子串命中过滤」近似；
// hybrid 用应用层 RRF 融合语义与关键词命中对（与旧 ES RRF 思路一致）。
// 仅当 Q()（qdrant_url + embedding 都已配置）时由 doSearch 调用。
async function searchProject(project, a, vec) {
  const fa = Object.assign({}, a, { project });
  const mode = a.mode || 'keyword';
  const top_k = a.top_k || 5;
  const v = vec || await embed.embed(a.query);
  const filter = backend.qdrantFilter(fa);
  const res = await qdrant.query({ vector: v, filter, limit: top_k });
  let rows = backend.pointsToRows(res);
  if (mode === 'keyword' || mode === 'hybrid') {
    const q = (a.query || '').trim();
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean).map(t => t.toLowerCase());
      const kwScore = (r) => {
        let s = 0;
        for (const t of terms) {
          if ((r.content || '').toLowerCase().includes(t)) s++;
          else if ((r.tags || []).some(tg => (tg || '').toLowerCase().includes(t))) s++;
        }
        return s;
      };
      const kwRanked = rows.map(r => ({ ...r, _kw: kwScore(r) })).filter(r => r._kw > 0).sort((x, y) => y._kw - x._kw);
      if (mode === 'keyword') {
        rows = kwRanked.length ? kwRanked.map(({ _kw, ...r }) => r) : rows;
      } else {
        const K = 60; const merged = new Map();
        const add = (list) => list.forEach((it, i) => {
          const cur = merged.get(it.id) || { ...it, score: 0 };
          cur.score += 1 / (K + i + 1);
          merged.set(it.id, cur);
        });
        add(rows.map(({ _kw, ...r }) => r));
        add(kwRanked.map(({ _kw, ...r }) => r));
        rows = [...merged.values()].sort((x, y) => y.score - x.score);
      }
    }
  }
  return intelligence.applyRecency(intelligence.rerankWithContext(rows, a.query || ''));
}

async function doSearch(a) {
  // v1.7.0 修复③：跨项目借鉴的记忆(related_project)属于其它项目，不应对其做访问强化
  const finish = (res) => { if (res && res.length) backend.bumpAccess(res.filter(r => !r.related_project).map(r => r.id)).catch(() => {}); return res; };
  // SQLite 降级路径（无 Qdrant 或无 embedding）：主项目 + 关联项目(按强度衰减)
  if (!Q()) {
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
    if (!Q()) return sqliteList(Object.assign({}, a, { project }));
    const fa = Object.assign({}, a, { project });
    const filter = backend.qdrantFilter(fa);
    const { points } = await qdrant.scroll({ filter, limit: a.limit || 20, withVector: false });
    let rows = backend.pointsToRows(points);
    rows.sort((x, y) => new Date(y.updated_at || 0) - new Date(x.updated_at || 0));
    return rows;
  };
  // v1.7.0 修复①补充：doList 走 scroll 过滤，Qdrant 返回顺序不保证按时间；
  // 关联记忆基准分=decay（与 doSearch 对齐：借来的记忆更弱、排在后面）。
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
  if (Q()) { await qdrant.deleteIds([id]); return; }
  backend.sqliteDelete(id);
}

async function doUpdate(id, patch) {
  const now = new Date().toISOString();
  if (!Q()) {
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
  const cur = await qdrant.get(id);
  if (!cur) { const e = new Error('not found'); e.statusCode = 404; throw e; }
  const prev = cur.payload;
  const payload = Object.assign({}, prev);
  if (patch.content !== undefined) payload.content = patch.content;
  if (patch.project !== undefined) payload.project = patch.project || null;
  if (patch.session !== undefined) payload.session = patch.session || null;
  if (patch.tags !== undefined) payload.tags = patch.tags || [];
  if (patch.updated_at !== undefined) payload.updated_at = patch.updated_at;
  else payload.updated_at = now;
  let vector = cur.vector;
  if (config.CONFIG.embedding_url && patch.content !== undefined) { try { vector = await embed.embed(patch.content); } catch (e) {} }
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
    payload.entities = gEntities; payload.relations = gRelations; payload.entity_names = gNames || [];
  }
  if (patch.type !== undefined) payload.type = patch.type || null;
  if (patch.category !== undefined) payload.category = patch.category || 'semantic';
  if (patch.confidence !== undefined) payload.confidence = patch.confidence;
  if (patch.memory_type !== undefined) payload.memory_type = patch.memory_type;
  if (patch.access_count !== undefined) payload.access_count = patch.access_count;
  if (patch.last_accessed_at !== undefined) payload.last_accessed_at = patch.last_accessed_at;
  if (patch.expires_at !== undefined) payload.expires_at = patch.expires_at || null;
  if (patch.correction_count !== undefined) payload.correction_count = patch.correction_count;
  if (patch.corrected_at !== undefined) payload.corrected_at = patch.corrected_at;
  // source 为 null/undefined 时不覆盖（保留既有溯源）；仅显式传入对象/字符串才归一化写入
  if (patch.source !== undefined && patch.source !== null) payload.source = util.normalizeSource(patch.source);
  const prevHistory = (prev.history || []) || [];
  if (patch.content !== undefined && patch.content !== prev.content) {
    const hist = prevHistory.slice();
    hist.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
    payload.history = hist.slice(-10);
  }
  await qdrant.upsert([{ id, vector, payload }]);
  backend.refreshEntityVocab().catch(() => {});
  return { id, ...payload };
}

// ---- SQLite 检索（Qdrant 不可用时的降级路径，被 doSearch/doList 复用）----
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

// v1.8.0 修复②：生命周期清理——过期(expires_at<now)或(无 expires_at 且 updated_at<cutoff) 的记忆才删
async function cleanupExpired() {
  if (!(config.CONFIG.expiry_days > 0)) return 0;
  const cutoff = new Date(Date.now() - config.CONFIG.expiry_days * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  if (Q()) {
    try {
      const [fa, fb] = expiredFilter(nowIso, cutoff);
      const c = (await qdrant.count(fa)) + (await qdrant.count(fb));
      await qdrant.deleteByFilter(fa);
      await qdrant.deleteByFilter(fb);
      return c;
    } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const res = d.prepare('DELETE FROM memories WHERE expires_at < ? OR (expires_at IS NULL AND updated_at < ?)').run(nowIso, cutoff);
  return res.changes;
}
// v1.9.0: 过期过滤器（Qdrant）：返回两个 must-only 过滤器（避免 should/min_should 非标准结构）。
// 分支A：expires_at 存在 且 < now；分支B：expires_at 缺失 且 updated_at < cutoff。
// 调用方对两个分支分别 count+delete（即 OR 语义）。
function expiredFilter(nowIso, cutoff) {
  const a = { must: [ { key: 'expires_at', range: { lt: nowIso } } ] };
  const b = { must: [ { is_empty: { key: 'expires_at', value: true } }, { key: 'updated_at', range: { lt: cutoff } } ] };
  return [a, b];
}
async function purgeMemories(scope) {
  scope = scope || {};
  const days = scope.days || config.CONFIG.expiry_days;
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  if (Q()) {
    // 仅按 scope 维度(用户/项目/会话) + 过期/陈旧条件构建（不同于 qdrantFilter 的「隐藏过期项」）。
    // 合并 scope 条件到两个过期分支各自的 must 中，分别 count+delete（OR 语义）。
    const scopeConds = [];
    if (scope.user) scopeConds.push({ key: 'user', match: { value: scope.user } });
    if (scope.project) scopeConds.push({ key: 'project', match: { value: scope.project } });
    if (scope.session) scopeConds.push({ key: 'session', match: { value: scope.session } });
    const [ea, eb] = expiredFilter(nowIso, cutoff);
    const fa = { must: scopeConds.concat(ea.must) };
    const fb = { must: scopeConds.concat(eb.must) };
    try { const c = (await qdrant.count(fa)) + (await qdrant.count(fb)); await qdrant.deleteByFilter(fa); await qdrant.deleteByFilter(fb); return c; } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const where = ['(expires_at < ? OR (expires_at IS NULL AND updated_at < ?))'], params = [nowIso, cutoff];
  if (scope.user) { where.push('user=?'); params.push(scope.user); }
  if (scope.project) { where.push('project=?'); params.push(scope.project); }
  if (scope.session) { where.push('session=?'); params.push(scope.session); }
  const res = d.prepare('DELETE FROM memories WHERE ' + where.join(' AND ')).run(...params);
  return res.changes;
}

// v1.8.0 B1 辅助：按 id 读取完整记忆（Qdrant / SQLite 双路径）
async function getMemory(id) {
  if (Q()) {
    const g = await qdrant.get(id);
    if (!g) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    return { id: g.id, ...g.payload };
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
