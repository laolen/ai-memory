// 后台异步扫描调度（v1.17.0 #102）：周期性跑健康度/到期/矛盾抽样扫描，结果存 kv 供查询，
// 与 #95 的间隔召回协同。默认非阻塞、失败静默，不影响主写入路径。
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');
const maintain = require('./maintain');
const review = require('./review');
const verify = require('./verify');  // v1.19.0 虚假完成检测闭环
const qualityAuto = require('./quality_auto');  // v1.20.0 (#3): 记忆质量自动化

const LAST_KEY = 'scheduler:last';
const HISTORY_KEY = 'scheduler:history';
let timer = null;

// 单次扫描：健康度 + 到期项 + 矛盾抽样（上限 sample_n 条近期记忆）
async function scanOnce(opts = {}) {
  const out = { at: new Date().toISOString(), ok: true };
  const sampleN = opts.sample_n || 40;
  try {
    out.health = await maintain.memoryHealth({});
  } catch (e) { out.health_error = String(e.message || e); out.ok = false; }
  try {
    const due = await review.dueRecalls({ limit: 200 });
    out.due_count = (due.rows || []).length;
  } catch (e) { out.due_error = String(e.message || e); out.ok = false; }
  // 矛盾抽样：取近期 N 条，逐条 detect_contradictions（只读、轻量）
  let conflictCount = 0, checked = 0;
  try {
    const all = await require('./insight').loadAllCached();
    const recent = all.slice(0, sampleN);
    for (const m of recent) {
      try {
        const r = await maintain.detectContradictions({ content: m.content, project: m.project, user: m.user, min_similarity: 0.7 });
        checked++;
        if (r && r.has_conflict) conflictCount++;
      } catch (e) { errC.other++; }
    }
    out.conflict_checked = checked;
    out.conflict_count = conflictCount;
  } catch (e) { out.conflict_error = String(e.message || e); out.ok = false; }
  // v1.19.0: 虚假完成检测——扫描 promise 记忆，验证声明是否真实，创建修复任务
  try {
    const vr = await verify.scanAndCreateFixes();
    out.verify = { checked: vr.checked, passed: vr.passed, failed: vr.failed, fix_created: vr.fix_created };
  } catch (e) { out.verify_error = String(e.message || e); out.ok = false; }
  // v1.20.0 (#3): 记忆质量自动化——过期事实检测 + 矛盾主动修复 + 置信度衰减
  if (config.CONFIG.quality_auto_enabled !== false) {
    try {
      const sf = await qualityAuto.scanStaleFacts();
      out.stale_facts = { checked: sf.checked, stale: sf.stale };
    } catch (e) { out.stale_error = String(e.message || e); }
    try {
      const rc = await qualityAuto.repairContradictions();
      out.conflict_repair = { checked: rc.checked, found: rc.conflicts_found, created: rc.tasks_created };
    } catch (e) { out.conflict_repair_error = String(e.message || e); }
    try {
      const dc = await qualityAuto.decayConfidence();
      out.confidence_decay = { checked: dc.checked, decayed: dc.decayed };
    } catch (e) { out.decay_error = String(e.message || e); }
  }
  try {
    backend.kvSet(LAST_KEY, JSON.stringify(out), '');
    // 保留最近 30 次历史
    let hist = [];
    try { const v = backend.kvGet(HISTORY_KEY, ''); if (v) hist = JSON.parse(v); } catch (e) {}
    hist.unshift(out); if (hist.length > 30) hist = hist.slice(0, 30);
    backend.kvSet(HISTORY_KEY, JSON.stringify(hist), '');
  } catch (e) { errC.other++; }
  return out;
}

function getLast() {
  try { const v = backend.kvGet(LAST_KEY, ''); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function getHistory() {
  try { const v = backend.kvGet(HISTORY_KEY, ''); return v ? JSON.parse(v) : []; } catch (e) { return []; }
}

function start(intervalMs) {
  if (timer) return;
  const iv = intervalMs || (Math.max(1, config.CONFIG.scheduler_interval_min || 30) * 60000);
  scanOnce().catch(() => {});
  timer = setInterval(() => { scanOnce().catch(() => {}); }, iv);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, scanOnce, getLast, getHistory };
