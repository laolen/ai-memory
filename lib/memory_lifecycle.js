// memory_lifecycle.js — 记忆生命周期管理（清理/巩固/批量/重新抽取）
// v1.14.0: 从 memory.js 拆出，通过 lazy require 避免与 memory.js 双向依赖。
const config = require('./config');
const backend = require('./backend');
const qdrant = require('./qdrant');
const embed = require('./embed');
const errC = config.errStats;

let _lastCleanup = 0;

async function cleanupExpired() {
  if (!(config.CONFIG.expiry_days > 0)) return 0;
  const now = Date.now();
  if (now - _lastCleanup < 30000) return 0; // 轻量节流
  _lastCleanup = now;
  const cutoff = new Date(now - config.CONFIG.expiry_days * 86400000).toISOString();
  const nowIso = new Date(now).toISOString();
  const qdrant = require('./qdrant');
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    try {
      const [fa, fb] = expiredFilter(nowIso, cutoff);
      const c = (await qdrant.count(fa)) + (await qdrant.count(fb));
      await qdrant.deleteByFilter(fa);
      await qdrant.deleteByFilter(fb);
      backend.recordChangelog('CLEANUP', { id: null, after: { deleted_count: c, deleted_ids: [] } });
      return c;
    } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const res = d.prepare("DELETE FROM memories WHERE (expires_at < ? OR (expires_at IS NULL AND updated_at < ?)) AND (pinned IS NULL OR pinned=0)").run(nowIso, cutoff);
  return res.changes;
}
function expiredFilter(nowIso, cutoff) {
  const pinnedExclude = { key: 'pinned', match: { value: false } };
  const a = { must: [ { key: 'expires_at', range: { lt: nowIso } }, pinnedExclude ] };
  const b = { must: [ { key: 'expires_at', is_empty: true }, { key: 'updated_at', range: { lt: cutoff } }, pinnedExclude ] };
  return [a, b];
}
async function purgeMemories(scope) {
  scope = scope || {};
  const days = scope.days || config.CONFIG.expiry_days;
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const nowIso = new Date().toISOString();
  const qdrant = require('./qdrant');
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    const scopeConds = [];
    if (scope.user) scopeConds.push({ key: 'user', match: { value: scope.user } });
    if (scope.project) scopeConds.push({ key: 'project', match: { value: scope.project } });
    if (scope.session) scopeConds.push({ key: 'session', match: { value: scope.session } });
    const [ea, eb] = expiredFilter(nowIso, cutoff);
    const fa = { must: scopeConds.concat(ea.must) };
    const fb = { must: scopeConds.concat(eb.must) };
    try {
      const c = (await qdrant.count(fa)) + (await qdrant.count(fb));
      await qdrant.deleteByFilter(fa); await qdrant.deleteByFilter(fb);
      backend.recordChangelog('CLEANUP', { id: null, user: scope.user, project: scope.project, after: { deleted_count: c, deleted_ids: [] } });
      return c;
    } catch (e) { return 0; }
  }
  const d = backend.sqliteInit();
  const where = ['(expires_at < ? OR (expires_at IS NULL AND updated_at < ?))', '(pinned IS NULL OR pinned = 0)'], params = [nowIso, cutoff];
  if (scope.user) { where.push('user=?'); params.push(scope.user); }
  if (scope.project) { where.push('project=?'); params.push(scope.project); }
  if (scope.session) { where.push('session=?'); params.push(scope.session); }
  const res = d.prepare('DELETE FROM memories WHERE ' + where.join(' AND ')).run(...params);
  return res.changes;
}
async function consolidate(opts) {
  const memory = require('./memory');
  opts = opts || {};
  const project = opts.project || null;
  const minCluster = opts.min_cluster || 2;
  const maxPerRun = opts.max_per_run || 10;
  let mems = [];
  const qdrant = require('./qdrant');
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    const filter = project ? { must: [{ key: 'project', match: { value: project } }] } : {};
    const pts = await qdrant.scrollAll(filter);
    mems = pts.map(p => ({ id: p.id, ...p.payload }));
  } else {
    const d = backend.sqliteInit();
    const all = project ? d.prepare('SELECT * FROM memories WHERE project=?').all(project) : d.prepare('SELECT * FROM memories').all();
    mems = all.map(backend.rowToDoc);
  }
  const groups = new Map();
  for (const m of mems) {
    const key = (m.entity_names && m.entity_names[0]) || (m.tags && m.tags[0]) || null;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const webhook = require('./webhook');
  const results = [];
  for (const [key, list] of groups) {
    if (results.length >= maxPerRun) break;
    if (list.length < minCluster) continue;
    const low = list.filter(m => (typeof m.confidence === 'number' ? m.confidence : 0.5) < 0.7 || (Number(m.access_count) || 0) < 3);
    if (low.length < minCluster) continue;
    const contents = low.map(m => '- ' + (m.content || '')).join('\n');
    let summary = null;
    const url = config.CONFIG.llm_url || config.CONFIG.kg_url;
    if (url) {
      try {
        const c = await embed.chatJSON({ url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || config.CONFIG.kg_api_key || null,
          messages: [
            { role: 'system', content: '你是记忆巩固助手。把多条关于同一主题的记忆合并成一条简洁、去重、保留关键事实的摘要。只返回 JSON: {"summary":"..."}。保持原文语言。' },
            { role: 'user', content: '主题: ' + key + '\n记忆:\n' + contents } ], temperature: 0.2, jsonMode: true });
        if (c && c.summary) summary = String(c.summary).trim();
      } catch (e) { errC.other++; }
    }
    if (!summary) summary = '(自动合并) 关于「' + key + '」的记忆 ' + low.length + ' 条已归纳';
    const created = await memory.doAdd({
      content: summary, project,
      user: low[0].user,
      tags: Array.from(new Set(['consolidated'].concat(low[0].tags || []))),
      memory_type: 'consolidated', category: 'summary',
      source: { trigger: 'consolidate', consolidated_from: low.map(m => m.id) }
    });
    for (const m of low) {
      try { await memory.doUpdate(m.id, { expires_at: new Date().toISOString(), source: { trigger: 'consolidate', superseded_by: created.id } }); } catch (e2) { errC.other++; }
      backend.recordChangelog('SUPERSEDE', { id: m.id, project, before: memory.snapshot(m), after: { superseded_by: created.id } });
    }
    webhook.emit('memory.consolidated', { id: created.id, project, user: low[0].user, data: { merged: low.length, from: low.map(m => m.id) } });
    results.push({ key, merged: low.length, summary, consolidated_id: created.id });
  }
  return { ok: true, consolidated: results.length, groups: groups.size, results };
}
async function batchAdd(items) {
  const memory = require('./memory');
  items = Array.isArray(items) ? items : [];
  const results = [];
  for (const it of items) {
    try { const r = await memory.doAdd(it); results.push({ ok: true, id: r.id, merged: !!r.merged, working: !!r.working }); }
    catch (e) { results.push({ ok: false, error: String(e && e.message || e) }); }
  }
  return { added: results.filter(r => r.ok).length, results };
}
async function deleteByFilter(filtersObj, scope) {
  const memory = require('./memory');
  scope = scope || {};
  let rows = [];
  const qdrant = require('./qdrant');
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    const fa = backend.qdrantFilter(scope);
    const { points } = await qdrant.scroll({ filter: fa, limit: 10000, withVector: false });
    rows = (points || []).map(p => backend.payloadToRow(p.id, 1, p.payload));
  } else {
    const d = backend.sqliteInit();
    const where = [], params = [];
    if (scope.user) { where.push('user=?'); params.push(scope.user); }
    if (scope.project) { where.push('project=?'); params.push(scope.project); }
    if (scope.session) { where.push('session=?'); params.push(scope.session); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    rows = d.prepare('SELECT * FROM memories' + clause).all(...params).map(backend.rowToDoc);
  }
  const matched = (filtersObj ? rows.filter(r => backend.matchFilters(r, filtersObj)) : rows);
  const ids = [];
  for (const r of matched) { try { await memory.doDelete(r.id); ids.push(r.id); } catch (e) { errC.other++; } }
  return { deleted: ids.length, ids };
}
async function reextractMemory(id, text, opts) {
  const memory = require('./memory');
  const cur = await memory.getMemory(id);
  const patch = { content: text };
  if (config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
    try {
      const facts = require('./facts');
      const fcts = await facts.extractFacts(text, opts || {});
      if (fcts && fcts.length) {
        const f = fcts[0];
        patch.type = f.type; patch.category = f.category || 'semantic'; patch.mem_category = f.mem_category || 'fact';
        patch.confidence = f.confidence; patch.fact_entities = f.entities || [];
      }
    } catch (e) { errC.other++; }
  }
  return await memory.doUpdate(id, patch);
}

module.exports = { cleanupExpired, expiredFilter, purgeMemories, consolidate, batchAdd, deleteByFilter, reextractMemory };
