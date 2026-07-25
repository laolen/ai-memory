// memory_work.js — 短时工作记忆操作（独立于长期库，不污染 Qdrant/FTS/KG/审计）
// v1.14.0: 从 memory.js 拆出。promoteWorking 通过 lazy require 避免循环依赖。
const crypto = require('crypto');
const config = require('./config');
const util = require('./util');
const backend = require('./backend');
const webhook = require('./webhook');

async function addWorking(a) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const wdoc = { id, content: a.content, user: a.user, project: a.project || null, session: a.session || null, org: a.org || null,
    tags: a.tags || [], created_at: now, expires_at: a.expires_at || null, memory_type: a.memory_type || 'user',
    meta: { source: util.normalizeSource(a.source, 'add'), mem_category: a.mem_category || null } };
  if (!wdoc.expires_at && config.CONFIG.working_ttl_hours > 0) {
    wdoc.expires_at = new Date(Date.now() + config.CONFIG.working_ttl_hours * 3600000).toISOString();
  }
  backend.addWorkingMemory(wdoc);
  return { id, working: true, tier: 'working', content: a.content };
}
function listWorking(scope) { return backend.listWorkingMemory(scope || {}); }
function searchWorking(a) {
  const all = backend.listWorkingMemory({ project: a.project, session: a.session, user: a.user, org: a.org });
  const q = (a.query || '').trim().toLowerCase();
  if (!q) return all;
  return all.filter(r => (r.content || '').toLowerCase().includes(q) || (r.tags || []).some(t => (t || '').toLowerCase().includes(q)));
}
function deleteWorking(id) { return backend.deleteWorkingMemory(id); }
async function promoteWorking(id, opts) {
  const memory = require('./memory'); // lazy require: promoteWorking 在模块加载后才被调用，memory.js 已完成
  const w = backend.getWorkingMemory(id);
  if (!w) { const e = new Error('working memory not found'); e.statusCode = 404; throw e; }
  const r = await memory.doAdd({ content: w.content, user: w.user, project: w.project, session: w.session, tags: w.tags,
    org: w.org, mem_category: w.meta && w.meta.mem_category, memory_type: w.memory_type,
    actor_id: (w.meta && w.meta.actor_id) || null, agent_id: (w.meta && w.meta.agent_id) || null, run_id: (w.meta && w.meta.run_id) || null,
    source: (w.meta && w.meta.source) || { type: 'agent', trigger: 'promote' } });
  backend.deleteWorkingMemory(id);
  webhook.emit('memory.promoted', { id: r.id, project: w.project, user: w.user, data: { working_id: id, content: w.content } });
  return { id: r.id, working_id: id, promoted: true, tier: 'long' };
}

module.exports = { addWorking, listWorking, searchWorking, deleteWorking, promoteWorking };
