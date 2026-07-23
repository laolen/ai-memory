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

module.exports = { recencyFactor, applyRecency, entityBoostFactor, computeSalience, rerankWithContext };
