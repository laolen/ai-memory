// 记忆老化与二级存储（v1.17.0 #106）：识别冷记忆（长期未访问 + 低访问次数），
// 将完整文档移入 kv 二级存储并从主库删除，降低 Qdrant/SQLite 热成本；可随时恢复。
// 恢复时以内容重建条目（id 可能因主库去重而变化，内容/标签完整保留）。默认 dry-run。
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');
const memory = require('./memory');

const PREFIX = 'archive:';

function isCold(m) {
  const idleDays = config.CONFIG.archive_idle_days || 90;
  const minAccess = config.CONFIG.archive_min_access || 1;
  const last = m.last_accessed_at || m.updated_at || m.created_at || null;
  let idle = Infinity;
  if (last) { try { idle = (Date.now() - new Date(last).getTime()) / 86400000; } catch (e) { idle = Infinity; } }
  const access = m.access_count || 0;
  if (m.pinned) return false; // 固定记忆不归档
  return (idle >= idleDays) && (access <= minAccess);
}

// 扫描冷记忆候选（dry-run 默认），confirm=true 且 archive_enabled=true 才真正移动。
async function archiveMemories(a = {}) {
  const all = await require('./insight').loadAllCached();
  let pool = all;
  if (a.project) pool = pool.filter(m => m.project === a.project);
  const cold = pool.filter(isCold);
  const enabled = config.CONFIG.archive_enabled && a.confirm === true;
  const candidates = cold.map(m => ({ id: m.id, content: m.content, project: m.project, tags: m.tags || [], access_count: m.access_count, last_accessed_at: m.last_accessed_at }));
  if (!enabled) {
    return { ok: true, dry_run: true, archive_enabled: config.CONFIG.archive_enabled, scanned: pool.length, cold_count: candidates.length, candidates, note: '未移动任何记忆。确认无误且 archive_enabled=true 后以 confirm=true 再次调用即执行归档。' };
  }
  let moved = 0, errors = [];
  for (const c of candidates) {
    try {
      const doc = await memory.getMemory(c.id);
      if (!doc) continue;
      backend.kvSet(PREFIX + c.id, JSON.stringify(doc), '');
      await memory.doDelete(c.id);
      moved++;
    } catch (e) { errors.push({ id: c.id, error: String(e.message || e) }); errC.other++; }
  }
  return { ok: true, dry_run: false, archive_enabled: true, scanned: pool.length, cold_count: candidates.length, moved, moved_ids: candidates.map(c => c.id), errors };
}

function listArchived(a = {}) {
  const all = backend.kvList('').filter(r => r.key && r.key.startsWith(PREFIX));
  let items = [];
  for (const r of all) {
    try { const doc = JSON.parse(r.v); if (!a.project || doc.project === a.project) items.push({ id: doc.id, content: doc.content, project: doc.project, tags: doc.tags || [], archived_at: r.updated_at, access_count: doc.access_count }); } catch (e) {}
  }
  return { ok: true, count: items.length, archived: items };
}

async function restoreArchived(a = {}) {
  const id = a.id || null;
  if (!id) { const e = new Error('id is required'); e.statusCode = 400; throw e; }
  const v = backend.kvGet(PREFIX + id, '');
  if (!v) { const e = new Error('not archived / not found'); e.statusCode = 404; throw e; }
  const doc = JSON.parse(v);
  // 以内容重建（保留 content/tags/project/user 等，新 id 由主库分配）
  const r = await memory.doAdd({ content: doc.content, user: doc.user, project: doc.project, tags: doc.tags || [], memory_type: doc.memory_type || 'user', category: doc.category, mem_category: doc.mem_category });
  backend.kvDelete(PREFIX + id, '');
  return { ok: true, restored_id: r.id, content: doc.content };
}

module.exports = { archiveMemories, listArchived, restoreArchived, isCold };
