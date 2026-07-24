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
const webhook = require('./webhook'); // v1.12.0 (gap④)
const http = require('http');
const https = require('https');

// Qdrant 是否作为主存储：需配置 qdrant_url 且开启 embedding（语义检索依赖向量）
const Q = () => qdrant.useQdrant() && !!config.CONFIG.embedding_url;

// v1.9.1: 审计精简快照（只记关键字段，控制 changelog 体积）
function snapshot(p) {
  if (!p) return null;
  return {
    content: p.content,
    tags: p.tags || [],
    project: p.project || null,
    user: p.user || null,
    type: p.type || null,
    category: p.category || null,
    mem_category: p.mem_category || null,
    tier: p.tier || 'long',
    org: p.org || null,
    extract_version: p.extract_version || 'v1',
    actor_id: p.actor_id || null,
    agent_id: p.agent_id || null,
    run_id: p.run_id || null,
    confidence: (p.confidence !== undefined && p.confidence !== null) ? p.confidence : null,
    memory_type: p.memory_type || null,
    version: (p.version !== undefined && p.version !== null) ? Number(p.version) : 1,
    pinned: (p.pinned !== undefined && p.pinned !== null) ? !!p.pinned : false,
  };
}

async function doAdd(a) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // v1.11.0 (gap①): 短时工作记忆——独立缓冲，不污染长期库（跳过去重/FTS/KG/审计），可后续 promote。
  if (a.tier === 'working') {
    const wdoc = {
      id, content: a.content, user: a.user, project: a.project || null, session: a.session || null, org: a.org || null,
      tags: a.tags || [], created_at: now, expires_at: a.expires_at || null, memory_type: a.memory_type || 'user',
      meta: { source: util.normalizeSource(a.source, 'add'), mem_category: a.mem_category || null }
    };
    if (!wdoc.expires_at && config.CONFIG.working_ttl_hours > 0) {
      wdoc.expires_at = new Date(Date.now() + config.CONFIG.working_ttl_hours * 3600000).toISOString();
    }
    backend.addWorkingMemory(wdoc);
    webhook.emit('memory.added', { id, project: wdoc.project, user: wdoc.user, data: { content: wdoc.content, tier: 'working' } });
    return { id, working: true, tier: 'working', content: a.content };
  }
  const doc = {
    id,
    content: a.content, user: a.user, project: a.project || null, session: a.session || null,
    tags: a.tags || [], created_at: now, updated_at: now, history: [],
    type: a.type || null,
    category: a.category || 'semantic',
    mem_category: a.mem_category || null,
    tier: a.tier || 'long',
    org: a.org || null,
    extract_version: a.extract_version || config.CONFIG.extract_version || 'v1',
    actor_id: a.actor_id || null,
    agent_id: a.agent_id || null,
    run_id: a.run_id || null,
    confidence: (a.confidence !== undefined && a.confidence !== null) ? Number(a.confidence) : null,
    memory_type: a.memory_type || 'user',
    access_count: 0,
    last_accessed_at: now,
    expires_at: a.expires_at || null,
    version: 1,
    source: util.normalizeSource(a.source, 'add'),
    pinned: (a.pinned !== undefined && a.pinned !== null) ? !!a.pinned : false, // v1.13.0
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
    // v1.10.0(P3): 显式传 doc.project（含 null），dedupFind 始终按 project 作用域隔离，杜绝跨项目合并污染
    const hit = await backend.dedupFind(doc.embedding, { user: a.user, project: doc.project, session: a.session });
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
  // v1.10.0: FTS5 全文镜像 + 持久化图谱（独立于主存储，每次写都同步，便于 BM25 检索与图谱聚合）
  backend.ftsUpsert(id, doc.content, doc.tags, doc.project, doc.user, doc.session);
  backend.kgUpsert(id, doc.entities, doc.relations, doc.project);
  // v1.9.1: 审计——新增记忆独立记一条（merge 分支已在前面 return，不会到这里）
  backend.recordChangelog('ADD', {
    id, user: doc.user, project: doc.project,
    after: snapshot(doc), trigger: (doc.source && doc.source.trigger) || 'add'
  });
  webhook.emit('memory.added', { id, project: doc.project, user: doc.user, data: snapshot(doc) }); // v1.12.0 (gap④)
  // 生命周期：过期自动清理
  if (config.CONFIG.lifecycle_policy === 'expire' && config.CONFIG.expiry_days > 0) {
    try { await cleanupExpired(); } catch (e) {}
  }
  backend.addEntityVocab(doc.entity_names); // v1.10.0(P3): 增量更新实体词表，避免每次全量扫描 O(n)
  return { id, ...doc };
}

// v1.11.0 (gap④): token 用量估算（字符数/4 近似），用于 search/capture 响应回报。
function tokenEstimate(query, rows) {
  let n = Math.ceil((query || '').length / 4);
  for (const r of (rows || [])) n += Math.ceil(((r.content || '').length + ((r.tags || []).join(' ')).length) / 4);
  return n;
}
// v1.11.0 (gap④): 对检索结果做通用嵌套过滤（matchFilters）+ token 估算 + top_k 收敛，统一收口。
function finalize(rows, a) {
  if (a.filters) rows = rows.filter(r => backend.matchFilters(r, a.filters));
  const top_k = a.top_k || 5;
  rows = rows.slice(0, top_k);
  return { rows, usage: { tokens: tokenEstimate(a.query || '', rows) } };
}

