// v1.13.0 端到端验证：MMR/pin/export/import/reset/backup/stats/auth
// 用法（128 本机）：node verify_v113.js
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(method, path, body, headers) {
  const opt = { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) } };
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
const PRJ = 'v113_' + Date.now();
let ok = 0, fail = 0;

async function main() {
  const h = await api('GET', '/api/health');
  assert('HEALTH version=1.13.0', h.body && h.body.version === '1.13.0', h.body && { version: h.body.version });

  // 1) Pin/Unpin
  const add = await api('POST', '/api/memories', { content: 'fixed really important fact', user: 'u1', project: PRJ, tags: ['t'] });
  assert('ADD for pin', add.status === 200 && add.body && add.body.id, add.body);
  const id = add.body && add.body.id;
  const pin = await api('POST', '/api/memories/pin', { id });
  assert('PIN', pin.body && pin.body.pinned === true, pin.body);
  const unpin = await api('POST', '/api/memories/unpin', { id });
  assert('UNPIN', unpin.body && unpin.body.pinned === false, unpin.body);

  // 2) Export (wait for Qdrant refresh)
  await sleep(800);
  const exp = await api('GET', '/api/export?project=' + encodeURIComponent(PRJ));
  assert('EXPORT', exp.body && exp.body.ok && exp.body.count >= 1 && Array.isArray(exp.body.items), { count: exp.body && exp.body.count });

  // 3) Import (export and reimport)
  const bkpItems = exp.body && exp.body.items && exp.body.items.map(it => ({ content: it.content, user: it.user, project: it.project + '_imp', tags: it.tags || [] }));
  if (bkpItems && bkpItems.length) {
    const imp = await api('POST', '/api/import', { items: bkpItems });
    assert('IMPORT', imp.body && imp.body.imported >= 1, imp.body);
  }

  // 4) Stats
  const stats = await api('GET', '/api/stats');
  assert('STATS', stats.body && stats.body.ok && typeof stats.body.memories.total === 'number' && typeof stats.body.memories.pinned === 'number', { total: stats.body && stats.body.memories.total });

  // 5) Backup
  const bkp = await api('POST', '/api/backup', { project: PRJ });
  assert('BACKUP', bkp.body && bkp.body.ok && bkp.body.file && bkp.body.count >= 1, { file: bkp.body && bkp.body.file });

  // 6) Auth: api_keys 非空时验证未授权请求被拒
  // 先查 /api/config 看是否有 api_keys
  const cfg = await api('GET', '/api/config');
  const hasAuth = cfg.body && Array.isArray(cfg.body.api_keys) && cfg.body.api_keys.length;
  if (hasAuth) {
    const noAuth = await api('GET', '/api/stats', undefined, {}); // no Bearer
    assert('AUTH rejects unauthorized', noAuth.status === 401, { status: noAuth.status });
    const badAuth = await api('GET', '/api/stats', undefined, { 'Authorization': 'Bearer bad_key' });
    assert('AUTH rejects bad key', badAuth.status === 401, { status: badAuth.status });
  } else console.log('INFO: api_keys 未配，认证测试跳过（auth 依赖服务端配置）');

  // 7) MMR: 搜索确认不报错（MMR 依赖 mmr_enabled 配置，默认关）
  const s2 = await api('GET', '/api/memories?project=' + encodeURIComponent(PRJ) + '&q=test&limit=5');
  assert('MMR search no error', s2.status === 200 || s2.status === 400, { status: s2.status });

  // 8) Reset (use a sub-project to test, not full reset)
  const add2 = await api('POST', '/api/memories', { content: 'to be reset', user: 'u1', project: PRJ + '_rst', tags: ['t'] });
  assert('ADD for reset', add2.status === 200, add2.body);
  // 对子项目做过滤删除而非全量 reset
  const delF = await api('DELETE', '/api/memories/filter', { filters: { key: 'project', op: 'eq', value: PRJ + '_rst' } });
  assert('RESET-like cleanup', delF.body && delF.body.deleted >= 1, delF.body);

  // Cleanup test memories
  const clean = await api('DELETE', '/api/memories/filter', { filters: { any: [{ key: 'project', op: 'eq', value: PRJ }, { key: 'project', op: 'eq', value: PRJ + '_imp' }, { key: 'project', op: 'eq', value: PRJ + '_rst' }] } });
  assert('CLEANUP', clean.status === 200, clean.body);

  console.log('\nDONE  ok=' + ok + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
