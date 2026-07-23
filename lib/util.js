const config = require('./config');

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function sourceTypeOf(source) {
  if (!source) return 'human';
  if (typeof source === 'string') return source;
  if (source.type) return source.type;
  return 'human';
}

// 数据源归一化：字符串 → {type}，对象原样，空 → null；自动补 captured_at 与 trigger（溯源用）
function normalizeSource(s, trigger) {
  if (!s) return null;
  let o;
  if (typeof s === 'string') o = { type: s };
  else o = Object.assign({}, s);
  if (!o.captured_at) o.captured_at = new Date().toISOString();
  if (trigger && !o.trigger) o.trigger = trigger;
  return o;
}

function sourceTrustFactor(source) {
  if (!config.CONFIG.source_trust_enabled) return 1;
  const w = config.CONFIG.source_trust_weights && config.CONFIG.source_trust_weights[sourceTypeOf(source)];
  return (w && w > 0) ? w : 1;
}

// v1.7.0: 项目间强弱关联衰减——强(1)→0.8, 中(0.5)→0.5, 弱(0.2)→0.32
function relationDecay(strength) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  return 0.2 + 0.6 * s;
}

// 是否启用跨项目借鉴：请求级 include_related 优先，否则用全局配置
function relEnabled(a) {
  return (a && a.include_related !== undefined) ? !!a.include_related : config.CONFIG.related_projects_enabled;
}

module.exports = {
  clamp01, cosine, sourceTypeOf, normalizeSource, sourceTrustFactor, relationDecay, relEnabled,
};