// v1.13.0: 外部 re-ranker（cross-encoder）管线——将候选行 POST 到 reranker_url 做精排。
// 期望响应：JSON 数组 [{id,score}] 或 [{id,relevance_score}]。静默退化（失败则原序返回）。
async function _rerank(query, rows) {
  if (!query || !rows || !rows.length || !config.CONFIG.reranker_url) return rows;
  const urlStr = config.CONFIG.reranker_url;
  let u; try { u = new URL(urlStr); } catch (e) { return rows; }
  const mod = u.protocol === 'https:' ? https : http;
  try {
    const pairs = rows.map(r => ({ id: r.id, text: r.content || '', query }));
    const body = JSON.stringify({ model: config.CONFIG.reranker_model || 'default', pairs });
    const data = await new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''), method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          ...(config.CONFIG.reranker_api_key ? { 'Authorization': 'Bearer ' + config.CONFIG.reranker_api_key } : {}) },
        timeout: 5000,
      }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.write(body); req.end();
    });
    if (!data) return rows;
    const scores = JSON.parse(data);
    if (!Array.isArray(scores)) return rows;
    const scoreMap = new Map();
    for (const s of scores) {
      const id = s.id || s.document_id || null;
      const scr = s.score != null ? Number(s.score) : (s.relevance_score != null ? Number(s.relevance_score) : null);
      if (id && scr != null) scoreMap.set(id, scr);
    }
    if (!scoreMap.size) return rows;
    const reranked = rows.map(r => Object.assign({}, r, { score: scoreMap.has(r.id) ? (scoreMap.get(r.id) * 10) : (r.score || 0) }));
    reranked.sort((x, y) => (y.score || 0) - (x.score || 0));
    return reranked;
  } catch (e) { return rows; }
}
// 每条标准嵌入后对候选做相似度加权融合（Qdrant 路径每条标准一次向量查询；SQLite 路径直接 cosine）。
// 标准向量做进程内缓存（同一标准反复检索零额外嵌入开销）。
const _critCache = new Map();
async function _critVec(text) {
  if (_critCache.has(text)) return _critCache.get(text);
  const v = await embed.embed(text);
  _critCache.set(text, v);
  if (_critCache.size > 100) _critCache.delete(_critCache.keys().next().value);
  return v;
}
function _normCriteria(cr) {
  if (!cr) return [];
  if (typeof cr === 'string') { try { cr = JSON.parse(cr); } catch (e) { return []; } }
  if (!Array.isArray(cr)) return [];
  return cr.filter(c => c && (c.text || c.description || c.name))
    .map(c => ({ text: String(c.text || c.description || c.name), weight: (c.weight !== undefined && c.weight !== null) ? Number(c.weight) : 1 }));
}
async function applyCriteriaQdrant(rows, criteria, filter) {
  const crits = _normCriteria(criteria);
  if (!crits.length || !rows.length) return rows;
  for (const c of crits) {
    try {
      const v = await _critVec(c.text);
      const res = await qdrant.query({ vector: v, filter, limit: Math.max(rows.length * 2, 20) });
      const m = new Map(res.map(p => [p.id, (p.score != null) ? p.score : 0]));
      rows = rows.map(r => Object.assign({}, r, { score: (r.score != null ? r.score : 1) + c.weight * (m.get(r.id) || 0) }));
    } catch (e) {}
  }
  rows.sort((x, y) => (y.score || 0) - (x.score || 0));
  return rows;
}
async function applyCriteriaSqlite(rows, criteria) {
  const crits = _normCriteria(criteria);
  if (!crits.length || !rows.length || !config.CONFIG.embedding_url) return rows;
  try {
    const d = backend.sqliteInit();
    const ph = rows.map(() => '?').join(',');
    const embMap = new Map(d.prepare('SELECT id, embedding FROM memories WHERE id IN (' + ph + ')').all(...rows.map(r => r.id))
      .filter(r => r.embedding).map(r => [r.id, JSON.parse(r.embedding)]));
    for (const c of crits) {
      const v = await _critVec(c.text);
      rows = rows.map(r => { const e = embMap.get(r.id); return e ? Object.assign({}, r, { score: (r.score != null ? r.score : 1) + c.weight * util.cosine(v, e) }) : r; });
    }
    rows.sort((x, y) => (y.score || 0) - (x.score || 0));
  } catch (e) {}
  return rows;
}

