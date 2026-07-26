// 质量监控层（v1.8.0）：操作计数 / 错误计数 / 延迟，SQLite metrics 表按日累计 + 内存实时计数。
// 通过 memory 等模块调用 recordOp 采集；getMetrics 汇总供 /api/metrics 与管理界面质量监控 Tab 使用。
const config = require('./config');
const errC = config.errStats;
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

// v1.17.0 (#104): MCP 工具调用指标——各工具调用次数、P95 延迟、错误数。
const toolMetrics = { count: 0, byTool: {} };

function recordTool(name, ms, isError) {
  if (ms == null || isNaN(ms)) ms = 0;
  toolMetrics.count++;
  const t = toolMetrics.byTool[name] || (toolMetrics.byTool[name] = { count: 0, errors: 0, totalMs: 0, samples: [] });
  t.count++;
  if (isError) t.errors++;
  t.totalMs += ms;
  t.samples.push(ms);
  if (t.samples.length > 200) t.samples.shift();
}

// v1.17.0 (#104): 缓存/语义命中计数（供 /api/metrics 暴露命中率）。
const cacheStats = { embed_hits: 0, embed_miss: 0, semantic_searches: 0, keyword_searches: 0 };
function bumpEmbedCache(hits, miss) { cacheStats.embed_hits += (hits || 0); cacheStats.embed_miss += (miss || 0); }
function bumpSearch(mode) { if (mode === 'semantic' || mode === 'hybrid') cacheStats.semantic_searches++; else cacheStats.keyword_searches++; }

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
  } catch (e) { errC.other++; }
}

function _p95(samples) {
  if (!samples || !samples.length) return 0;
  const s = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(s.length * 0.95));
  return Math.round(s[idx] * 100) / 100;
}

function getMetrics() {
  let byDay = [];
  try {
    ensureTable();
    if (dbReady) {
      const d = backend.sqliteInit();
      byDay = d.prepare('SELECT day, SUM(count) AS total, SUM(errors) AS errors, SUM(total_ms) AS total_ms FROM metrics GROUP BY day ORDER BY day DESC LIMIT 30').all();
    }
  } catch (e) { errC.other++; }
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
    by_day: byDay.map(r => ({ day: r.day, total: r.total, errors: r.errors, avg_ms: r.total ? Math.round(r.total_ms / r.total * 100) / 100 : 0 })),
    mcp_tools: {
      total: toolMetrics.count,
      by_tool: Object.entries(toolMetrics.byTool)
        .map(([name, v]) => ({ name, count: v.count, errors: v.errors, avg_ms: v.count ? Math.round(v.totalMs / v.count * 100) / 100 : 0, p95_ms: _p95(v.samples) }))
        .sort((a, b) => b.count - a.count),
    },
    cache: {
      embed_hits: cacheStats.embed_hits,
      embed_miss: cacheStats.embed_miss,
      embed_hit_rate: (cacheStats.embed_hits + cacheStats.embed_miss) ? Math.round(cacheStats.embed_hits / (cacheStats.embed_hits + cacheStats.embed_miss) * 1000) / 1000 : 0,
      semantic_searches: cacheStats.semantic_searches,
      keyword_searches: cacheStats.keyword_searches,
    },
  };
}

module.exports = { recordOp, getMetrics, ensureTable, recordTool, bumpEmbedCache, bumpSearch, cacheStats };
