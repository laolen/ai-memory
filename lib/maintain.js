// 记忆维护层：健康报告(#90) + 批量语义维护 prune/merge(#91)。
// 复用 insight（相似度/聚类/遗忘曲线）+ memory（doUpdate/doDelete/getMemory）+ embed（LLM 合并摘要）。
// 删除类操作默认 dry-run，必须显式 confirm=true 才真正删除（防误清理）。
const config = require('./config');
const errC = config.errStats;
const insight = require('./insight');
const memory = require('./memory');
const embed = require('./embed');
const util = require('./util');

// 在给定记忆集合内找重复/冲突对（项目内），复用 insight 的相似度原语。
function dupPairsIn(mems, threshold) {
  const withVec = mems.filter(m => Array.isArray(m.vector) && m.vector.length);
  const useVector = withVec.length >= 2 && withVec.length === mems.length;
  const thr = (typeof threshold === 'number' && !isNaN(threshold)) ? threshold : (config.CONFIG.dedup_threshold || 0.92);
  const eff = useVector ? thr : Math.min(thr, 0.6);
  const pairs = [];
  for (let i = 0; i < mems.length; i++) {
    for (let j = i + 1; j < mems.length; j++) {
      const a = mems[i], b = mems[j];
      if (a.id === b.id) continue;
      let sim = 0, exact = false;
      if (a.content_hash && b.content_hash && a.content_hash === b.content_hash) { exact = true; sim = 1; }
      else if (useVector && a.vector && b.vector) sim = insight.cosine(a.vector, b.vector);
      else sim = insight.jaccard(a.content, b.content);
      if (exact || sim >= eff) pairs.push({ a: { id: a.id, content: a.content }, b: { id: b.id, content: b.content }, similarity: +sim.toFixed(4), exact });
    }
  }
  pairs.sort((x, y) => ((y.exact ? 1 : 0) - (x.exact ? 1 : 0)) || (y.similarity - x.similarity));
  return { method: useVector ? 'vector' : 'content', threshold: +eff.toFixed(4), pairs };
}

// 重复对中选"保留/待删"：保留 confidence 高者；同则 updated_at 新者；再同则内容更长者。
function pickKeep(a, b) {
  const ca = a.confidence != null ? a.confidence : 0.5;
  const cb = b.confidence != null ? b.confidence : 0.5;
  if (ca !== cb) return ca > cb ? [a, b] : [b, a];
  const ua = new Date(a.updated_at || a.created_at || 0).getTime();
  const ub = new Date(b.updated_at || b.created_at || 0).getTime();
  if (ua !== ub) return ua > ub ? [a, b] : [b, a];
  return (a.content || '').length >= (b.content || '').length ? [a, b] : [b, a];
}

// #90 记忆健康报告：重复/标签聚类/遗忘曲线/卫生度 汇总 + 健康评分 + 建议。
async function memoryHealth(a = {}) {
  const all = await insight.loadAllCached();
  const mems = a.project ? all.filter(m => m.project === a.project) : all;
  const total = mems.length;
  if (!total) return { ok: true, project: a.project || null, total: 0, health_score: 100, recommendations: ['记忆库为空，无需维护。'] };
  const cluster = insight.clusterTags(mems);
  const curve = insight.forgettingCurve(mems);
  const dup = dupPairsIn(mems, a.dup_threshold);
  const untagged = mems.filter(m => !(m.tags && m.tags.length)).length;
  const lowConf = mems.filter(m => m.confidence != null && m.confidence < 0.5).length;
  // 涉及重复的去重记忆条数（估算冗余量）
  const dupIds = new Set();
  dup.pairs.forEach(p => { dupIds.add(p.a.id); dupIds.add(p.b.id); });
  // 健康评分：从 100 起扣分
  let score = 100;
  const dupRatio = dupIds.size / total;
  const untaggedRatio = untagged / total;
  const dueRatio = curve.due_count / total;
  score -= Math.min(35, Math.round(dupRatio * 100));      // 重复冗余最多扣 35
  score -= Math.min(20, Math.round(untaggedRatio * 25));  // 未打标最多扣 20
  score -= Math.min(20, Math.round(dueRatio * 30));       // 到期未复习最多扣 20
  score -= Math.min(10, Math.round((lowConf / total) * 20)); // 低置信最多扣 10
  score = Math.max(0, score);
  const recommendations = [];
  if (dup.pairs.length) recommendations.push('发现 ' + dup.pairs.length + ' 组疑似重复（涉及 ' + dupIds.size + ' 条）。建议用 prune_memories 清理冗余，或 merge_memories 合并同义条目。');
  if (untaggedRatio > 0.3) recommendations.push(untagged + ' 条记忆没有标签（占 ' + Math.round(untaggedRatio * 100) + '%），建议补充标签以改善聚类与检索。');
  if (curve.due_count) recommendations.push(curve.due_count + ' 条记忆已到期复习，建议用 due_recalls 取出巩固。');
  if (lowConf) recommendations.push(lowConf + ' 条记忆置信度偏低（<0.5），可通过 correct_memory 核实或补充来源。');
  if (!recommendations.length) recommendations.push('记忆库状态良好，无需特别维护。');
  return {
    ok: true, project: a.project || null, total, health_score: score,
    duplicates: { pair_count: dup.pairs.length, affected: dupIds.size, method: dup.method, threshold: dup.threshold, top: dup.pairs.slice(0, 10) },
    tags: { unique: cluster.unique_tags, clusters: cluster.clusters.slice(0, 10), top: cluster.tag_counts.slice(0, 10) },
    forgetting: { due_count: curve.due_count, scheduled_count: curve.scheduled_count, mean_stability_hours: curve.mean_stability_hours },
    hygiene: { untagged, low_confidence: lowConf },
    recommendations,
  };
}