// v1.10.0: FTS5 全文检索——在语义候选基础上做 BM25 硬过滤/精排，补上 Qdrant 缺失的原生 BM25。
// 语义召回放宽为 top_k*4 候选，再用 FTS 收敛（keyword 模式硬过滤 + hybrid 用 RRF 融合）。
async function ftsRankedCandidates(project, a, vec) {
  const top_k = a.top_k || 5;
  const mode = a.mode || 'keyword';
  const q = (a.query || '').trim();
  if ((mode === 'semantic') || !q) return null; // 纯语义模式或不带关键词时不走 FTS
  const ftsHits = backend.ftsSearch(q, (top_k * 6) || 30, project || null);
  // v1.11.0 修复：FTS 未命中时返回 null（而非 []），让 searchProject 回退到旧版子串匹配。
  // 关键原因：FTS5 unicode61 分词器无法切分嵌在中文里的拉丁词（如「用Rust写」会整体成一个 token），
  // CJK 文本上 keyword 检索几乎必然 FTS 落空；原先返回 [] 会导致下游 ftsMap.has(...) 抛
  // 「ftsMap.has is not a function」并使中文关键词检索失效。返回 null → 走子串匹配分支恢复检索。
  if (!ftsHits.length) return null;
  return new Map(ftsHits.map(h => [h.id, h.score]));
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
  const ftsMap = await ftsRankedCandidates(project, a, v); // 可能为 null（不启用 FTS）/ []（空） / Map
  const filter = backend.qdrantFilter(fa);
  const res = await qdrant.query({ vector: v, filter, limit: (a.filters ? (top_k * 20) : (top_k * 4)) || 20 });
  let rows = backend.pointsToRows(res);
  if (ftsMap === null) {
    // 不启用 FTS，沿用旧子串加权
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
    let out1 = intelligence.applyRecency(intelligence.rerankWithContext(rows, a.query || ''));
    if (a.criteria) out1 = await applyCriteriaQdrant(out1, a.criteria, filter); // v1.12.0 (gap③)
    return finalize(out1, a);
  }
  // v1.10.0: 用 FTS 结果收敛语义候选
  if (mode === 'keyword') {
    rows = rows.filter(r => ftsMap.has(r.id)); // 硬过滤：必须命中关键词
  }
  // hybrid / keyword 都给命中 FTS 的候选加 BM25 分（叠加在 score 上）
  rows = rows.map(r => {
    const fs = ftsMap.has(r.id) ? ftsMap.get(r.id) : 0;
    return Object.assign({}, r, { score: (r.score != null ? r.score : 1) + (fs || 0) * 0.5 });
  });
  if (mode === 'hybrid') {
    // 额外：FTS 命中但未被语义召回 topN 的，也补进来（RRF 融合）
    const semIds = new Set(rows.map(r => r.id));
    const extra = [];
    for (const [id, fs] of ftsMap) {
      if (!semIds.has(id)) {
        // 需从 Qdrant 取该点（轻量 get）
        try { const g = await qdrant.get(id); if (g && g.payload) extra.push(backend.payloadToRow(id, fs * 0.5, g.payload)); } catch (e) {}
      }
    }
    rows = rows.concat(extra);
  }
  let out2 = intelligence.applyRecency(intelligence.rerankWithContext(rows, a.query || ''));
  if (a.criteria) out2 = await applyCriteriaQdrant(out2, a.criteria, filter); // v1.12.0 (gap③)
  return finalize(out2, a);
}

async function doSearch(a) {
  // v1.7.0 修复③：跨项目借鉴的记忆(related_project)属于其它项目，不应对其做访问强化
  const finish = (rows) => { if (rows && rows.length) backend.bumpAccess(rows.filter(r => !r.related_project && r.tier !== 'working').map(r => r.id)).catch(() => {}); return rows; };
  // v1.12.0 (gap①/③): 未显式传 criteria/extract 时，注入项目级持久配置的默认 criteria
  if (!a.criteria && a.project) {
    try { const pc = backend.projectConfigGet(a.project); if (pc && pc.criteria) a = Object.assign({}, a, { criteria: pc.criteria }); } catch (e) {}
  }
  let allRows = [], usages = [];
  if (!Q()) {
    // v1.12.0 修复：sqliteSearch 是 async，此前漏 await 导致 SQLite 降级路径拿到 Promise（rows/usage 均 undefined）
    let rows = await sqliteSearch(a); usages.push(rows.usage);
    let rr = rows.rows;
    if (a.criteria) rr = await applyCriteriaSqlite(rr, a.criteria); // v1.12.0 (gap③) SQLite 路径
    allRows = finish(rr);
  } else {
    const mode = a.mode || 'keyword';
    const needVec = (mode === 'semantic' || mode === 'hybrid');
    if (needVec && !config.CONFIG.embedding_url) throw new Error('semantic/hybrid requires embedding_url (not configured). Use mode=keyword.');
    const vec = needVec ? await embed.embed(a.query) : null;
    const r = await searchProject(a.project || null, a, vec); usages.push(r.usage); allRows = finish(r.rows);
    if (util.relEnabled(a) && a.project) {
      const links = projects.getProjectLinks(a.project);
      for (const lk of links) {
        const rel = await searchProject(lk.to_project, a, vec); usages.push(rel.usage);
        const decay = util.relationDecay(lk.strength);
        rel.rows.forEach(x => { x.related_project = lk.to_project; x.relation_strength = lk.strength; x.relation_note = lk.note || null; x.score = (x.score != null ? x.score : 1) * decay; });
        allRows = allRows.concat(rel.rows);
      }
      allRows.sort((x, y) => (y.score || 0) - (x.score || 0));
    }
  }
  // v1.11.0 (gap④): 顶层再套一次嵌套过滤（覆盖 related 合并后的全集），并支持并入工作记忆
  if (a.include_working) {
    const wk = backend.listWorkingMemory({ project: a.project, session: a.session, user: a.user, org: a.org });
    if (wk.length) allRows = allRows.concat(wk.map(w => ({ ...w, tier: 'working', score: 0.5 })));
  }
  if (a.filters) allRows = allRows.filter(r => backend.matchFilters(r, a.filters));
  // v1.13.0: reranker 管线钩子（外部 cross-encoder 精排）
  if (allRows.length && config.CONFIG.reranker_url) allRows = await _rerank(a.query || '', allRows);
  // v1.13.0: MMR 多样性重排
  if (config.CONFIG.mmr_enabled && allRows.length > 1) allRows = intelligence.applyMMR(allRows, a.mmr_lambda);
  // v1.13.0: 游标分页——生成 next_cursor（基于 id 排序位置）
  const limit = a.top_k || a.limit || 5;
  const hasMore = allRows.length > limit;
  const nextCursor = hasMore ? allRows[limit].id : null;
  const tokens = usages.reduce((s, u) => s + (u ? u.tokens : 0), 0) + (a.include_working ? Math.ceil((a.query || '').length / 4) : 0);
  return { rows: allRows.slice(0, limit), next_cursor: nextCursor, usage: { tokens } };
}

