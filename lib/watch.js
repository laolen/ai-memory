// 标签级订阅层（#94）：为某个标签注册一个 http(s) 回调，当新增记忆带该标签时主动推送通知。
// 订阅关系持久化在 kv_store（确定性精确存储），doAdd 后由 notifyForMemory 钩子触发（fire-and-forget）。
const crypto = require('crypto');
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');

const WATCH_KEY = 'watch:tags';

function badReq(msg) { const e = new Error(msg); e.statusCode = 400; return e; }

function loadWatches() {
  try { const v = backend.kvGet(WATCH_KEY, ''); if (!v) return []; const arr = JSON.parse(v); return Array.isArray(arr) ? arr : []; } catch (e) { return []; }
}
function saveWatches(list) { backend.kvSet(WATCH_KEY, JSON.stringify(list), ''); }

// #94a 注册标签订阅。同 tag+url+project 幂等（返回既有订阅）。
function watchTag(a = {}) {
  const tag = String(a.tag || '').trim();
  const url = String(a.url || '').trim();
  if (!tag) throw badReq('tag is required');
  if (!/^https?:\/\//i.test(url)) throw badReq('valid http(s) url is required');
  const list = loadWatches();
  const proj = a.project || null;
  const exists = list.find(w => w.tag === tag && w.url === url && (w.project || null) === proj);
  if (exists) return { ok: true, id: exists.id, existing: true, watch: exists };
  const w = { id: crypto.randomUUID(), tag, url, project: proj, note: a.note || null, created_at: new Date().toISOString() };
  list.push(w); saveWatches(list);
  return { ok: true, id: w.id, watch: w };
}

// #94b 取消订阅：按 id 精确删除，或按 tag(+可选 url/project)批量删除。
function unwatchTag(a = {}) {
  const list = loadWatches();
  let next;
  if (a.id) next = list.filter(w => w.id !== a.id);
  else if (a.tag) next = list.filter(w => !(w.tag === a.tag && (!a.url || w.url === a.url) && (a.project === undefined || (w.project || null) === (a.project || null))));
  else throw badReq('id or tag is required');
  const removed = list.length - next.length;
  saveWatches(next);
  return { ok: true, removed };
}

// #94c 列出订阅（可按 tag/project 过滤）。
function listWatches(a = {}) {
  let list = loadWatches();
  if (a.tag) list = list.filter(w => w.tag === a.tag);
  if (a.project !== undefined && a.project !== null) list = list.filter(w => (w.project || null) === a.project);
  return { ok: true, count: list.length, watches: list };
}

// doAdd 后钩子：匹配到订阅标签则推送通知（不阻塞主流程）。
function notifyForMemory(doc) {
  try {
    if (!doc || !Array.isArray(doc.tags) || !doc.tags.length) return;
    const list = loadWatches();
    if (!list.length) return;
    const tagSet = new Set(doc.tags.map(String));
    const proj = doc.project || null;
    for (const w of list) {
      if (!tagSet.has(w.tag)) continue;
      if (w.project && w.project !== proj) continue; // 订阅限定项目时只推同项目
      postNotify(w, doc);
    }
  } catch (e) { errC.webhook++; }
}

const DEAD_KEY = 'watch:dead';
const MAX_RETRY = 3;
function pushDead(w, doc, lastError) {
  try {
    let arr = [];
    const v = backend.kvGet(DEAD_KEY, '');
    if (v) { try { arr = JSON.parse(v); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; } }
    arr.push({
      watch_id: w.id, tag: w.tag, url: w.url, project: w.project || null,
      memory: { id: doc.id, content: doc.content, tags: doc.tags, project: doc.project || null, user: doc.user || null },
      last_error: String(lastError || ''), failed_at: new Date().toISOString(),
    });
    if (arr.length > 200) arr = arr.slice(-200);
    backend.kvSet(DEAD_KEY, JSON.stringify(arr), '');
  } catch (e) { errC.other++; }
}

async function postNotify(w, doc, attempt) {
  attempt = attempt || 1;
  const body = JSON.stringify({
    event: 'tag.matched', tag: w.tag, watch_id: w.id,
    memory: { id: doc.id, content: doc.content, tags: doc.tags, project: doc.project || null, user: doc.user || null, created_at: doc.created_at },
    at: new Date().toISOString(),
  });
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(w.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
  } catch (e) {
    errC.webhook++;
    if (attempt < MAX_RETRY) {
      // 指数退避后重试（1s, 2s）
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      return postNotify(w, doc, attempt + 1);
    }
    pushDead(w, doc, e && e.message); // 最终失败 → 死信暂存
  } finally { clearTimeout(to); }
}

// 列出死信（推送最终失败、待重发的通知）
function listWatchDead() {
  try { const v = backend.kvGet(DEAD_KEY, ''); const arr = v ? JSON.parse(v) : []; return { ok: true, count: arr.length, dead: arr }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// 重发死信：逐条重新推送，成功则从死信队列移除。返回重发结果。
async function retryWatchDead() {
  let arr = [];
  try { const v = backend.kvGet(DEAD_KEY, ''); arr = v ? JSON.parse(v) : []; } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const remaining = []; let resent = 0, failed = 0;
  for (const d of arr) {
    const w = { id: d.watch_id, tag: d.tag, url: d.url, project: d.project };
    const doc = { id: d.memory && d.memory.id, content: d.memory && d.memory.content, tags: d.memory && d.memory.tags, project: d.memory && d.memory.project, user: d.memory && d.memory.user, created_at: new Date().toISOString() };
    let ok = false;
    try { await postNotify(w, doc, 1); ok = true; } catch (e) { ok = false; }
    if (ok) resent++; else { failed++; remaining.push(d); }
  }
  try { backend.kvSet(DEAD_KEY, JSON.stringify(remaining), ''); } catch (e) {}
  return { ok: true, resent, failed, remaining: remaining.length };
}

module.exports = { watchTag, unwatchTag, listWatches, notifyForMemory, listWatchDead, retryWatchDead };
