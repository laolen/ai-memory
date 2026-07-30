// 记忆操作层（核心数据 ops，MCP + REST 共用）：doAdd/doUpdate/doDelete/doSearch/doList
// + searchProject + sqliteList/sqliteSearch + cleanupExpired/purgeMemories + getMemory/bumpCorrection。
// v1.9.0：主存储切换为 Qdrant（向量+结构化 payload，过滤+语义检索）。
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

// cleanupExpired 节流：10 分钟最多触发一次，避免每次 doAdd 末尾都多两次 Qdrant 请求
let _lastCleanupAt = 0;
const CLEANUP_THROTTLE_MS = 10 * 60 * 1000;
const qdrant = require('./qdrant');
const webhook = require('./webhook'); // v1.12.0 (gap④)
const bus = require('./bus'); // v1.17.0 (#98): 记忆变更事件总线（解耦 MCP Resources 实时通知）
const http = require('http');
const https = require('https');
const errC = config.errStats;

// v1.20.0 (#4b): 搜索结果 LRU 缓存——相同查询+过滤条件在 TTL 内走缓存，memory-changed 事件触发失效。
const _searchCache = new Map();
function _cacheKey(a) {
  return JSON.stringify({ q: a.query || '', p: a.project || null, u: a.user || null, s: a.session || null,
    m: a.mode || 'keyword', k: a.top_k || 5, f: a.from || null, t: a.to || null, fl: a.filters || null });
}
function _getSearchCache(key) {
  if (!config.CONFIG.search_cache_enabled) return null;
  const e = _searchCache.get(key);
  if (!e) { _cacheMisses++; return null; }
  if (Date.now() - e.ts > (config.CONFIG.search_cache_ttl_ms || 60000)) { _searchCache.delete(key); _cacheMisses++; return null; }
  _cacheHits++;
  return e.data;
}
function _setSearchCache(key, data) {
  if (!config.CONFIG.search_cache_enabled) return;
  if (_searchCache.size >= (config.CONFIG.search_cache_max || 200)) _searchCache.delete(_searchCache.keys().next().value);
  _searchCache.set(key, { data, ts: Date.now() });
}
// 事件总线触发缓存失效
try { require('./bus').on('memory-changed', () => _searchCache.clear()); } catch (e) {}
let _cacheHits = 0, _cacheMisses = 0;
function _searchCacheStats() { return { size: _searchCache.size, enabled: config.CONFIG.search_cache_enabled !== false, hits: _cacheHits, misses: _cacheMisses }; }

// Qdrant 是否作为主存储：需配置 qdrant_url 且开启 embedding（语义检索依赖向量）
// v1.22.0: 尊重运行时可达性——配置了 Qdrant 但探测不可达时，降级到 SQLite（核心写入不中断）。
const Q = () => {
  if (!qdrant.useQdrant() || !config.CONFIG.embedding_url) return false;
  const r = qdrant.isReachable();
  return r !== false; // null=未探测（乐观信任配置）；false=探测不可达→降级
};