// #91a 批量语义维护——按主题裁剪冗余重复。删除默认 dry-run，confirm=true 才执行。
// topic 可选：给定时先按语义/关键词把记忆池收敛到该主题，再在池内找重复冗余。
async function pruneMemories(a = {}) {
  const all = await insight.loadAllCached();
  let pool = a.project ? all.filter(m => m.project === a.project) : all;
  let topicInfo = null;
  if (a.topic && String(a.topic).trim()) {
    const topic = String(a.topic).trim();
    let done = false;
    if (config.CONFIG.embedding_url) {
      try {
        const tv = await embed.embed(topic);
        const tthr = (typeof a.topic_threshold === 'number') ? a.topic_threshold : 0.45;
        pool = pool.filter(m => Array.isArray(m.vector) && m.vector.length && insight.cosine(tv, m.vector) >= tthr);
        topicInfo = { topic, method: 'semantic', threshold: tthr };
        done = true;
      } catch (e) { errC.embed++; }
    }
    if (!done) {
      const lc = topic.toLowerCase();
      pool = pool.filter(m => (m.content || '').toLowerCase().includes(lc));
      topicInfo = { topic, method: 'keyword' };
    }
  }
  const { pairs, method, threshold } = dupPairsIn(pool, a.threshold);
  const byId = new Map(pool.map(m => [m.id, m]));
  const prune = new Map(); // id -> {kept, similarity, exact}
  const keep = new Set();
  for (const p of pairs) {
    const a1 = byId.get(p.a.id), b1 = byId.get(p.b.id);
    if (!a1 || !b1) continue;
    const [win, lose] = pickKeep(a1, b1);
    if (prune.has(win.id)) continue;
    keep.add(win.id);
    if (!keep.has(lose.id) && !prune.has(lose.id)) prune.set(lose.id, { kept: win.id, similarity: p.similarity, exact: p.exact });
  }
  let candidates = [...prune.entries()].map(([id, r]) => ({ id, content: (byId.get(id) || {}).content, kept: r.kept, similarity: r.similarity, exact: r.exact }));
  if (typeof a.max === 'number' && a.max > 0) candidates = candidates.slice(0, a.max);
  if (a.confirm === true) {
    let deleted = 0; const errors = [];
    for (const c of candidates) { try { await memory.doDelete(c.id); deleted++; } catch (e) { errors.push({ id: c.id, error: e.message }); } }
    return { ok: true, dry_run: false, topic: topicInfo, pool_size: pool.length, method, threshold, deleted, deleted_ids: candidates.map(c => c.id), errors };
  }
  return { ok: true, dry_run: true, topic: topicInfo, pool_size: pool.length, method, threshold, prunable_count: candidates.length, candidates, note: '未删除任何记忆（dry-run）。确认无误后以 confirm=true 再次调用即执行删除。' };
}

// #91b 合并指定的多条记忆为一条：内容 LLM 综合（回退去重拼接）、标签取并集，
// 主项保留、其余删除。主项 = confidence 最高、其次最新。
async function mergeMemories(a = {}) {
  const ids = Array.isArray(a.ids) ? a.ids.filter(Boolean) : [];
  if (ids.length < 2) { const e = new Error('need at least 2 ids to merge'); e.statusCode = 400; throw e; }
  const mems = [];
  for (const id of ids) { try { mems.push(await memory.getMemory(id)); } catch (e) {} }
  if (mems.length < 2) { const e = new Error('fewer than 2 valid memories found for given ids'); e.statusCode = 404; throw e; }
  mems.sort((x, y) => (((y.confidence != null ? y.confidence : 0.5) - (x.confidence != null ? x.confidence : 0.5))) || (new Date(y.updated_at || 0) - new Date(x.updated_at || 0)));
  const primary = mems[0];
  const others = mems.slice(1);
  const allTags = Array.from(new Set(mems.flatMap(m => m.tags || []).map(String).filter(Boolean)));
  let mergedContent = null, usedLlm = false;
  if (config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
    try {
      const c = await embed.chatJSON({
        url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
        messages: [
          { role: 'system', content: '把多条关于同一主题的记忆合并为一条无冗余、信息完整、表述通顺的中文记忆。只返回 JSON：{"content":"..."}' },
          { role: 'user', content: mems.map((m, i) => (i + 1) + '. ' + (m.content || '')).join('\n') },
        ], temperature: 0.2, jsonMode: true,
      });
      const p = util.parseLooseJson(c);
      if (p && p.content) { mergedContent = String(p.content).trim(); usedLlm = true; }
    } catch (e) { errC.other++; }
  }
  if (!mergedContent) {
    const seen = new Set(); const parts = [];
    for (const m of mems) { const t = (m.content || '').trim(); if (t && !seen.has(t)) { seen.add(t); parts.push(t); } }
    mergedContent = parts.join(' ');
  }
  const updated = await memory.doUpdate(primary.id, { content: mergedContent, tags: Array.from(new Set([...allTags, 'merged'])) });
  let deleted = 0; const errors = [];
  for (const o of others) { try { await memory.doDelete(o.id); deleted++; } catch (e) { errors.push({ id: o.id, error: e.message }); } }
  return { ok: true, merged_into: primary.id, deleted, deleted_ids: others.map(o => o.id), llm: usedLlm, content: mergedContent, errors };
}

