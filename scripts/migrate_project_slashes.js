// 一次性迁移：把 Qdrant 与本地 SQLite 镜像里所有 project 字段的反斜杠归一为正斜杠。
// 原因：Qdrant keyword 的 match.value 无法匹配含反斜杠字符串，导致 Windows 工作区路径
// （如 D:\project\ai-memory）在按 project 过滤时 count/rows 为空。
// 运行：cd /opt/ai-memory && NODE_PATH=/opt/ai-memory/node_modules node /tmp/migrate_project_slashes.js
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/opt/ai-memory/config.json', 'utf8'));
const Q = (cfg.qdrant_url || '').replace(/\/+$/, '');
const COLL = cfg.qdrant_collection || 'memories';
const DB = (cfg.ROOT ? require('path').join(cfg.ROOT, 'memories.db') : '/opt/ai-memory/memories.db');

const norm = p => (typeof p === 'string') ? p.replace(/\\/g, '/') : p;

async function qscrollAll() {
  let off = null, out = [];
  while (true) {
    const body = { filter: undefined, limit: 256, with_payload: true, with_vector: true };
    if (off) body.offset = off;
    const r = await fetch(`${Q}/collections/${COLL}/points/scroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    const pts = (j && j.result && j.result.points) || [];
    out = out.concat(pts);
    off = j && j.result && j.result.next_page_offset;
    if (!off || pts.length === 0) break;
  }
  return out;
}

(async () => {
  let qChanged = 0, sChanged = 0;
  // ---- Qdrant ----
  if (Q) {
    try {
      const pts = await qscrollAll();
      const up = [];
      for (const p of pts) {
        const pl = p.payload || {};
        if (typeof pl.project === 'string' && pl.project.includes('\\')) {
          pl.project = norm(pl.project);
          up.push({ id: p.id, vector: p.vector, payload: pl });
          qChanged++;
        }
      }
      for (let i = 0; i < up.length; i += 100) {
        const b = up.slice(i, i + 100);
        await fetch(`${Q}/collections/${COLL}/points?wait=true`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: b }),
        });
      }
      console.log(`[qdrant] 扫描 ${pts.length} 点，归一化 project ${qChanged} 个`);
    } catch (e) {
      console.log('[qdrant] 迁移失败:', e.message);
    }
  }
  // ---- SQLite 镜像（FTS/KG/working/project_config/project_links 等）----
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB, { readonly: false });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of tables) {
      let cols = [];
      try { cols = db.pragma(`table_info(${t})`).map(c => c.name); } catch (e) { continue; }
      const pcols = cols.filter(c => c === 'project' || c.endsWith('_project'));
      for (const c of pcols) {
        try {
          const n = db.prepare(`UPDATE ${t} SET "${c}" = REPLACE("${c}", '\\', '/') WHERE typeof("${c}")='text' AND INSTR("${c}", '\\') > 0`).run().changes;
          sChanged += n;
        } catch (e) { console.log(`[sqlite] 表 ${t}.${c} 更新跳过:`, e.message); }
      }
    }
    db.close();
    console.log(`[sqlite] 扫描表 ${tables.length} 个，归一化 project 列 ${sChanged} 行`);
  } catch (e) {
    console.log('[sqlite] 迁移失败:', e.message);
  }
  console.log('迁移完成。');
})();
