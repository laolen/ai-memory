// v1.12.0 (gap④): Webhooks 事件推送——记忆 ADD/UPDATE/DELETE/PROMOTE/CONSOLIDATE 时向外部端点异步 POST。
// 零新依赖（原生 http/https）；fire-and-forget + 失败重试 1 次；不阻塞、不影响主流程。
// 端点来源：全局 config.webhook_urls（string[]）+ 项目级 project_config.webhook_urls（合并去重）。
// 推送体：{ event, memory_id, project, user, ts, data }，Header 带 X-AI-Memory-Event 便于路由。
const http = require('http');
const https = require('https');
const crypto = require('crypto'); // v1.21.0: HMAC 签名
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');
const util = require('./util'); // v1.20.0 (#2): SSRF 防护

const RECENT = []; // 最近推送记录（诊断用，环形上限 50）
function _record(entry) { RECENT.push(entry); if (RECENT.length > 50) RECENT.shift(); }
function recentDeliveries() { return RECENT.slice().reverse(); }

function _postJson(urlStr, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'bad url' }); }
    // v1.20.0 (#2): SSRF 防护——拒绝内网 IP 的 webhook 目标
    const ssrf = util.checkSSRF(urlStr);
    if (!ssrf.ok) return resolve({ ok: false, error: ssrf.error });
    const mod = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-AI-Memory-Event': body.event || 'unknown' };
    // v1.21.0: webhook_secret HMAC-SHA256 签名
    const secret = config.CONFIG.webhook_secret;
    if (secret) { headers['X-Signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(data).digest('hex'); }
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers,
      timeout: timeoutMs || 5000,
    }, (res) => {
      res.resume(); // 丢弃响应体
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
    req.write(data); req.end();
  });
}

function _targets(project) {
  const urls = new Set();
  const g = config.CONFIG.webhook_urls;
  if (Array.isArray(g)) for (const u of g) if (u) urls.add(String(u));
  if (project) {
    try {
      const pc = backend.projectConfigGet(project);
      if (pc && Array.isArray(pc.webhook_urls)) for (const u of pc.webhook_urls) if (u) urls.add(String(u));
    } catch (e) { errC.other++; }
  }
  return [...urls];
}

// 触发事件（fire-and-forget；失败重试 1 次）。event ∈ memory.added/updated/deleted/promoted/consolidated
function emit(event, info) {
  try {
    if (!config.CONFIG.webhook_enabled) return;
    const targets = _targets(info && info.project);
    if (!targets.length) return;
    const body = {
      event,
      memory_id: (info && info.id) || null,
      project: (info && info.project) || null,
      user: (info && info.user) || null,
      ts: new Date().toISOString(),
      data: (info && info.data) || null,
    };
    for (const url of targets) {
      (async () => {
        let r = await _postJson(url, body, config.CONFIG.webhook_timeout_ms);
        if (!r.ok) r = await _postJson(url, body, config.CONFIG.webhook_timeout_ms); // 重试 1 次
        _record({ url, event, memory_id: body.memory_id, ok: r.ok, status: r.status || null, error: r.error || null, ts: body.ts });
      })().catch(() => {});
    }
  } catch (e) { errC.other++; }
}

module.exports = { emit, recentDeliveries };