// v1.20.0 (#6): 记忆关联推荐——写入成功后基于向量邻近 + 实体共现 + 标签交集综合排序，返回 N 条最相关记忆。
// 仅在有有效嵌入时启用（零向量占位不算）。SQLite 降级路径用 cosine + JS 过滤。
async function _suggestRelated(doc, a) {
  const limit = config.CONFIG.suggest_related_limit || 5;
  const results = [];
  const myEntities = doc.entity_names || [];
  const myTags = doc.tags || [];
  // 有效嵌入检查：非空且不全为零（占位零向量不做推荐）
  const hasValidVec = Array.isArray(doc.embedding) && doc.embedding.length > 0 && doc.embedding.some(v => v !== 0);
  if (!hasValidVec) return results;
  try {
    if (Q()) {
      // Qdrant 向量邻近查询（排除自身，限同项目/同用户作用域）
      const filter = backend.qdrantFilter({ project: doc.project, user: a.user });
      const res = await qdrant.query({ vector: doc.embedding, filter, limit: limit * 3 + 1, withVector: false });
      const rows = backend.pointsToRows(res).filter(r => r.id !== doc.id);
      for (const r of rows) {
        let score = r.score || 0;
        if (score < 0.3) continue;
        const reasons = [];
        if (score > 0.5) reasons.push('语义相似');
        const sharedEnt = myEntities.filter(e => (r.entity_names || []).includes(e));
        if (sharedEnt.length) { score += 0.1 * sharedEnt.length; reasons.push('共享实体: ' + sharedEnt.join(', ')); }
        const sharedTags = myTags.filter(t => (r.tags || []).includes(t));
        if (sharedTags.length) { score += 0.05 * sharedTags.length; reasons.push('共享标签: ' + sharedTags.join(', ')); }
        if (!reasons.length) reasons.push('语义相似');
        results.push({ id: r.id, content: r.content, score: Math.round(score * 100) / 100, reason: reasons.join('; ') });
      }
      results.sort((x, y) => y.score - x.score);
    } else {
      // SQLite 降级：cosine 相似度 + 实体/标签加权
      const d = backend.sqliteInit();
      const rows = d.prepare('SELECT id, content, embedding, tags, entity_names FROM memories WHERE id != ? AND (expires_at IS NULL OR expires_at > ?)')
        .all(doc.id, new Date().toISOString()).filter(r => r.embedding);
      for (const r of rows) {
        let score = util.cosine(doc.embedding, JSON.parse(r.embedding));
        if (score < 0.3) continue;
        const reasons = [];
        if (score > 0.5) reasons.push('语义相似');
        let entNames = []; try { entNames = JSON.parse(r.entity_names || '[]'); } catch (e) {}
        let tags = []; try { tags = JSON.parse(r.tags || '[]'); } catch (e) {}
        const sharedEnt = myEntities.filter(e => entNames.includes(e));
        if (sharedEnt.length) { score += 0.1 * sharedEnt.length; reasons.push('共享实体: ' + sharedEnt.join(', ')); }
        const sharedTags = myTags.filter(t => tags.includes(t));
        if (sharedTags.length) { score += 0.05 * sharedTags.length; reasons.push('共享标签: ' + sharedTags.join(', ')); }
        if (!reasons.length) reasons.push('语义相似');
        results.push({ id: r.id, content: r.content, score: Math.round(score * 100) / 100, reason: reasons.join('; ') });
      }
      results.sort((x, y) => y.score - x.score);
    }
  } catch (e) { errC.other++; }
  return results.slice(0, limit);
}

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
  // v1.14.0: 请求体校验——拒绝空内容
  if (!a || !a.content || !String(a.content).trim()) { const e = new Error('content is required'); e.statusCode = 400; throw e; }
  // v1.16.0 (#89): 可选的写入前矛盾检测（默认关闭，保持既有契约）。
  // check_contradictions=true 时检测冲突：block_on_conflict=true 则发现冲突不写入、返回 needs_clarification；否则写入并在返回附带 conflicts。
  let _conflicts = null;
  if (a.check_contradictions) {
    try {
      const chk = await require('./maintain').detectContradictions({ content: a.content, project: a.project, user: a.user });
      if (chk && chk.has_conflict) {
        if (a.block_on_conflict) return { id: null, needs_clarification: true, conflicts: chk.conflicts, message: '检测到与已有记忆可能矛盾，未写入。请核实澄清，或以 block_on_conflict:false 强制写入。' };
        _conflicts = chk.conflicts;
      }
    } catch (e) { errC.other++; }
  }
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
    content: a.content, user: a.user, project: backend.normalizeProject(a.project) || null, session: a.session || null,
    content_hash: util.hashContent(a.content),
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
    next_review_at: new Date(Date.now() + 24 * 3600000).toISOString(), // v1.15.0: 间隔重复初始 1 天后复习
  };
  // v1.5.0: session 级记忆自动过期（session_ttl_hours>0 且未显式设 expires_at 时）
  if (a.session && !a.expires_at && config.CONFIG.session_ttl_hours > 0) {
    doc.expires_at = new Date(Date.now() + config.CONFIG.session_ttl_hours * 3600000).toISOString();
  }
  if (a._embedding) { doc.embedding = a._embedding; } // v1.20.0 (#4a): 预计算嵌入（batchAdd 批量嵌入后传入）
  else if (config.CONFIG.embedding_url) { try { doc.embedding = await embed.embed(a.content); } catch (e) { console.warn('[ai-memory] 嵌入失败（' + (e && e.message) + '），将尝试零向量占位写入 Qdrant'); } }
  // v1.15.0: 间隔重复——importance 越高初始间隔越长
  const imp = (typeof a.importance === 'number') ? a.importance : 2;
  const baseHours = Math.max(4, 24 - imp * 8); // importance 1→16h, 2→8h, 3→0h=立即复习
  doc.next_review_at = new Date(Date.now() + baseHours * 3600000).toISOString();
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
  // v1.22.1 (#138): exact-content 前置去重——不依赖 embedding，对嵌入失败导致的重复做兜底
  if (mergeAllowed && doc.content_hash) {
    try {
      const d = backend.sqliteInit();
      const scopeWhere = ['content_hash=?'];
      const scopeParams = [doc.content_hash];
      if (a.user) { scopeWhere.push('user=?'); scopeParams.push(a.user); }
      if (doc.project) { scopeWhere.push('project=?'); scopeParams.push(doc.project); }
      if (a.session) { scopeWhere.push('session=?'); scopeParams.push(a.session); }
      scopeWhere.push('(expires_at IS NULL OR expires_at > ?)');
      scopeParams.push(new Date().toISOString());
      const existing = d.prepare('SELECT id, tags, updated_at FROM memories WHERE ' + scopeWhere.join(' AND ') + ' ORDER BY updated_at DESC LIMIT 1').get(...scopeParams);
      if (existing) {
        const mergedTags = Array.from(new Set([...(JSON.parse(existing.tags || '[]')), ...(a.tags || [])]));
        const patch = {
          content: a.content, project: a.project || null, session: a.session || null,
          tags: mergedTags, updated_at: now, fact_entities: a.fact_entities
        };
        const updated = await doUpdate(existing.id, patch);
        return { id: existing.id, merged: true, merged_from: existing.id, similarity: 1.0, exact_match: true, ...updated };
      }
    } catch (e) { /* exact-content dedup 失败静默，不影响主流程 */ }
  }
  if (mergeAllowed && config.CONFIG.embedding_url && doc.embedding) {
    // v1.10.0(P3): 显式传 doc.project（含 null），dedupFind 始终按 project 作用域隔离，杜绝跨项目合并污染
    const hit = await backend.dedupFind(doc.embedding, { user: a.user, project: doc.project, session: a.session }, { text: a.content });
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

  // 主存储：Qdrant（需向量）；否则本地 SQLite 降级。
  // 关键修复（读写分叉）：存储后端必须与读取路径(由 Q() 决定)保持一致。
  // 若处于 Qdrant 模式但本次嵌入失败，用零向量占位写入 Qdrant，
  // 保证该记忆在 Qdrant 检索/列表中始终可见（仅语义排序退化为中性，关键词/FTS 仍可命中）。
  if (Q()) {
    let vec = doc.embedding;
    if (!vec) { try { const sz = await qdrant.vectorSize(); if (sz) vec = new Array(sz).fill(0); } catch (e) { errC.embed++; } }
    if (vec) {
      const payload = Object.assign({}, doc); delete payload.embedding;
      await qdrant.upsert([{ id, vector: vec, payload }]);
    } else {
      // 极端情况：连集合向量维度都取不到（Qdrant 不可达），退守 SQLite 并告警
      backend.sqliteAdd(doc);
      console.warn('[ai-memory] 嵌入失败且无法获取 Qdrant 向量维度，本次写入退守 SQLite（Qdrant 模式下不可检索）');
    }
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
  try { require('./watch').notifyForMemory(doc); } catch (e) { errC.webhook++; } // v1.16.0 (#94): 标签级订阅推送（fire-and-forget）
  try { bus.emit('memory-changed'); } catch (e) {} // v1.17.0 (#98): 通知 MCP Resources 实时刷新
  // 生命周期：过期自动清理（节流，10 分钟内最多一次）
  if (config.CONFIG.lifecycle_policy === 'expire' && config.CONFIG.expiry_days > 0) {
    const now = Date.now();
    if (now - _lastCleanupAt >= CLEANUP_THROTTLE_MS) { _lastCleanupAt = now; try { await cleanupExpired(); } catch (e) { errC.cleanup++; } }
  }
  backend.addEntityVocab(doc.entity_names); // v1.10.0(P3): 增量更新实体词表，避免每次全量扫描 O(n)
  // v1.20.0 (#6): 记忆关联推荐——写入成功后返回 related_suggestions
  let ret = _conflicts ? { id, ...doc, conflicts: _conflicts } : { id, ...doc };
  if (config.CONFIG.suggest_related !== false) {
    try { ret.related_suggestions = await _suggestRelated(doc, a); } catch (e) { errC.other++; }
  }
  return ret;
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
  // v1.20.0 (#2): SSRF 防护——拒绝内网 IP 的 reranker 目标
  const ssrf = util.checkSSRF(urlStr);
  if (!ssrf.ok) { errC.other++; return rows; }
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
    } catch (e) { errC.other++; }
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
  } catch (e) { errC.other++; }
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
  // v1.20.0 (#4b): 搜索结果缓存——相同查询走缓存
  const ck = _cacheKey(a);
  const cached = _getSearchCache(ck);
  if (cached) return cached;
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
  const result = { rows: allRows.slice(0, limit), next_cursor: nextCursor, usage: { tokens } };
  _setSearchCache(ck, result); // v1.20.0 (#4b): 写入搜索缓存
  return result;
}

