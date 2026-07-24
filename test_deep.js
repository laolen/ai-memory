// v1.13.0 深度边缘测试：pin 异常/游标翻页/并发/重置保护/错误输入/空结果
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opt);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
function assert(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  if (cond) ok++; else fail++;
  return cond;
}
const TAG = 'deep_' + Date.now();
let ok = 0, fail = 0;

async function main() {
  // ===== 1) 版本 =====
  const h = await api('GET', '/api/health');
  assert('HEALTH v1.13.0', h.body && h.body.version === '1.13.0', { version: h.body && h.body.version });

  // ===== 2) Pin 边缘用例 =====
  // 2a. pin 不存在的 id（REST error handler 返回 500，检查错误信息）
  const pinBad = await api('POST', '/api/memories/pin', { id: 'nonexistent-id-12345' });
  assert('PIN non-existent returns error', pinBad.status >= 400, { status: pinBad.status });

  // 2b. unpin 不存在的 id
  const unpinBad = await api('POST', '/api/memories/unpin', { id: 'nonexistent-id-12345' });
  assert('UNPIN non-existent returns error', unpinBad.status >= 400, { status: unpinBad.status });

  // 2c. 新增一条即刻 pin，验证返回 pinned=true
  const addPin = await api('POST', '/api/memories', { content: 'pin edge test', user: 'tester', project: TAG, tags: ['t'], pinned: true });
  assert('ADD with pinned=true returns pinned', addPin.body && addPin.body.pinned === true, addPin.body && { pinned: addPin.body.pinned });
  const pId = addPin.body && addPin.body.id;

  // ===== 3) 游标翻页 =====
  // 插入 5 条记忆到同一个子项目
  const curProj = TAG + '_cursor';
  let cursorIds = [];
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/memories', { content: 'cursor test item ' + i, user: 'tester', project: curProj, tags: ['t'] });
    cursorIds.push(r.body && r.body.id);
  }
  await sleep(3000);

  // 搜索返回 limit=2，应含 next_cursor
  const page1 = await api('GET', '/api/memories?project=' + encodeURIComponent(curProj) + '&q=cursor+test&limit=2');
  assert('CURSOR page1 has rows', page1.body && Array.isArray(page1.body.rows) && page1.body.rows.length > 0, { n: page1.body && page1.body.rows.length });
  assert('CURSOR page1 has next_cursor field', page1.body && 'next_cursor' in page1.body, { next_cursor: page1.body && page1.body.next_cursor });

  // 列表 limit=2（Qdrant scroll 返回 2 条，可能无 cursor；只验证结构）
  const list1 = await api('GET', '/api/memories?project=' + encodeURIComponent(curProj) + '&limit=2');
  assert('CURSOR list page1 has next_cursor field', list1.body && 'next_cursor' in list1.body, { next_cursor: list1.body && list1.body.next_cursor, count: list1.body && list1.body.count });

  // 列表 limit=10（> 5 条）时 next_cursor 应为 null
  const listAll = await api('GET', '/api/memories?project=' + encodeURIComponent(curProj) + '&limit=10');
  assert('CURSOR list all has no next_cursor', listAll.body && listAll.body.next_cursor == null, { next_cursor: listAll.body && listAll.body.next_cursor });

  // ===== 4) Export/Import 边缘 =====
  // 4a. 空数组导入
  const impEmpty = await api('POST', '/api/import', { items: [] });
  assert('IMPORT empty array', impEmpty.body && impEmpty.body.imported === 0, impEmpty.body && { imported: impEmpty.body.imported });

  // 4b. 无效 body 导入（items 不是数组）
  const impBad = await api('POST', '/api/import', { items: 'not an array' });
  assert('IMPORT bad items structure', impBad.status >= 400, { status: impBad.status, body: impBad.body });

  // 4c. 带 id 值重复导入（去重不产生新增，但不应报错）
  if (addPin.body && addPin.body.id) {
    const dupImport = await api('POST', '/api/import', { items: [{ id: addPin.body.id, content: 'duplicate id import', user: 'tester', project: TAG + '_dup' }] });
    // SQLite 有主键约束，Qdrant 可重复 upsert。导入尝试会失败行（id冲突不插入 SQLite 但 Qdrant 可 upsert）
    // 不严格要求计数，只要求不抛 500
    assert('IMPORT duplicate id no crash', dupImport.status === 200, { status: dupImport.status });
  }

  // 4d. 导出 limit=1
  const expOne = await api('GET', '/api/export?limit=1');
  assert('EXPORT limit=1 no error', expOne.status === 200, { status: expOne.status, count: expOne.body && expOne.body.count });

  // ===== 5) Stats 项目过滤 =====
  const stProj = await api('GET', '/api/stats?project=' + encodeURIComponent(TAG));
  assert('STATS with project filter', stProj.body && stProj.body.ok && typeof stProj.body.memories.total === 'number', stProj.body && { total: stProj.body.memories.total });

  // ===== 6) Reset 保护 =====
  const resetNo = await api('POST', '/api/reset', { confirm: false });
  assert('RESET confirm=false fails', resetNo.body && resetNo.body.ok === false, resetNo.body);
  const resetNone = await api('POST', '/api/reset', {});
  assert('RESET no confirm field fails', resetNone.body && resetNone.body.ok === false, resetNone.body);

  // ===== 7) 并发写入测试（快速 5 条） =====
  const batchProj = TAG + '_batch';
  let addAll = [];
  for (let i = 0; i < 5; i++) {
    addAll.push(api('POST', '/api/memories', { content: 'concurrent item ' + i + ' with enough text for embedding', user: 'tester', project: batchProj, tags: ['t'] }));
  }
  const results = await Promise.all(addAll);
  const okCount = results.filter(r => r.status === 200).length;
  assert('CONCURRENT 5 adds', okCount === 5, { ok: okCount });

  // ===== 8) 错误输入 REST =====
  // 8a. 空 content 新增
  const emptyContent = await api('POST', '/api/memories', { content: '', user: 'tester' });
  // 应该能正常返回（空内容也能存，没有必填校验）
  assert('ADD empty content no crash', emptyContent.status === 200, { status: emptyContent.status });

  // 8b. 超大 content（10K 字符）
  const bigContent = await api('POST', '/api/memories', { content: 'x'.repeat(10000), user: 'tester', project: TAG + '_big' });
  assert('ADD large content (10K)', bigContent.status === 200, { status: bigContent.status });

  // ===== 9) 清理 =====
  const clean = await api('DELETE', '/api/memories/filter', {
    filters: { any: [
      { key: 'project', op: 'eq', value: TAG },
      { key: 'project', op: 'eq', value: curProj },
      { key: 'project', op: 'eq', value: batchProj },
      { key: 'project', op: 'eq', value: TAG + '_big' },
      { key: 'project', op: 'eq', value: TAG + '_dup' },
    ]}
  });
  assert('CLEANUP all test data', clean.status === 200, clean.body);

  console.log('\n=== DEEP TEST: ok=' + ok + ' fail=' + fail + ' ===');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
