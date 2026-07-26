// 虚假完成自动检测与修复闭环（v1.19.0）。
// scheduler 定时扫描所有带 promise/impl-done/completed 标签的记忆，
// 验证其声明的证据（文件/commit/端点）是否真实存在。
// 失败时创建 fix-needed 修复任务记忆，供 AI 客户端发现并修复。
// 修复后 scheduler 自动重验，通过则关闭。
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');
const memory = require('./memory');
const insight = require('./insight');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = config.ROOT;

// 主入口：扫描所有"完成声明"记忆，验证并创建修复任务
async function scanAndCreateFixes(a = {}) {
  const out = { at: new Date().toISOString(), checked: 0, passed: 0, failed: 0, fix_created: 0 };
  try {
    // 用 loadAllCached 获取全部记忆（含 qdrant 路径）
    let pool;
    try { pool = await insight.loadAllCached(); } catch (e) { pool = []; }
    // 过滤含承诺标签的记忆
    const promises = pool.filter(m =>
      m.tags && Array.isArray(m.tags) && m.tags.some(t =>
        ['promise', 'impl-done', 'completed'].includes(t)
      )
    );
    out.checked = promises.length;
    for (const m of promises) {
      try {
        const vr = await verifyMemory(m);
        if (vr.ok) {
          out.passed++;
          // 已通过且不是 fix-needed 状态：更新 verified_at
          if (!m.tags.includes('fix-needed') && !m.tags.includes('verify-fail')) {
            await memory.doUpdate(m.id, { verified_at: new Date().toISOString() });
          }
        } else {
          out.failed++;
          // 如果已经是 fix-needed 状态，不再重复创建
          if (m.tags.includes('fix-needed') || m.tags.includes('verify-fail')) continue;
          // 创建修复任务记忆
          const fixTags = ['fix-needed', 'verify-fail', ...(m.tags || []).filter(t => !['promise','impl-done','completed'].includes(t))];
          const fixContent = `【需修复】${m.content}\n失败原因：${vr.reason}\n原始记忆 id：${m.id}`;
          await memory.doAdd({
            content: fixContent,
            user: m.user || 'system',
            project: m.project || 'default',
            tags: fixTags,
            memory_type: 'system',
            entities: [
              { name: m.id, type: 'ref', label: '原始承诺' },
              ...(vr.evidence || []).map(e => ({ name: e, type: 'evidence', label: '失败证据' })),
            ],
            relations: [{ type: 'fix-of', target: m.id }],
          });
          out.fix_created++;
        }
      } catch (e) { errC.other++; }
    }
    // 对已标记为 fixed 的记忆做重验
    const fixed = pool.filter(m => m.tags && Array.isArray(m.tags) && m.tags.includes('fixed'));
    for (const m of fixed) {
      try {
        const vr = await verifyMemory(m);
        if (vr.ok) {
          // 重验通过 → 改 fixed 为 verified
          const newTags = (m.tags || []).filter(t => t !== 'fixed').concat(['verified']);
          await memory.doUpdate(m.id, { tags: newTags, verified_at: new Date().toISOString() });
        }
        // 重验不通过：保留 fixed 标签，等待 AI 再次修复
      } catch (e) { errC.other++; }
    }
    // 存结果到 kv
    try {
      backend.kvSet('verify:last', JSON.stringify(out), '');
      let hist = [];
      try { const v = backend.kvGet('verify:history', ''); if (v) hist = JSON.parse(v); } catch (e) {}
      hist.unshift(out); if (hist.length > 30) hist = hist.slice(0, 30);
      backend.kvSet('verify:history', JSON.stringify(hist), '');
    } catch (e) { errC.other++; }
    return out;
  } catch (e) { return { ...out, error: e.message || String(e), ok: false }; }
}

// 验证单条记忆的声明
async function verifyMemory(mem) {
  const evidence = [];
  const errors = [];
  const entities = mem.entities || [];

  for (const ent of entities) {
    if (!ent || !ent.name) continue;
    // 文件路径验证
    if (ent.type === 'file' || ent.name.startsWith('file:')) {
      const filePath = ent.name.replace(/^file:/, '');
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
      evidence.push(ent.name);
      if (!fs.existsSync(absPath)) {
        errors.push(`文件不存在: ${filePath}`);
      }
    }
    // commit hash 验证
    if (ent.type === 'commit' || ent.name.startsWith('commit:')) {
      const hash = ent.name.replace(/^commit:/, '').slice(0, 40);
      evidence.push(ent.name);
      try {
        execSync(`git -C "${ROOT}" log --oneline -1 ${hash} 2>/dev/null`, { timeout: 5000, stdio: 'pipe' });
      } catch (e) {
        errors.push(`commit 不存在: ${hash}`);
      }
    }
    // API 端点验证
    if (ent.type === 'endpoint' || ent.name.startsWith('endpoint:')) {
      const ep = ent.name.replace(/^endpoint:/, '');
      evidence.push(ent.name);
      const url = (config.CONFIG.verify_base_url || 'http://127.0.0.1:' + config.PORT) + ep;
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok && r.status !== 404) { /* 非 404 的端点可能只是拒绝 HEAD */ }
        if (r.status === 404) errors.push(`端点返回 404: ${ep}`);
      } catch (e) {
        errors.push(`端点不可达: ${ep}`);
      }
    }
  }

  // 没有可验证的证据时跳过（不是虚假完成）
  if (!evidence.length) return { ok: true, reason: '', evidence };
  return { ok: errors.length === 0, reason: errors.join('; '), evidence };
}

function getLastVerify() {
  try { const v = backend.kvGet('verify:last', ''); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function getVerifyHistory() {
  try { const v = backend.kvGet('verify:history', ''); return v ? JSON.parse(v) : []; } catch (e) { return []; }
}

module.exports = { scanAndCreateFixes, verifyMemory, getLastVerify, getVerifyHistory };
