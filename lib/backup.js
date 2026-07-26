// 备份/恢复 MCP 工具（v1.18.0 #8）。复用 deploy.js 的 tar 备份逻辑，
// 将整目录备份到 backup_path，通过 kv 记录元数据。
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = config.ROOT;
const BACKUP_DIR = config.CONFIG.backup_path || (ROOT + '/backups');

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function createBackup(a = {}) {
  ensureDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const label = a.label || 'manual';
  const filename = `ai-memory-${ts}-${label}.tar.gz`;
  const dest = path.join(BACKUP_DIR, filename);
  try {
    execSync(`tar czf "${dest}" -C "${path.dirname(ROOT)}" "${path.basename(ROOT)}"`, { timeout: 60000, stdio: 'pipe' });
    const stat = fs.statSync(dest);
    const meta = { filename, label, created_at: new Date().toISOString(), size: stat.size, path: dest };
    backend.kvSet('backup:' + filename, JSON.stringify(meta), '');
    return { ok: true, filename, size: stat.size, label, path: dest };
  } catch (e) {
    errC.other++;
    return { ok: false, error: e.message || String(e) };
  }
}

function listBackups(a = {}) {
  ensureDir();
  const all = backend.kvList('').filter(r => r.key && r.key.startsWith('backup:'));
  let items = all.map(r => { try { return JSON.parse(r.value); } catch (e) { return null; } }).filter(Boolean);
  if (a.label) items = items.filter(i => i.label === a.label);
  items.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
  return { ok: true, count: items.length, backups: items };
}

async function restoreBackup(a = {}) {
  const filename = a.filename;
  if (!filename) return { ok: false, error: 'filename required' };
  const meta = backend.kvGet('backup:' + filename, '');
  if (!meta) return { ok: false, error: 'backup not found' };
  const m = JSON.parse(meta);
  const src = m.path;
  if (!fs.existsSync(src)) return { ok: false, error: 'backup file not found on disk' };
  try {
    execSync(`tar xzf "${src}" -C "${path.dirname(ROOT)}"`, { timeout: 120000, stdio: 'pipe' });
    return { ok: true, restored_from: filename };
  } catch (e) {
    errC.other++;
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { createBackup, listBackups, restoreBackup };
