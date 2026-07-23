// v1.11.0 评测基准（gap⑦）：提供「自己能测自己」的指标尺子。
// 在已部署的 live 服务上跑（默认 127.0.0.1:8765），覆盖：
//   - 类别抽取准确率（category accuracy，需 LLM）
//   - 嵌套过滤器精度（filter precision，确定性）
//   - 去重精度（dedup precision）
//   - KV 往返（kv round-trip）
//   - 工作记忆提升（working promote）
// 测试数据打唯一 project 标签，结束后自动清理。输出 JSON 指标。
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
const PROJ = 'bench_eval_' + Date.now();
// 标注样本：[文本, 期望 mem_category, 匹配关键词]。
// 注：类别抽取必须走 /api/capture（事实抽取管线），POST /api/memories 是直存不抽取。
// 捕获管线会把第一人称改写成第三人称（「我」->「用户」），故按 distinctive 关键词回捞，而非按内容前缀。
const SAMPLES = [
  ['PostgreSQL 的 max_connections 默认是 100', 'fact', 'max_connections'],
  ['我更喜欢用 Vim 而不是 VSCode 写代码', 'preference', 'Vim'],
  ['我觉得 Rust 的错误处理比 Go 更严谨', 'opinion', 'Rust'],
  ['2026-07-01 我们上线了订单系统 v2', 'event', '订单系统'],
  ['部署流程是先构建镜像再推 registry 最后 kubectl rollout', 'procedure', 'registry'],
  ['小李很擅长用 Grafana 做监控大盘', 'skill', 'Grafana'],
];
const metrics = { env: null, category: { total: 0, correct: 0, accuracy: 0, cases: [] }, filter: { total: 0, pass: 0 }, dedup: { merges: 0, tested: 0 }, kv: { pass: false }, working: { promoted: false }, score: 0 };

async function addMem(content, extra) {
  const r = await api('POST', '/api/memories', Object.assign({ content, user: 'bench', project: PROJ, tags: [PROJ] }, extra || {}));
  return r.body;
}
async function cleanup() {
  await api('DELETE', '/api/memories/filter', { filters: { key: 'project', op: 'eq', value: PROJ }, project: PROJ });
  await api('DELETE', '/api/kv', { key: PROJ + '_k', org: PROJ });
}

async function main() {
  const h = await api('GET', '/api/health');
  metrics.env = { version: h.body && h.body.version, store: h.body && h.body.store, llm: !!(h.body && h.body.config && h.body.config.llm_enabled) };

  // ---- 类别抽取准确率（走 /api/capture 事实抽取管线）----
  for (const [text, expect, kw] of SAMPLES) {
    await api('POST', '/api/capture', { text, user: 'bench', project: PROJ, tags: [PROJ], extract_instructions: '请准确归类到 fact/preference/opinion/event/procedure/skill' });
    // 捕获为异步 LLM 抽取，耗时不定：轮询回捞（最多约 6s），避免固定 sleep 造成的假阴性。
    let row = null;
    for (let i = 0; i < 12 && !row; i++) {
      await sleep(500);
      const list = await api('GET', '/api/memories?project=' + PROJ + '&limit=50');
      row = (list.body && list.body.rows.find(r => (r.content || '').includes(kw))) || null;
    }
    const got = row ? row.mem_category : null;
    const correct = got === expect;
    metrics.category.total++; if (correct) metrics.category.correct++;
    metrics.category.cases.push({ text: text.slice(0, 20), expect, got, correct });
  }
  metrics.category.accuracy = metrics.category.total ? metrics.category.correct / metrics.category.total : 0;

  // ---- 嵌套过滤精度（确定性）----
  const cases = [
    { name: 'all(eq)', filters: { all: [ { key: 'mem_category', op: 'eq', value: 'fact' }, { key: 'project', op: 'eq', value: PROJ } ] }, expectMin: 1, expectAll: 'fact' },
    { name: 'any(eq)', filters: { any: [ { key: 'mem_category', op: 'eq', value: 'preference' }, { key: 'mem_category', op: 'eq', value: 'opinion' } ] }, expectAllIn: ['preference', 'opinion'] },
    { name: 'not', filters: { not: { key: 'mem_category', op: 'eq', value: 'fact' } }, expectNone: 'fact' },
    { name: 'contains(tags)', filters: { all: [ { key: 'tags', op: 'contains', value: PROJ } ] }, expectMin: 1 },
  ];
  for (const c of cases) {
    const f = encodeURIComponent(JSON.stringify(c.filters));
    const r = await api('GET', '/api/memories?project=' + PROJ + '&limit=100&filters=' + f);
    const rows = (r.body && r.body.rows) || [];
    let pass = true;
    if (c.expectMin !== undefined) pass = pass && rows.length >= c.expectMin;
    if (c.expectAll) pass = pass && rows.every(x => x.mem_category === c.expectAll);
    if (c.expectAllIn) pass = pass && rows.every(x => c.expectAllIn.includes(x.mem_category));
    if (c.expectNone) pass = pass && rows.every(x => x.mem_category !== c.expectNone);
    metrics.filter.total++; if (pass) metrics.filter.pass++;
    metrics.filter[c.name] = { n: rows.length, pass };
  }

  // ---- 去重精度 ----
  const a1 = await addMem('Redis 命中率长期保持在 80% 以上');
  await sleep(300);
  const a2 = await addMem('Redis 命中率长期保持在 80% 以上'); // 完全相同 -> 应合并
  await sleep(300);
  metrics.dedup.tested++;
  if (a2 && a2.merged) metrics.dedup.merges++;
  metrics.dedup.case1 = { merged: !!(a2 && a2.merged) };

  // ---- KV 往返 ----
  await api('POST', '/api/kv', { key: PROJ + '_k', value: 'v1', org: PROJ });
  const g = await api('GET', '/api/kv?key=' + encodeURIComponent(PROJ + '_k') + '&org=' + PROJ);
  metrics.kv.pass = !!(g.body && g.body.value === 'v1');

  // ---- 工作记忆提升 ----
  const w = await api('POST', '/api/working', { content: '临时：今天先写单测', user: 'bench', project: PROJ, tags: [PROJ] });
  if (w.body && w.body.id) {
    const p = await api('POST', '/api/working/' + w.body.id + '/promote');
    metrics.working.promoted = !!(p.body && p.body.promoted);
  }

  await cleanup();
  // 综合分（类别权重最高，其余均分）
  const filterAcc = metrics.filter.total ? metrics.filter.pass / metrics.filter.total : 0;
  const dedupAcc = metrics.dedup.tested ? metrics.dedup.merges / metrics.dedup.tested : 0;
  metrics.score = +(metrics.category.accuracy * 0.5 + filterAcc * 0.2 + dedupAcc * 0.1 + (metrics.kv.pass ? 0.1 : 0) + (metrics.working.promoted ? 0.1 : 0)).toFixed(3);
  console.log(JSON.stringify(metrics, null, 2));
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