async function doList(a) {
  let _projectTotal = 0; // v1.22.1 (#140)
  const listProject = async (project) => {
    if (!Q()) {
      const r = sqliteList(Object.assign({}, a, { project }));
      try {
        const d = require('./backend').sqliteInit();
        const where = [], params = [];
        if (a.user) { where.push('user=?'); params.push(a.user); }
        if (project) { where.push('project=?'); params.push(project); }
        if (a.session) { where.push('session=?'); params.push(a.session); }
        where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(new Date().toISOString());
        const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
        _projectTotal += (d.prepare('SELECT COUNT(*) as c FROM memories' + clause).get(...params) || {}).c || 0;
      } catch (e) {}
      return r;
    }
    const fa = Object.assign({}, a, { project });
    const filter = backend.qdrantFilter(fa);
    // v1.22.1 (#140): 真实匹配总数
    try { _projectTotal += await qdrant.count(filter); } catch (e) {}
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
  // v1.15.0: 间隔重复筛选——仅返回到期复习的记忆
  if (a.due_review === 'true' || a.due_review === true) {
    const nowIso = new Date().toISOString();
    rows = rows.filter(r => r.next_review_at && r.next_review_at < nowIso);
  }
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
  return { rows: out.slice(0, limit), next_cursor: nextCursor, usage: { tokens }, total_count: _projectTotal };
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
  try { bus.emit('memory-changed'); } catch (e) {} // v1.17.0 (#98)
  return { id, deleted: true };
}

async function doUpdate(id, patch) {
  const now = new Date().toISOString();
  const _isPinOnly = (patch && Object.keys(patch).length === 1 && 'pinned' in patch);
  const _clOp = (patch && patch.correction_count !== undefined) ? 'CORRECT' : (_isPinOnly ? (patch.pinned ? 'PIN' : 'UNPIN') : 'UPDATE');
  const _clTrigger = (patch && patch.correction_count !== undefined) ? 'correct' : (_isPinOnly ? 'pin' : 'update');
  if (!Q()) {
    const prev = backend.sqliteGet(id);
    const sets = [], params = [];
    if (patch.content !== undefined) { sets.push('content=?'); params.push(patch.content); }
    if (patch.project !== undefined) { sets.push('project=?'); params.push(backend.normalizeProject(patch.project) || null); }
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
    if (patch.next_review_at !== undefined) { sets.push('next_review_at=?'); params.push(patch.next_review_at || null); } // v1.16.0 间隔重复调度
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
      patch.tags !== undefined ? patch.tags : prev.tags, backend.normalizeProject(patch.project !== undefined ? patch.project : prev.project),
      prev.user, prev.session);
    backend.kgUpsert(id, uEnt, uRel, backend.normalizeProject(patch.project !== undefined ? patch.project : prev.project));
    backend.addEntityVocab(uNames);
    backend.recordChangelog(_clOp, {
      id, user: prev.user, project: prev.project,
      before: snapshot(prev), after: snapshot(Object.assign({}, prev, patch)),
      trigger: _clTrigger
    });
    webhook.emit('memory.updated', { id, project: prev.project, user: prev.user, data: snapshot(Object.assign({}, prev, patch)) }); // v1.12.0
    try { bus.emit('memory-changed'); } catch (e) {} // v1.17.0 (#98)
    return backend.sqliteGet(id);
  }
  // v1.9.1: 乐观重试——并发时每次重读最新 prev+version 再递增写回，避免 lost-update
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const cur = await qdrant.get(id);
    if (!cur) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    const prev = cur.payload;
    const payload = Object.assign({}, prev);
    if (patch.content !== undefined) { payload.content = patch.content; payload.content_hash = util.hashContent(patch.content); }
    if (patch.project !== undefined) payload.project = backend.normalizeProject(patch.project) || null;
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
    if (patch.next_review_at !== undefined) payload.next_review_at = patch.next_review_at || null; // v1.16.0 间隔重复调度
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
    backend.recordChangelog(_clOp, {
      id, user: prev.user, project: prev.project,
      before: snapshot(prev), after: snapshot(payload),
      trigger: _clTrigger
    });
    webhook.emit('memory.updated', { id, project: prev.project, user: prev.user, data: snapshot(payload) }); // v1.12.0 (gap④)
    try { bus.emit('memory-changed'); } catch (e) {} // v1.17.0 (#98)
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
    // 修复：占位符数量必须按「查询词数」而非「where 子句数」。原 where.map(w=>w+' AND content LIKE ?')
    // 会给每个 where 子句各附一个 content LIKE ?（数量=where.length），与实际绑定值(=terms.length)不符，
    // 触发「Too few parameter values」。正确做法：所有 where 子句 + 每个词一个 content LIKE ?，一起 AND。
    const conds = where.concat(terms.map(() => 'content LIKE ?'));
    const lp = params.concat(terms.map(t => '%' + t + '%'));
    const rows = d.prepare('SELECT * FROM memories WHERE ' + conds.join(' AND ')).all(...lp);
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
    // 同上修复：content LIKE ? 占位符数量按查询词数，与 where 子句一起 AND。
    const conds = where.concat(terms.map(() => 'content LIKE ?'));
    const lp = params.concat(terms.map(t => '%' + t + '%'));
    kwRows = d.prepare('SELECT * FROM memories WHERE ' + conds.join(' AND ')).all(...lp)
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

const lifecycle = require('./memory_lifecycle');
const work = require('./memory_work');

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
  getSearchCacheStats: _searchCacheStats,
  cleanupExpired: track('cleanup', lifecycle.cleanupExpired),
  purgeMemories: track('purge', lifecycle.purgeMemories),
  consolidate: lifecycle.consolidate,
  batchAdd: lifecycle.batchAdd,
  deleteByFilter: lifecycle.deleteByFilter,
  reextractMemory: lifecycle.reextractMemory,
  getMemory,
  bumpCorrection,
  addWorking: work.addWorking,
  listWorking: work.listWorking,
  searchWorking: work.searchWorking,
  deleteWorking: work.deleteWorking,
  promoteWorking: work.promoteWorking,
  // 内部导出供 memory_lifecycle.js lazy require 使用
  snapshot,
};
