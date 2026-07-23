// 质量监控层（v1.8.0）：操作计数 / 错误计数 / 延迟，SQLite metrics 表按日累计 + 内存实时计数。
// 通过 memory 等模块调用 recordOp 采集；getMetrics 汇总供 /api/metrics 与管理界面质量监控 Tab 使用。
const config = require('./config');
const backend = require('./backend');

let dbReady = false;
function ensureTable() {
  try {
    const d = backend.sqliteInit();
    d.exec('CREATE TABLE IF NOT EXISTS metrics (op TEXT, day TEXT, count INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, total_ms INTEGER DEFAULT 0, PRIMARY KEY(op, day))');
    dbReady = true;
  } catch (e) { dbReady = false; }
}

// 内存实时计数器（进程生命周期）
const live = { count: 0, errors: 0, totalMs: 0, byOp: {} };

function recordOp(op, ms, isError) {
  if (ms == null || isNaN(ms)) ms = 0;
  live.count++;
  if (isError) live.errors++;
  live.totalMs += ms;
  const o = live.byOp[op] || (live.byOp[op] = { count: 0, errors: 0, totalMs: 0 });
  o.count++; if (isError) o.errors++; o.totalMs += ms;
  // 落盘按日累计（幂等 upsert），失败静默（监控不应影响主流程）
  try {
    ensureTable();
    if (!dbReady) return;
    const d = backend.sqliteInit();
    const day = new Date().toISOString().slice(0, 10);
    d.prepare('INSERT INTO metrics (op, day, count, errors, total_ms) VALUES (?,?,1,?,?) ' +
      'ON CONFLICT(op, day) DO UPDATE SET count=count+1, errors=errors+?, total_ms=total_ms+?')
      .run(op, day, isError ? 1 : 0, ms, isError ? 1 : 0, ms);
  } catch (e) {}
}

function getMetrics() {
  let byDay = [];
  try {
    ensureTable();
    if (dbReady) {
      const d = backend.sqliteInit();
      byDay = d.prepare('SELECT day, SUM(count) AS total, SUM(errors) AS errors, SUM(total_ms) AS total_ms FROM metrics GROUP BY day ORDER BY day DESC LIMIT 30').all();
    }
  } catch (e) {}
  const avg = live.count ? (live.totalMs / live.count) : 0;
  return {
    live: {
      total: live.count,
      errors: live.errors,
      avg_ms: Math.round(avg * 100) / 100,
      error_rate: live.count ? Math.round((live.errors / live.count) * 1000) / 1000 : 0
    },
    by_op: Object.entries(live.byOp)
      .map(([op, v]) => ({ op, count: v.count, errors: v.errors, avg_ms: v.count ? Math.round(v.totalMs / v.count * 100) / 100 : 0 }))
      .sort((a, b) => b.count - a.count),
    by_day: byDay.map(r => ({ day: r.day, total: r.total, errors: r.errors, avg_ms: r.total ? Math.round(r.total_ms / r.total * 100) / 100 : 0 }))
  };
}

module.exports = { recordOp, getMetrics, ensureTable };