async function doList(a) {
  const listProject = async (project) => {
    if (!Q()) return sqliteList(Object.assign({}, a, { project }));
    const fa = Object.assign({}, a, { project });
    const filter = backend.qdrantFilter(fa);
    // v1.11.0: 通用过滤器在 scroll 阶段用更宽 limit 拉取，再客户端过滤（避开 Qdrant should 非标准结构）
    const lim = a.filters ? (a.limit || 20) * 5 : (a.limit || 20);
    const { points } = await qdrant.scroll({ filter, limit: lim, withVector: false });
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
  // v1.11.0 (gap④): 客户端嵌套过滤 + include_working 并入 + 末次排序
  if (a.include_working) {
    const wk = backend.listWorkingMemory({ project: a.project, session: a.session, user: a.user, org: a.org });
    if (wk.length) rows = rows.concat(wk.map(w => ({ ...w, tier: 'working', score: 0.5 })));
  }
  if (a.filters) rows = rows.filter(r => backend.matchFilters(r, a.filters));
  const tokens = Math.ceil(rows.reduce((s, r) => s + (r.content || '').length, 0) / 4);
  // v1.10.0(P3): 末次排序改为「score 优先、updated_at 兜底」——让跨项目借鉴的衰减权重(relationDecay)
  // 真正生效，而非被时间排序覆盖（原 line 197/213 的 updated_at 排序属死代码）。
  rows.sort((x, y) => ((y.score || 0) - (x.score || 0)) || (new Date(y.updated_at || 0) - new Date(x.updated_at || 0)));
  let out = intelligence.applyRecency(intelligence.rerankWithContext(rows, ''));
  // v1.13.0: reranker 管线钩子（仅当有 query 时生效）
  if (out.length && config.CONFIG.reranker_url && a.query) out = await _rerank(a.query, out);
  // v1.13.0: MMR 多样性重排
  if (config.CONFIG.mmr_enabled && out.length > 1) out = intelligence.applyMMR(out, a.mmr_lambda);
  const limit = a.limit || 20;
  const hasMore = out.length > limit;
  const nextCursor = hasMore ? out[limit].id : null;
  return { rows: out.slice(0, limit), next_cursor: nextCursor, usage: { tokens } };
}

async function doDelete(id) {
  let before = null;
  try { const cur = await getMemory(id); before = snapshot(cur); } catch (e) {}
  if (Q()) { await qdrant.deleteIds([id]); }
  else { backend.sqliteDelete(id); }
  backend.ftsDelete(id); // v1.10.0: FTS 镜像同步删除
  // v1.9.1: 审计——删除前先取快照，独立账本记录（不被 upsert 覆盖）
  backend.recordChangelog('DELETE', { id, user: before && before.user, project: before && before.project, before });
  webhook.emit('memory.deleted', { id, project: before && before.project, user: before && before.user, data: before }); // v1.12.0 (gap④)
  return { id, deleted: true };
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
    if (patch.mem_category !== undefined) { sets.push('mem_category=?'); params.push(patch.mem_category || null); }
    if (patch.tier !== undefined) { sets.push('tier=?'); params.push(patch.tier || 'long'); }
    if (patch.org !== undefined) { sets.push('org=?'); params.push(patch.org || null); }
    if (patch.extract_version !== undefined) { sets.push('extract_version=?'); params.push(patch.extract_version || 'v1'); }
    if (patch.actor_id !== undefined) { sets.push('actor_id=?'); params.push(patch.actor_id || null); }
    if (patch.agent_id !== undefined) { sets.push('agent_id=?'); params.push(patch.agent_id || null); }
    if (patch.run_id !== undefined) { sets.push('run_id=?'); params.push(patch.run_id || null); }
    if (patch.pinned !== undefined) { sets.push('pinned=?'); params.push(patch.pinned ? 1 : 0); } // v1.13.0
    if (patch.memory_type !== undefined) { sets.push('memory_type=?'); params.push(patch.memory_type); }
    if (patch.access_count !== undefined) { sets.push('access_count=?'); params.push(patch.access_count); }
    if (patch.last_accessed_at !== undefined) { sets.push('last_accessed_at=?'); params.push(patch.last_accessed_at); }
    if (patch.expires_at !== undefined) { sets.push('expires_at=?'); params.push(patch.expires_at || null); }
    if (patch.correction_count !== undefined) { sets.push('correction_count=?'); params.push(patch.correction_count); }
    if (patch.corrected_at !== undefined) { sets.push('corrected_at=?'); params.push(patch.corrected_at || null); }
    if (patch.source !== undefined) { sets.push('source=?'); params.push(patch.source ? JSON.stringify(patch.source) : null); }
    const prevVersion = (prev.version || 1);
    sets.push('version=?'); params.push(patch.version !== undefined ? Number(patch.version) : prevVersion + 1);
    const history = (prev.history || []).slice();
    if (patch.content !== undefined && patch.content !== prev.content) {
      history.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
    }
    sets.push('history=?'); params.push(JSON.stringify(history.slice(-10)));
    params.push(id);
    const d = backend.sqliteInit();
    d.prepare('UPDATE memories SET ' + sets.join(', ') + ' WHERE id=?').run(...params);
    // v1.10.0: FTS 镜像 + 图谱 + 增量词表
    const uEnt = (patch.entities !== undefined) ? patch.entities : prev.entities;
    const uRel = (patch.relations !== undefined) ? patch.relations : prev.relations;
    const uNames = (patch.entity_names !== undefined) ? patch.entity_names : prev.entity_names;
    backend.ftsUpsert(id, patch.content !== undefined ? patch.content : prev.content,
      patch.tags !== undefined ? patch.tags : prev.tags, patch.project !== undefined ? patch.project : prev.project,
      prev.user, prev.session);
    backend.kgUpsert(id, uEnt, uRel, patch.project !== undefined ? patch.project : prev.project);
    backend.addEntityVocab(uNames);
    backend.recordChangelog((patch.correction_count !== undefined) ? 'CORRECT' : 'UPDATE', {
      id, user: prev.user, project: prev.project,
      before: snapshot(prev), after: snapshot(Object.assign({}, prev, patch)),
      trigger: (patch.correction_count !== undefined) ? 'correct' : 'update'
    });
    webhook.emit('memory.updated', { id, project: prev.project, user: prev.user, data: snapshot(Object.assign({}, prev, patch)) }); // v1.12.0
    return backend.sqliteGet(id);
  }
  // v1.9.1: 乐观重试——并发时每次重读最新 prev+version 再递增写回，避免 lost-update
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
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
    if (patch.mem_category !== undefined) payload.mem_category = patch.mem_category || null;
    if (patch.tier !== undefined) payload.tier = patch.tier || 'long';
    if (patch.org !== undefined) payload.org = patch.org || null;
    if (patch.extract_version !== undefined) payload.extract_version = patch.extract_version || 'v1';
    if (patch.actor_id !== undefined) payload.actor_id = patch.actor_id || null;   // v1.12.0 (gap②)
    if (patch.agent_id !== undefined) payload.agent_id = patch.agent_id || null;
    if (patch.run_id !== undefined) payload.run_id = patch.run_id || null;
    if (patch.pinned !== undefined) payload.pinned = !!patch.pinned; // v1.13.0 记忆固定
    if (patch.memory_type !== undefined) payload.memory_type = patch.memory_type;
    if (patch.access_count !== undefined) payload.access_count = patch.access_count;
    if (patch.last_accessed_at !== undefined) payload.last_accessed_at = patch.last_accessed_at;
    if (patch.expires_at !== undefined) payload.expires_at = patch.expires_at || null;
    if (patch.correction_count !== undefined) payload.correction_count = patch.correction_count;
    if (patch.corrected_at !== undefined) payload.corrected_at = patch.corrected_at;
    if (patch.source !== undefined && patch.source !== null) payload.source = util.normalizeSource(patch.source);
    const prevHistory = (prev.history || []) || [];
    if (patch.content !== undefined && patch.content !== prev.content) {
      const hist = prevHistory.slice();
      hist.push({ content: prev.content, tags: prev.tags || [], at: prev.updated_at || prev.created_at });
      payload.history = hist.slice(-10);
    }
    const prevVersion = (prev.version !== undefined && prev.version !== null) ? Number(prev.version) : 1;
    payload.version = prevVersion + 1;
    await qdrant.upsert([{ id, vector, payload }]);
    // v1.10.0: FTS 镜像 + 图谱 + 增量词表
    const qEnt = (patch.entities !== undefined) ? patch.entities : prev.entities;
    const qRel = (patch.relations !== undefined) ? patch.relations : prev.relations;
    const qNames = (patch.entity_names !== undefined) ? patch.entity_names : prev.entity_names;
    backend.ftsUpsert(id, payload.content, payload.tags, payload.project, payload.user, payload.session);
    backend.kgUpsert(id, qEnt, qRel, payload.project);
    backend.addEntityVocab(qNames);
    backend.recordChangelog((patch.correction_count !== undefined) ? 'CORRECT' : 'UPDATE', {
      id, user: prev.user, project: prev.project,
      before: snapshot(prev), after: snapshot(payload),
      trigger: (patch.correction_count !== undefined) ? 'correct' : 'update'
    });
    webhook.emit('memory.updated', { id, project: prev.project, user: prev.user, data: snapshot(payload) }); // v1.12.0 (gap④)
    return { id, ...payload };
  }
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
  if (a.actor_id) { where.push('actor_id=?'); params.push(a.actor_id); }   // v1.12.0 (gap②)
  if (a.agent_id) { where.push('agent_id=?'); params.push(a.agent_id); }
  if (a.run_id) { where.push('run_id=?'); params.push(a.run_id); }
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
  if (a.actor_id) { where.push('actor_id=?'); params.push(a.actor_id); }   // v1.12.0 (gap②)
  if (a.agent_id) { where.push('agent_id=?'); params.push(a.agent_id); }
  if (a.run_id) { where.push('run_id=?'); params.push(a.run_id); }
  if (a.min_confidence !== undefined && a.min_confidence !== null) { where.push('confidence >= ?'); params.push(Number(a.min_confidence)); }
  where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(new Date().toISOString());
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  if (mode === 'keyword') {
    const q = (a.query || '').trim();
    if (!q) {
      const rows = d.prepare('SELECT * FROM memories' + clause + ' ORDER BY updated_at DESC').all(...params);
      let _r1 = intelligence.applyRecency(intelligence.rerankWithContext(rows.map(r => ({ ...backend.rowToDoc(r), score: 1 })), a.query || '')).slice(0, top_k);
      if (a.filters) _r1 = _r1.filter(x => backend.matchFilters(x, a.filters));
      return { rows: _r1, usage: { tokens: tokenEstimate(a.query || '', _r1) } };
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const like = where.length ? where.map(w => w + ' AND content LIKE ?').join(' AND ') : 'content LIKE ?';
    const lp = params.slice();
    terms.forEach(t => lp.push('%' + t + '%'));
    const rows = d.prepare('SELECT * FROM memories WHERE ' + like).all(...lp);
    const scored = rows.map(r => { let sc = 0; terms.forEach(t => { if (r.content && r.content.includes(t)) sc++; }); return { ...backend.rowToDoc(r), score: sc }; });
    let _r2 = intelligence.applyRecency(intelligence.rerankWithContext(scored, a.query || '')).slice(0, top_k);
    if (a.filters) _r2 = _r2.filter(x => backend.matchFilters(x, a.filters));
    return { rows: _r2, usage: { tokens: tokenEstimate(a.query || '', _r2) } };
  }
  const vec = await embed.embed(a.query);
  const all = d.prepare('SELECT * FROM memories' + clause).all(...params);
  const withVec = all.filter(r => r.embedding).map(r => ({ r, v: JSON.parse(r.embedding) }));
  const sem = withVec.map(({ r, v }) => ({ ...backend.rowToDoc(r), score: util.cosine(vec, v) }))
    .sort((x, y) => y.score - x.score);
  if (mode === 'semantic') { let _r3 = intelligence.applyRecency(intelligence.rerankWithContext(sem, a.query || '')).slice(0, top_k); if (a.filters) _r3 = _r3.filter(x => backend.matchFilters(x, a.filters)); return { rows: _r3, usage: { tokens: tokenEstimate(a.query || '', _r3) } }; }
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
  let _r4 = intelligence.applyRecency(intelligence.rerankWithContext([...merged.values()].sort((x, y) => y.score - x.score), a.query || '')).slice(0, top_k);
  if (a.filters) _r4 = _r4.filter(x => backend.matchFilters(x, a.filters));
  return { rows: _r4, usage: { tokens: tokenEstimate(a.query || '', _r4) } };
}

