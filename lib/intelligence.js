// 智能重排层：时序衰减(recency) + 来源信任 + 实体链接加权 + salience 综合分。
// 依赖 backend(实体词表读取)，与 backend 单向依赖（无循环）。
const config = require('./config');
const util = require('./util');
const backend = require('./backend');

// ---- temporal awareness helpers ----
function recencyFactor(ts) {
  const t = (ts && !isNaN(new Date(ts).getTime())) ? new Date(ts).getTime() : Date.now();
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  const half = (config.CONFIG.recency_half_life > 0) ? config.CONFIG.recency_half_life : 30;
  return Math.pow(0.5, ageDays / half);
}
function applyRecency(rows) {
  if (!config.CONFIG.recency_enabled) return rows;
  // 时间衰减以「最近访问/强化时间」last_accessed_at 为基准（未被访问则回退 updated_at/created_at）
  rows.forEach(r => { r.score = (r.score != null ? r.score : 1) * recencyFactor(r.last_accessed_at || r.updated_at || r.created_at); });
  rows.sort((a, b) => (b.score || 0) - (a.score || 0));
  return rows;
}

function entityBoostFactor(memEnts, qEnts, boost) {
  if (!qEnts.length || !(boost > 0)) return 1;
  const lower = new Set((memEnts || []).map(x => String(x).toLowerCase()));
  let n = 0; for (const e of qEnts) if (lower.has(e)) n++;
  return n ? (1 + boost * n) : 1;
}

// v1.6.0: salience = 重要性(confidence) + 访问强化(access_count 归一)，夹 [0,1]。recency 衰减由 applyRecency 单独处理。
function computeSalience(r) {
  const importance = (typeof r.confidence === 'number' && r.confidence >= 0) ? Math.min(1, r.confidence) : 0.5;
  const acc = Math.min((Number(r.access_count) || 0) / config.SALIENCE_ACCESS_K, 1);
  return util.clamp01(config.SALIENCE_W_IMP * importance + config.SALIENCE_W_ACC * acc);
}
function rerankWithContext(rows, query) {
  const qEnts = backend.queryEntities(query);
  const boost = config.CONFIG.entity_link_boost || 0;
  rows.forEach(r => {
    const eb = entityBoostFactor(r.entity_names, qEnts, boost);
    const st = util.sourceTrustFactor(r.source);
    r.score = (r.score != null ? r.score : 1) * eb * st;
    const sal = computeSalience(r);
    r.salience = sal;
    if (config.CONFIG.salience_enabled) {
      const blend = config.SALIENCE_SCORE_W + (1 - config.SALIENCE_SCORE_W) * sal;
      r.score = r.score * blend;
    }
  });
  return rows;
}

module.exports = { recencyFactor, applyRecency, entityBoostFactor, computeSalience, rerankWithContext, applyMMR };

// v1.13.0: MMR（Maximum Marginal Relevance）多样性重排。
// 在已排序的结果上做多样性重排：λ 控制语义相关性与多样性平衡（0=纯语义，1=纯多样性）。
// 用进程内缓存跨结果计算嵌入相似度（前一次搜索的嵌入可复用；否则在线计算）。
const mmrCache = new Map();
function _mmrSim(a, b) {
  const k = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
  if (mmrCache.has(k)) return mmrCache.get(k);
  // 无嵌入时用内容 jaccard 近似
  const ca = (a.content || ''), cb = (b.content || '');
  if (!ca || !cb) { mmrCache.set(k, 0); return 0; }
  const sa = new Set(ca.toLowerCase().split(/[,\s。，！？\n]+/).filter(Boolean));
  const sb = new Set(cb.toLowerCase().split(/[,\s。，！？\n]+/).filter(Boolean));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const uni = sa.size + sb.size - inter;
  const sim = uni > 0 ? inter / uni : 0;
  mmrCache.set(k, sim);
  if (mmrCache.size > 500) mmrCache.delete(mmrCache.keys().next().value);
  return sim;
}
function applyMMR(rows, lambda) {
  if (!rows || rows.length <= 1) return rows;
  const l = (lambda !== undefined && lambda !== null) ? lambda : (config.CONFIG.mmr_lambda || 0.3);
  const selected = [];
  const remain = rows.slice();
  // 选第一个（最高分原始项）
  selected.push(remain.shift());
  while (remain.length > 0 && selected.length < rows.length) {
    let bestIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < remain.length; i++) {
      const relev = remain[i].score || 0;
      let maxSim = 0;
      for (const s of selected) {
        const sim = _mmrSim(remain[i], s);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = l * relev - (1 - l) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }
    if (bestIdx >= 0) selected.push(remain.splice(bestIdx, 1)[0]);
    else break;
  }
  return selected;
}