// #89 矛盾自动检测：给定候选内容，找出语义相近的已有记忆，并（有 LLM 时）判定是否矛盾。
// 用于 add 前主动发现冲突。返回 needs_clarification/has_conflict + 冲突明细。非阻塞、只读。
async function detectContradictions(a = {}) {
  const content = String(a.content || '').trim();
  if (!content) { const e = new Error('content is required'); e.statusCode = 400; return Promise.reject(e); }
  const minSim = (typeof a.min_similarity === 'number') ? a.min_similarity : 0.55;
  const topN = a.top_k || 5;
  const all = await insight.loadAllCached();
  let pool = all;
  if (a.project) pool = pool.filter(m => m.project === a.project);
  if (a.user) pool = pool.filter(m => m.user === a.user);
  // 相近候选：优先向量余弦；无向量则内容 jaccard。
  let near = [];
  if (config.CONFIG.embedding_url) {
    try {
      const tv = await embed.embed(content);
      near = pool.filter(m => Array.isArray(m.vector) && m.vector.length)
        .map(m => ({ m, sim: insight.cosine(tv, m.vector) }))
        .filter(x => x.sim >= minSim)
        .sort((p, q) => q.sim - p.sim).slice(0, topN);
    } catch (e) { errC.embed++; }
  }
  if (!near.length) {
    near = pool.map(m => ({ m, sim: insight.jaccard(content, m.content) }))
      .filter(x => x.sim >= Math.min(minSim, 0.4))
      .sort((p, q) => q.sim - p.sim).slice(0, topN);
  }
  if (!near.length) return { ok: true, has_conflict: false, needs_clarification: false, checked: 0, conflicts: [] };
  // 无 LLM：仅返回"相近但不完全相同"的候选作为潜在冲突提示（similarity 高但内容不同）。
  if (!(config.CONFIG.llm_enabled && config.CONFIG.llm_url)) {
    const potential = near.filter(x => x.sim < 0.985).map(x => ({ id: x.m.id, content: x.m.content, similarity: +x.sim.toFixed(4), verdict: 'similar', reason: '语义相近（未启用 LLM，无法判定是否矛盾）' }));
    return { ok: true, has_conflict: false, needs_clarification: potential.length > 0, checked: near.length, method: 'similarity-only', conflicts: potential };
  }
  // 有 LLM：批量判定哪些候选与新内容矛盾。
  const listText = near.map((x, i) => (i + 1) + '. ' + (x.m.content || '')).join('\n');
  let conflicts = [];
  try {
    const c = await embed.chatJSON({
      url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
      messages: [
        { role: 'system', content: '判断"新陈述"是否与每条"已有记忆"矛盾（事实冲突，而非仅仅相似或互补）。只返回 JSON：{"conflicts":[{"index":候选序号(从1),"reason":"冲突点"}]}。没有矛盾则 conflicts 为空数组。' },
        { role: 'user', content: '新陈述：' + content + '\n\n已有记忆：\n' + listText },
      ], temperature: 0.1, jsonMode: true,
    });
    const p = util.parseLooseJson(c);
    if (p && Array.isArray(p.conflicts)) {
      conflicts = p.conflicts.map(cf => {
        const idx = Number(cf.index) - 1;
        const cand = near[idx];
        if (!cand) return null;
        return { id: cand.m.id, content: cand.m.content, similarity: +cand.sim.toFixed(4), verdict: 'contradicts', reason: String(cf.reason || '') };
      }).filter(Boolean);
    }
  } catch (e) { errC.other++; }
  return { ok: true, has_conflict: conflicts.length > 0, needs_clarification: conflicts.length > 0, checked: near.length, method: 'llm', conflicts };
}

module.exports = { memoryHealth, pruneMemories, mergeMemories, dupPairsIn, detectContradictions };
