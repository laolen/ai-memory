#!/usr/bin/env node
/**
 * ai-memory v1.5.0 评测脚本（本地/云端均可，默认打 128 服务）
 * 用法：
 *   node eval/evaluate.js                      # 打默认 http://192.168.110.128:8765
 *   BASE=http://127.0.0.1:8765 node eval/evaluate.js
 * 测试内容：
 *   1) 抽取/入库：用 /api/capture 灌入语料，统计 captured/skipped
 *   2) 检索召回：每条语料对应一个查询，统计 hit@3
 *   3) 分类过滤：category=semantic 过滤是否生效（无报错且返回同批）
 *   4) 来源信任：相同内容 human vs agent，human 排序分应 >= agent
 *   5) 实体链接加权：若 kg 已启用（entity_names 非空），查询命中实体时相关记忆分数应被抬高
 * 结束自动清理测试项目 eval_v150 的记忆。
 */
const BASE = process.env.BASE || 'http://192.168.110.128:8765';
const PROJECT = 'eval_v150';

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  const txt = await r.text();
  try { return { status: r.status, body: txt ? JSON.parse(txt) : null }; }
  catch (e) { return { status: r.status, body: txt }; }
}
async function capture(text, source) {
  return api('/api/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, project: PROJECT, tags: ['eval'], source: source || null }) });
}
async function search(q, extra = '') {
  return api('/api/memories?q=' + encodeURIComponent(q) + '&mode=hybrid&limit=10&project=' + PROJECT + extra);
}
async function listMemories(extra = '') {
  return api('/api/memories?limit=50&project=' + PROJECT + extra);
}
async function del(id) {
  return api('/api/memories/' + encodeURIComponent(id), { method: 'DELETE' });
}

// 语料：content -> 期望能搜到的查询
const CORPUS = [
  { text: '用户 laolen 决定：所有 AI 回复一律用简体中文，不用的话他看不懂。', q: 'laolen 中文 回复' },
  { text: '团队把 ai-memory 的冲突阈值设为 0.7，相似度高于此值才走冲突调和。', q: 'ai-memory 冲突阈值' },
  { text: '项目 Aurora 由小李负责，使用 PostgreSQL 作为主存储。', q: 'Aurora 负责人 小李' },
  { text: '会议决定下周三（2026-07-29）发布 v1.5.0，由 ops 团队灰度。', q: 'v1.5.0 发布 时间' },
  { text: '用户偏好本地小模型，不要常驻显存。', q: '本地 小模型 显存' },
];

function hitRate(rows, q) {
  // 用查询关键词做简单子串命中判定（评测用，非生产检索）
  const kw = q.split(/\s+/).filter(Boolean);
  return rows.filter(r => kw.every(k => (r.content || '').includes(k))).length > 0;
}

(async () => {
  console.log('=== ai-memory v1.5.0 eval ===');
  console.log('BASE =', BASE, ' PROJECT =', PROJECT);
  const health = await api('/api/health');
  if (!health.body || !health.body.ok) { console.error('服务不可达，退出'); process.exit(1); }
  console.log('health:', JSON.stringify(health.body));

  // 1) 抽取/入库
  let totalCaptured = 0, totalSkipped = 0;
  for (const c of CORPUS) {
    const r = await capture(c.text);
    if (r.body && r.body.ok) {
      totalCaptured += (r.body.captured || 0);
      totalSkipped += (r.body.skipped || 0);
      console.log(`  capture: captured=${r.body.captured} skipped=${r.body.skipped} mode=${r.body.mode}`);
    } else {
      console.log('  capture failed:', JSON.stringify(r.body));
    }
  }
  // 等 ES 近实时刷新
  await new Promise(r => setTimeout(r, 1500));

  // 2) 检索召回 hit@3
  let hits = 0;
  for (const c of CORPUS) {
    const r = await search(c.q);
    const rows = (r.body && r.body.rows) || [];
    const ok = hitRate(rows.slice(0, 3), c.q);
    if (ok) hits++;
    console.log(`  recall[${ok ? 'OK' : 'MISS'}] q="${c.q}" top=${rows.length}`);
  }
  const recall = (hits / CORPUS.length * 100).toFixed(0);

  // 3) 分类过滤
  const sem = await listMemories('&category=semantic');
  const bad = await listMemories('&category=episodic');
  console.log(`  category filter: semantic=${sem.body ? sem.body.count : '?'} episodic=${bad.body ? bad.body.count : '?'} (heuristic 捕获均为 semantic)`);

  // 4) 来源信任：相同内容 human vs agent
  const sameText = '运维窗口安排在每周二凌晨 02:00-04:00，禁止在此期间发布。';
  await capture(sameText, { type: 'agent' });
  await capture(sameText, { type: 'human' });
  await new Promise(r => setTimeout(r, 1500));
  const sr = await search('运维窗口 周二 凌晨 发布');
  const rows = (sr.body && sr.body.rows) || [];
  const human = rows.find(r => (r.source && JSON.stringify(r.source).includes('human')) || (typeof r.source === 'string' && r.source === 'human'));
  const agent = rows.find(r => (r.source && JSON.stringify(r.source).includes('agent')) || (typeof r.source === 'string' && r.source === 'agent'));
  let trustOk = 'N/A';
  if (human && agent) {
    trustOk = (human.score >= agent.score) ? 'OK (human>=agent)' : 'WEAK (human<agent)';
    console.log(`  source trust: human.score=${human.score?.toFixed(3)} agent.score=${agent.score?.toFixed(3)} -> ${trustOk}`);
  } else {
    console.log('  source trust: 未同时取到 human/agent 记忆（可能已去重合并），trustOk=N/A');
  }

  // 5) 实体链接加权（依赖 kg 启用）
  const kgOn = health.body.config && health.body.config.kg_enabled;
  let entBoost = 'SKIPPED (kg disabled)';
  if (kgOn) {
    // 查询含实体「Aurora」的记忆应被加权
    const e = await search('Aurora 负责人');
    const rowsE = (e.body && e.body.rows) || [];
    const aurora = rowsE.find(r => (r.entity_names || []).includes('Aurora'));
    entBoost = aurora ? `OK (命中 Aurora 记忆 score=${aurora.score?.toFixed(3)})` : 'NO Aurora memory found';
    console.log('  entity boost:', entBoost);
  } else {
    console.log('  entity boost:', entBoost);
  }

  // 汇总
  console.log('\n=== 评测汇总 ===');
  console.log(`入库: captured=${totalCaptured} skipped=${totalSkipped}`);
  console.log(`检索召回 hit@3: ${hits}/${CORPUS.length} = ${recall}%`);
  console.log(`分类过滤: semantic=${sem.body ? sem.body.count : '?'} / episodic=${bad.body ? bad.body.count : '?'}`);
  console.log(`来源信任: ${trustOk}`);
  console.log(`实体加权: ${entBoost}`);

  // 清理
  const all = await listMemories();
  const ids = (all.body && all.body.rows) ? all.body.rows.map(r => r.id) : [];
  for (const id of ids) { try { await del(id); } catch (e) {} }
  console.log(`\n已清理测试记忆 ${ids.length} 条（项目 ${PROJECT}）。`);
  process.exit(0);
})().catch(e => { console.error('eval error:', e); process.exit(1); });
