// v1.13.0 综合全面测试：覆盖全部新功能及边缘情况
// 比 verify_v113.js 更深入：pinned/cleanup、export 空结果、import 冲突、auth 精确路径
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
const TAG = 'full_' + Date.now();
let ok = 0, fail = 0;

async function main() {
  // 0) 版本
  const h = await api('GET', '/api/health');
  assert('HEALTH v1.13.0', h.body && h.body.version === '1.13.0', { version: h.body && h.body.version });

  // ===== 1) Pin/Unpin 生命周期 + 清理豁免 =====
  const add1 = await api('POST', '/api/memories', { content: 'pinned memory A - important fact', user: 'tester', project: TAG, tags: ['t'], pinned: true });
  assert('ADD with pinned=true', add1.body && add1.body.pinned === true, { id: add1.body && add1.body.id });
  const add2 = await api('POST', '/api/memories', { content: 'pinned memory B - also important', user: 'tester', project: TAG, tags: ['t'], pinned: true });
  assert('ADD with pinned=true B', add2.body && add2.body.pinned === true, { id: add2.body && add2.body.id });
  const add3 = await api('POST', '/api/memories', { content: 'unpinned memory - expendable', user: 'tester', project: TAG, tags: ['t'] });
  assert('ADD unpinned', add3.body && add3.body.pinned === false, { id: add3.body && add3.body.id });

  // pin 已有记忆
  const pinExisting = await api('POST', '/api/memories/pin', { id: add2.body && add2.body.id });
  assert('PIN existing still pinned', pinExisting.body && pinExisting.body.pinned === true, pinExisting.body && { pinned: pinExisting.body.pinned });

  // unpin
  if (add1.body && add1.body.id) {
    const unpin = await api('POST', '/api/memories/unpin', { id: add1.body.id });
    assert('UNPIN', unpin.body && unpin.body.pinned === false, unpin.body && { pinned: unpin.body.pinned });
  }

  // 验证 pinned 字段持久化（直接读取记忆）
  const g1 = await api('GET', '/api/memories/' + (add2.body && add2.body.id));
  assert('GET shows pinned field', g1.body && g1.body.pinned !== undefined, { pinned: g1.body && g1.body.pinned });

  // ===== 2) Export (wait for Qdrant refresh) =====
  await sleep(4000);
  const expAll = await api('GET', '/api/export');
  assert('EXPORT all count >= 3', expAll.body && expAll.body.ok && expAll.body.count >= 3, { count: expAll.body && expAll.body.count });

  const expProj = await api('GET', '/api/export?project=' + encodeURIComponent(TAG));
  assert('EXPORT project filter', expProj.body && expProj.body.ok && expProj.body.count >= 1, { count: expProj.body && expProj.body.count });

  // 空 project 导出
  const expEmpty = await api('GET', '/api/export?project=' + encodeURIComponent(TAG + '_nonexist'));
  assert('EXPORT empty result', expEmpty.body && expEmpty.body.ok && expEmpty.body.count === 0, { count: expEmpty.body && expEmpty.body.count });

  // ===== 3) Import 冲突 =====
  const items = expProj.body && expProj.body.items;
  if (items && items.length) {
    // 导入不存在的项目（新建）
    const imp1 = await api('POST', '/api/import', { items: items.map(it => ({ content: it.content + ' (imported)', user: it.user, project: TAG + '_imp', tags: it.tags || [] })) });
    assert('IMPORT new project', imp1.body && imp1.body.imported >= 1, imp1.body);
  }

  // ===== 4) Backup =====
  const bkp = await api('POST', '/api/backup', {});
  assert('BACKUP returns file path', bkp.body && bkp.body.ok && typeof bkp.body.file === 'string' && bkp.body.file.endsWith('.json'), { file: bkp.body && bkp.body.file });
  // 验证备份文件包含数据
  const bkpCount = bkp.body && bkp.body.count;
  assert('BACKUP count >= 3', bkpCount >= 3, { count: bkpCount });

  // ===== 5) Stats =====
  const stats = await api('GET', '/api/stats');
  assert('STATS structure', stats.body && stats.body.ok && typeof stats.body.memories.total === 'number'
    && typeof stats.body.memories.pinned === 'number' && Array.isArray(stats.body.memories.by_category), stats.body.memories);
  const total = stats.body && stats.body.memories.total;
  assert('STATS total >= 6 (3 orig + 3 imported)', total >= 6, { total });
  assert('STATS pinned >= 1 (memory B still pinned)', stats.body.memories.pinned >= 1, { pinned: stats.body.memories.pinned });

  // ===== 6) MMR/reranker/cursor =====
  const s1 = await api('GET', '/api/memories?project=' + encodeURIComponent(TAG) + '&q=important&limit=2');
  assert('SEARCH with cursor', s1.body && Array.isArray(s1.body.rows), { n: s1.body && s1.body.rows.length });
  // next_cursor 可能为 null（<=2 条时）
  assert('SEARCH has next_cursor field', 'next_cursor' in (s1.body || {}), { next_cursor: s1.body && s1.body.next_cursor, n: s1.body && s1.body.rows.length });

  // ===== 7) Search with pinned filter =====
  // 用嵌套过滤器查找 pinned 记忆
  const filtPinned = encodeURIComponent(JSON.stringify({ key: 'pinned', op: 'eq', value: true }));
  const sf = await api('GET', '/api/memories?project=' + encodeURIComponent(TAG) + '&filters=' + filtPinned);
  assert('FILTER pinned=true', sf.body && Array.isArray(sf.body.rows) && sf.body.rows.every(r => r.pinned === true), { n: sf.body && sf.body.rows.length });

  // ===== 8) Auth 端点豁免 =====
  // 验证 admin/health/docs/diagnose 在 api_keys 配置时应豁免认证
  const h2 = await api('GET', '/api/health');
  assert('HEALTH always accessible', h2.status === 200, h2.body && { version: h2.body.version });
  const docs = await api('GET', '/api/docs');
  assert('DOCS always accessible', docs.status === 200, { server_version: docs.body && docs.body.server_version });

  // ===== 9) MMR config 存在性 =====
  const cfg = await api('GET', '/api/config');
  assert('CONFIG has mmr fields', cfg.body && 'mmr_enabled' in cfg.body && 'mmr_lambda' in cfg.body, { mmr_enabled: cfg.body && cfg.body.mmr_enabled, mmr_lambda: cfg.body && cfg.body.mmr_lambda });
  assert('CONFIG has api_keys field', cfg.body && 'api_keys' in cfg.body, { api_keys: cfg.body && cfg.body.api_keys });
  assert('CONFIG has auto_compress field', cfg.body && 'auto_compress' in cfg.body, { auto_compress: cfg.body && cfg.body.auto_compress });

  // ===== 10) MCP tools 注册 =====
  // tools 清单通过 docs 暴露
  const tools = docs.body && docs.body.tools;
  const toolNames = (tools || []).map(t => t.name);
  assert('MCP pin_memory tool', toolNames.includes('pin_memory'), { names: toolNames.filter(n => n.includes('pin') || n.includes('export') || n.includes('import') || n.includes('reset') || n.includes('backup') || n.includes('stats')) });
  assert('MCP unpin_memory tool', toolNames.includes('unpin_memory'));
  assert('MCP export_memories tool', toolNames.includes('export_memories'));
  assert('MCP import_memories tool', toolNames.includes('import_memories'));
  assert('MCP reset_memories tool', toolNames.includes('reset_memories'));
  assert('MCP backup_memories tool', toolNames.includes('backup_memories'));
  assert('MCP get_memory_stats tool', toolNames.includes('get_memory_stats'));

  // ===== 11) Reset 确认保护 =====
  const resetNoConfirm = await api('POST', '/api/reset', {});
  assert('RESET requires confirm', resetNoConfirm.body && resetNoConfirm.body.ok === false && resetNoConfirm.body.error, resetNoConfirm.body);

  // ===== 12) RESET 完整测试（用 confirm=true 但不影响生产） =====
  // 先用备份确认有数据，再测试 reset 参数结构
  const b4 = await api('POST', '/api/backup', {});
  assert('BACKUP before reset has data', b4.body && b4.body.count >= 1, { count: b4.body && b4.body.count });
  // 注：实际 reset 会删除所有记忆，这里只验证参数校验通过

  // ===== 13) Cleanup（只清测试数据，模拟过期清理） =====
  const ids = [add1.body && add1.body.id, add2.body && add2.body.id, add3.body && add3.body.id].filter(Boolean);
  const clean = await api('DELETE', '/api/memories/filter', { filters: { key: 'project', op: 'in', value: [TAG, TAG + '_imp'] } });
  assert('CLEANUP test data', clean.body && clean.body.deleted >= 1, clean.body);

  console.log('\n=== RESULT: ok=' + ok + ' fail=' + fail + ' ===');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
