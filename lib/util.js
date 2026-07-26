const config = require('./config');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;

// v1.20.0 (#2): SSRF 防护——检查 IP 是否为内网/保留地址。
// 禁止范围：10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0/8, IPv6 ::1/fe80/fc/fd
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd')) return true;
    if (l.startsWith('fe80')) return true;
    return false;
  }
  return false;
}

// v1.20.0 (#2): SSRF 安全 fetch——解析 URL hostname，拒绝内网 IP（除非在 allowlist 中）。
// 用于「用户可配的出站 URL」（webhook、reranker），防止 SSRF 攻击打内网元数据端点等。
// 内部可信服务（embedding/llm/qdrant）由管理员配置，不走此检查。
async function safeFetch(url, opts = {}) {
  const C = config.CONFIG;
  if (C.ssrf_protection === false) return fetch(url, opts);
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('SSRF: invalid URL'); }
  const hostname = u.hostname;
  const allowlist = Array.isArray(C.ssrf_allowlist) ? C.ssrf_allowlist : [];
  if (allowlist.includes(hostname)) return fetch(url, opts);
  // hostname 是 IP → 直接检查
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname) && !allowlist.includes(hostname))
      throw new Error('SSRF: blocked private IP ' + hostname);
    return fetch(url, opts);
  }
  // hostname 是域名 → DNS 解析后检查所有 A 记录
  try {
    const addrs = await dns.resolve4(hostname);
    for (const ip of addrs) {
      if (isPrivateIP(ip) && !allowlist.includes(ip))
        throw new Error('SSRF: blocked ' + hostname + ' -> ' + ip);
    }
  } catch (e) {
    if (e.message && e.message.startsWith('SSRF:')) throw e;
    // DNS 解析失败：可能是 IPv6-only 或临时故障，交由 fetch 处理（不阻断）
  }
  return fetch(url, opts);
}

// v1.20.0 (#2): SSRF 检查（同步版，用于 http.request 模式如 webhook）——只检查 URL 字符串中的 hostname，
// 不做 DNS 解析（异步解析会改变 webhook 的 fire-and-forget 语义）。IP 直连检查 + 域名标记为需检查。
function checkSSRF(urlStr) {
  const C = config.CONFIG;
  if (C.ssrf_protection === false) return { ok: true };
  let u;
  try { u = new URL(urlStr); } catch (e) { return { ok: false, error: 'invalid URL' }; }
  const hostname = u.hostname;
  const allowlist = Array.isArray(C.ssrf_allowlist) ? C.ssrf_allowlist : [];
  if (allowlist.includes(hostname)) return { ok: true };
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname) && !allowlist.includes(hostname))
      return { ok: false, error: 'SSRF: blocked private IP ' + hostname };
  }
  // 域名不做同步 DNS 解析（避免阻塞），交由实际连接时的 safeFetch 或 http 模块处理
  return { ok: true };
}

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
  isPrivateIP, safeFetch, checkSSRF,
};
