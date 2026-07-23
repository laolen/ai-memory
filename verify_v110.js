const http = require('http');
const BASE = 'http://localhost:8765';
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: data ? { 'Content-Type': 'application/json' } : {} }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(s) }); } catch (e) { resolve({ code: res.statusCode, body: s }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const R = 'v110_' + Date.now();
(async () => {
  const ri = await req('POST', '/api/reindex');
  console.log('REINDEX', JSON.stringify(ri.body));

  const a1 = await req('POST', '/api/memories', { content: '支付网关超时阈值设置为 60 秒，超时即降级', project: R, tags: ['pay'] });
  const a2 = await req('POST', '/api/memories', { content: '数据库主从延迟监控告警线 200ms', project: R, tags: ['db'] });
  console.log('ADD1', a1.body.id, 'ADD2', a2.body.id);

  const kw = await req('GET', '/api/memories?q=' + encodeURIComponent('支付网关超时') + '&mode=keyword&project=' + R + '&limit=10');
  const kwIds = (kw.body.rows || []).map(r => r.id);
  console.log('FTS_KEYWORD count=', kw.body.count, 'hitA1=', kwIds.includes(a1.body.id), 'hitA2=', kwIds.includes(a2.body.id));

  const kg = await req('GET', '/api/kg?project=' + R);
  console.log('KG entities=', (kg.body.entities || []).length, 'relations=', (kg.body.relations || []).length, 'sample=', JSON.stringify((kg.body.entities || []).slice(0, 3)));

  const a3 = await req('POST', '/api/memories', { content: '支付网关超时阈值设置为 60 秒，超时即降级', project: R + '_OTHER', tags: ['pay'] });
  console.log('ADD3(OTHER project) merged=', !!a3.body.merged);
  const a4 = await req('POST', '/api/memories', { content: '支付网关超时阈值设置为 60 秒，超时即降级', project: R, tags: ['pay'] });
  console.log('ADD4(same project) merged=', !!a4.body.merged, 'merged_from=', a4.body.merged_from);

  const ch = await req('GET', '/api/memories/' + a1.body.id + '/history');
  console.log('HISTORY op=', (ch.body.history || []).map(h => h.op).join(','));

  await req('POST', '/api/memories', { content: 'Redis 缓存命中率上周跌到 80%', project: R, tags: ['redis'] });
  await req('POST', '/api/memories', { content: 'Redis 主从同步延迟在高峰期达到 150ms', project: R, tags: ['redis'] });
  await req('POST', '/api/memories', { content: 'Redis 内存占用超过 12GB 触发淘汰', project: R, tags: ['redis'] });
  const co = await req('POST', '/api/consolidate', { project: R });
  console.log('CONSOLIDATE', JSON.stringify(co.body));

  for (const id of [a1.body.id, a2.body.id, a3.body.id, a4.body.id]) {
    if (id) await req('DELETE', '/api/memories/' + id);
  }
  const lst = await req('GET', '/api/memories?project=' + R + '&limit=100');
  for (const r of (lst.body.rows || [])) await req('DELETE', '/api/memories/' + r.id);
  const lst2 = await req('GET', '/api/memories?project=' + R + '&limit=100');
  console.log('CLEANUP leftover R=', (lst2.body.rows || []).length);
  const lst3 = await req('GET', '/api/memories?project=' + R + '_OTHER' + '&limit=100');
  for (const r of (lst3.body.rows || [])) await req('DELETE', '/api/memories/' + r.id);
  console.log('DONE');
})().catch(e => { console.error('ERR', e); process.exit(1); });
