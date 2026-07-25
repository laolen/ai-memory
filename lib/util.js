const config = require('./config');
const crypto = require('crypto');

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// 内容归一化哈希：忽略大小写与空白差异，用于「完全相同内容」的精确去重兜底，
// 不依赖向量相似度阈值（避免改写/边界 case 漏合并或误合并）。
function hashContent(text) {
  if (text == null) return '';
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(norm, 'utf8').digest('hex');
}

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

// 数据源归一化：字符串 → {type}，对象原样；空也生成溯源戳 {captured_at, trigger}（不再返回 null，
// 保证每条记忆都有 provenance）。自动补 captured_at 与 trigger（溯源用）
function normalizeSource(s, trigger) {
  if (!s) {
    const o = {};
    o.captured_at = new Date().toISOString();
    if (trigger) o.trigger = trigger;
    return o;
  }
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
  if (a && a.include_related !== undefined) {
    // query 参数到路由后会变成字符串 'true'/'false'，必须显式归一化，
    // 否则 'false' 作为非空字符串经 !! 判定为 true，导致「include_related=false 仍包含借用」的错误。
    const v = a.include_related;
    return v === true || v === 'true' || v === 1 || v === '1';
  }
  return config.CONFIG.related_projects_enabled;
}

// 路径安全校验：保证目标路径在 ROOT 之下，防止 backup_path 路径遍历
function safePath(userPath) {
  if (!userPath) return null;
  const p = require('path');
  const resolved = p.resolve(config.ROOT, userPath);
  const root = p.resolve(config.ROOT);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

// 宽松 JSON 解析：兼容 LLM 输出的 ```json 代码围栏、前后噪声文本；
// 直接 JSON.parse 失败时，退而截取首个 {...} 或 [...] 片段再解析；均失败返回 null。
function parseLooseJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text; // 已是对象
  let s = String(text).trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) {}
  const first = s.search(/[[{]/);
  const lastObj = s.lastIndexOf('}');
  const lastArr = s.lastIndexOf(']');
  const last = Math.max(lastObj, lastArr);
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch (e) {}
  }
  return null;
}

module.exports = {
  clamp01, cosine, sourceTypeOf, normalizeSource, sourceTrustFactor, relationDecay, relEnabled, hashContent, safePath, parseLooseJson,
};