// v1.8.0 修复②：生命周期清理——过期(expires_at<now)或(无 expires_at 且 updated_at<cutoff) 的记忆才删
async function cleanupExpired() {
  if (!(config.CONFIG.expiry_days > 0)) return 0;
  const cutoff = new Date(Date.now() - config.CONFIG.expiry_days * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  if (Q()) {
    try {
      const [fa, fb] = expiredFilter(nowIso, cutoff);
      const ids = (await qdrant.scrollAll(fa)).map(p => p.id).concat((await qdrant.scrollAll(fb)).map(p => p.id));
      const c = ids.length;
      await qdrant.deleteByFilter(fa);
      await qdrant.deleteByFilter(fb);
      // v1.9.1: 审计——生命周期清理独立记一条 CLEANUP（含删除数/ids）
      backend.recordChangelog('CLEANUP', { id: null, after: { deleted_count: c, deleted_ids: ids } });
      return c;
    } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const res = d.prepare("DELETE FROM memories WHERE (expires_at < ? OR (expires_at IS NULL AND updated_at < ?)) AND (pinned IS NULL OR pinned=0)").run(nowIso, cutoff);
  return res.changes;
}
// v1.9.0: 过期过滤器（Qdrant）：返回两个 must-only 过滤器（避免 should/min_should 非标准结构）。
// 分支A：expires_at 存在 且 < now；分支B：expires_at 缺失 且 updated_at < cutoff。
// 调用方对两个分支分别 count+delete（即 OR 语义）。
function expiredFilter(nowIso, cutoff) {
  const pinnedExclude = { key: 'pinned', match: { value: false } };
  const a = { must: [ { key: 'expires_at', range: { lt: nowIso } }, pinnedExclude ] };
  const b = { must: [ { is_empty: { key: 'expires_at', value: true } }, { key: 'updated_at', range: { lt: cutoff } }, pinnedExclude ] };
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
    try {
      const ids = (await qdrant.scrollAll(fa)).map(p => p.id).concat((await qdrant.scrollAll(fb)).map(p => p.id));
      const c = ids.length;
      await qdrant.deleteByFilter(fa); await qdrant.deleteByFilter(fb);
      backend.recordChangelog('CLEANUP', { id: null, user: scope.user, project: scope.project, after: { deleted_count: c, deleted_ids: ids } });
      return c;
    } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const where = ['(expires_at < ? OR (expires_at IS NULL AND updated_at < ?))', '(pinned IS NULL OR pinned = 0)'], params = [nowIso, cutoff];
  if (scope.user) { where.push('user=?'); params.push(scope.user); }
  if (scope.project) { where.push('project=?'); params.push(scope.project); }
  if (scope.session) { where.push('session=?'); params.push(scope.session); }
  const res = d.prepare('DELETE FROM memories WHERE ' + where.join(' AND ')).run(...params);
  return res.changes;
}

// v1.10.0: 记忆巩固 / 自动压缩——把同主题（共享实体/标签）的碎片化低 salience 记忆，
// 用 LLM 归纳成一条摘要记忆，原记忆标记 SUPERSEDED（过期隐藏，保留溯源与 changelog）。
// 可手动触发（POST /api/consolidate）或挂到 cleanup 周期；无 LLM 时退化为通用合并说明行。
async function consolidate(opts) {
  opts = opts || {};
  const project = opts.project || null;
  const minCluster = opts.min_cluster || 2;
  const maxPerRun = opts.max_per_run || 10;
  let mems = [];
  if (Q()) {
    const filter = project ? { must: [{ key: 'project', match: { value: project } }] } : {};
    const pts = await qdrant.scrollAll(filter);
    mems = pts.map(p => ({ id: p.id, ...p.payload }));
  } else {
    const d = backend.sqliteInit();
    const all = project ? d.prepare('SELECT * FROM memories WHERE project=?').all(project) : d.prepare('SELECT * FROM memories').all();
    mems = all.map(backend.rowToDoc);
  }
  const groups = new Map();
  for (const m of mems) {
    const key = (m.entity_names && m.entity_names[0]) || (m.tags && m.tags[0]) || null;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const results = [];
  for (const [key, list] of groups) {
    if (results.length >= maxPerRun) break;
    if (list.length < minCluster) continue;
    const low = list.filter(m => (typeof m.confidence === 'number' ? m.confidence : 0.5) < 0.7 || (Number(m.access_count) || 0) < 3);
    if (low.length < minCluster) continue;
    const contents = low.map(m => '- ' + (m.content || '')).join('\n');
    let summary = null;
    const url = config.CONFIG.llm_url || config.CONFIG.kg_url;
    if (url) {
      try {
        const c = await embed.chatJSON({ url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || config.CONFIG.kg_api_key || null,
          messages: [
            { role: 'system', content: '你是记忆巩固助手。把多条关于同一主题的记忆合并成一条简洁、去重、保留关键事实的摘要。只返回 JSON: {"summary":"..."}。保持原文语言。' },
            { role: 'user', content: '主题: ' + key + '\n记忆:\n' + contents } ], temperature: 0.2, jsonMode: true });
        if (c && c.summary) summary = String(c.summary).trim();
      } catch (e) {}
    }
    if (!summary) summary = '(自动合并) 关于「' + key + '」的记忆 ' + low.length + ' 条已归纳';
    const created = await doAdd({
      content: summary, project,
      user: low[0].user,
      tags: Array.from(new Set(['consolidated'].concat(low[0].tags || []))),
      memory_type: 'consolidated', category: 'summary',
      source: { trigger: 'consolidate', consolidated_from: low.map(m => m.id) }
    });
    for (const m of low) {
      try { await doUpdate(m.id, { expires_at: new Date().toISOString(), source: { trigger: 'consolidate', superseded_by: created.id } }); } catch (e2) {}
      backend.recordChangelog('SUPERSEDE', { id: m.id, project, before: snapshot(m), after: { superseded_by: created.id } });
    }
    webhook.emit('memory.consolidated', { id: created.id, project, user: low[0].user, data: { merged: low.length, from: low.map(m => m.id) } }); // v1.12.0 (gap④)
    results.push({ key, merged: low.length, summary, consolidated_id: created.id });
  }
  return { ok: true, consolidated: results.length, groups: groups.size, results };
}

// v1.11.0 (gap⑤): 批量新增 —— 循环 doAdd（working 记忆也支持，逐条走各自路由）。
async function batchAdd(items) {
  items = Array.isArray(items) ? items : [];
  const results = [];
  for (const it of items) {
    try { const r = await doAdd(it); results.push({ ok: true, id: r.id, merged: !!r.merged, working: !!r.working }); }
    catch (e) { results.push({ ok: false, error: String(e && e.message || e) }); }
  }
  return { added: results.filter(r => r.ok).length, results };
}

// v1.11.0 (gap⑤): 按通用过滤器批量删除（先拉候选，客户端 matchFilters 收敛，再逐条 doDelete）。
async function deleteByFilter(filtersObj, scope) {
  scope = scope || {};
  let rows = [];
  if (Q()) {
    const fa = backend.qdrantFilter(scope);
    const { points } = await qdrant.scroll({ filter: fa, limit: 1000, withVector: false });
    rows = (points || []).map(p => backend.payloadToRow(p.id, 1, p.payload));
  } else {
    const d = backend.sqliteInit();
    const where = [], params = [];
    if (scope.user) { where.push('user=?'); params.push(scope.user); }
    if (scope.project) { where.push('project=?'); params.push(scope.project); }
    if (scope.session) { where.push('session=?'); params.push(scope.session); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    rows = d.prepare('SELECT * FROM memories' + clause).all(...params).map(backend.rowToDoc);
  }
  const matched = (filtersObj ? rows.filter(r => backend.matchFilters(r, filtersObj)) : rows);
  const ids = [];
  for (const r of matched) { try { await doDelete(r.id); ids.push(r.id); } catch (e) {} }
  return { deleted: ids.length, ids };
}

// v1.11.0 (gap⑤): 重新抽取——对某条已有记忆用新文本重新抽取事实并更新（update(memory_id, text) 语义）。
async function reextractMemory(id, text, opts) {
  const cur = await getMemory(id);
  const patch = { content: text };
  if (config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
    try {
      const fcts = await facts.extractFacts(text, opts || {});
      if (fcts && fcts.length) {
        const f = fcts[0];
        patch.type = f.type; patch.category = f.category || 'semantic'; patch.mem_category = f.mem_category || 'fact';
        patch.confidence = f.confidence; patch.fact_entities = f.entities || [];
      }
    } catch (e) {}
  }
  return await doUpdate(id, patch);
}

// v1.11.0 (gap①): 短时工作记忆缓冲操作（独立于长期库）
async function addWorking(a) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const wdoc = { id, content: a.content, user: a.user, project: a.project || null, session: a.session || null, org: a.org || null,
    tags: a.tags || [], created_at: now, expires_at: a.expires_at || null, memory_type: a.memory_type || 'user',
    meta: { source: util.normalizeSource(a.source, 'add'), mem_category: a.mem_category || null } };
  if (!wdoc.expires_at && config.CONFIG.working_ttl_hours > 0) {
    wdoc.expires_at = new Date(Date.now() + config.CONFIG.working_ttl_hours * 3600000).toISOString();
  }
  backend.addWorkingMemory(wdoc);
  return { id, working: true, tier: 'working', content: a.content };
}
function listWorking(scope) { return backend.listWorkingMemory(scope || {}); }
function searchWorking(a) {
  const all = backend.listWorkingMemory({ project: a.project, session: a.session, user: a.user, org: a.org });
  const q = (a.query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter(r => (r.content || '').toLowerCase().includes(q) || (r.tags || []).some(t => (t || '').toLowerCase().includes(q)));
}
function deleteWorking(id) { return backend.deleteWorkingMemory(id); }
async function promoteWorking(id, opts) {
  const w = backend.getWorkingMemory(id);
  if (!w) { const e = new Error('working memory not found'); e.statusCode = 404; throw e; }
  const r = await doAdd({ content: w.content, user: w.user, project: w.project, session: w.session, tags: w.tags,
    org: w.org, mem_category: w.meta && w.meta.mem_category, memory_type: w.memory_type,
    actor_id: (w.meta && w.meta.actor_id) || null, agent_id: (w.meta && w.meta.agent_id) || null, run_id: (w.meta && w.meta.run_id) || null, // v1.12.0 (gap②)
    source: (w.meta && w.meta.source) || { type: 'agent', trigger: 'promote' } });
  backend.deleteWorkingMemory(id);
  webhook.emit('memory.promoted', { id: r.id, project: w.project, user: w.user, data: { working_id: id, content: w.content } }); // v1.12.0 (gap④)
  return { id: r.id, working_id: id, promoted: true, tier: 'long' };
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
  consolidate,
  batchAdd,
  deleteByFilter,
  reextractMemory,
  addWorking,
  listWorking,
  searchWorking,
  deleteWorking,
  promoteWorking,
};
