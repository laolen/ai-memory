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

async function postNotify(w, doc) {
  const body = JSON.stringify({
    event: 'tag.matched', tag: w.tag, watch_id: w.id,
    memory: { id: doc.id, content: doc.content, tags: doc.tags, project: doc.project || null, user: doc.user || null, created_at: doc.created_at },
    at: new Date().toISOString(),
  });
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(w.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
  } catch (e) { errC.webhook++; } finally { clearTimeout(to); }
}

module.exports = { watchTag, unwatchTag, listWatches, notifyForMemory };
