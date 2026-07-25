#!/usr/bin/env node
'use strict';
// ai-memory 自动备份脚本：每日快照记忆数据(JSON 逻辑全量) + 关键文件, 带 retention。
// 由 systemd timer 每日触发, 或直接 `node scripts/backup.js` 手动运行。
// 备份内容：
//   1) memories.json —— 通过 backend.exportMemories 拉取全量记忆(兼容 Qdrant / SQLite)
//   2) memories.db(+wal/shm) —— SQLite 本地存储 / 缓存
//   3) config.json / admin.html —— 配置与界面
// retention: 仅保留最近 N 份(默认 7, 可通过 BACKUP_RETENTION 或 config.backup_retention_days 覆盖)。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const config = require('../lib/config');
const backend = require('../lib/backend');

const RETENTION = parseInt(process.env.BACKUP_RETENTION || config.CONFIG.backup_retention_days || '7', 10);
const bp = config.CONFIG.backup_path || path.join(ROOT, 'backups');
fs.mkdirSync(bp, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(bp, 'ai-memory-backup-' + ts);
fs.mkdirSync(dir, { recursive: true });

function copyIfExists(src, dest) {
  try {
    if (fs.existsSync(src)) { fs.copyFileSync(src, dest); return true; }
  } catch (e) { console.warn('[backup] 复制失败 ' + src + ': ' + e.message); }
  return false;
}

(async () => {
  console.log('[backup] 开始 -> ' + dir);
  // 1. 逻辑全量导出(记忆 JSON; Qdrant/SQLite 均支持)
  try {
    const items = await backend.exportMemories({ user: '', project: '', session: '' });
    fs.writeFileSync(path.join(dir, 'memories.json'), JSON.stringify({ version: config.SERVER_VERSION, exported_at: new Date().toISOString(), count: items.length, items }, null, 2));
    console.log('[backup] 记忆导出 ' + items.length + ' 条');
  } catch (e) { console.error('[backup] 记忆导出失败: ' + e.message); }

  // 2. 文件级备份
  copyIfExists(path.join(ROOT, 'memories.db'), path.join(dir, 'memories.db'));
  copyIfExists(path.join(ROOT, 'memories.db-wal'), path.join(dir, 'memories.db-wal'));
  copyIfExists(path.join(ROOT, 'memories.db-shm'), path.join(dir, 'memories.db-shm'));
  copyIfExists(path.join(ROOT, 'config.json'), path.join(dir, 'config.json'));
  copyIfExists(path.join(ROOT, 'admin.html'), path.join(dir, 'admin.html'));

  // 3. retention: 保留最近 RETENTION 个目录
  const dirs = fs.readdirSync(bp).filter(d => d.startsWith('ai-memory-backup-') && fs.statSync(path.join(bp, d)).isDirectory()).sort();
  while (dirs.length > RETENTION) {
    const old = dirs.shift();
    fs.rmSync(path.join(bp, old), { recursive: true, force: true });
    console.log('[backup] 清理过期: ' + old);
  }
  console.log('[backup] 完成, 保留 ' + dirs.length + ' 份 (保留期 ' + RETENTION + ' 天)');
})();
