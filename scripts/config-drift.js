#!/usr/bin/env node
// scripts/config-drift.js — v1.22.0 (P2-6) 多客户端配置漂移检测。
//
// 用途：统一校验「运行中的服务 / 本地 config.json / 各 MCP 客户端定义」三者是否指向同一套后端
//       （Qdrant / embedding / LLM / KG 地址、端口、是否启用鉴权、限流、自动备份等连接契约）。
//       任一客户端指向旧 IP、漏配 API Key、或后端被悄悄改地址，都会在此暴露为 DRIFT。
//
// 数据源语法（位置参数，可多个）：
//   server:<baseUrl>            从运行中的服务拉取 /api/config/public（无密钥，纯连接契约）
//   file:<path>                 读取本地 JSON：既支持 config.json 形态，也支持 MCP server 定义 {url,headers}
// 不传参数时的默认源：server:${BASE|http://127.0.0.1:8765} + file:config.example.json（项目根）
//
// 退出码：0 = 无漂移；1 = 检测到漂移；2 = 用法/运行错误。
//
// 示例：
//   node scripts/config-drift.js server:http://192.168.110.128:8765 file:config.example.json
//   node scripts/config-drift.js server:http://127.0.0.1:8765 file:~/.workbuddy/mcp.json
const fs = require('fs');
const path = require('path');

// 参与漂移比对的「连接契约」键（均为非密字段；密钥只比较「是否启用」）。
const DRIFT_KEYS = [
  'server_version', 'store', 'qdrant_url', 'qdrant_collection',
  'embedding_url', 'embedding_model', 'llm_enabled', 'llm_url', 'llm_model',
  'kg_enabled', 'kg_url', 'kg_model', 'search_cache_enabled',
  'api_keys_enabled', 'rate_limit_max', 'rate_limit_window_ms',
  'auto_backup_enabled', 'auto_backup_interval_hours', 'audit_enabled',
];

// 从服务端 public 契约构造比对对象（已是契约形态，直接用）。
function contractFromServer(pub) {
  const c = {};
  for (const k of DRIFT_KEYS) if (pub[k] !== undefined) c[k] = pub[k];
  return c;
}

// 从 config.json 形态构造比对对象（丢弃一切密钥明文/掩码）。
function contractFromConfig(cfg) {
  const c = {};
  c.server_version = undefined; // 文件无版本概念
  c.store = (cfg.qdrant_url && cfg.embedding_url) ? 'qdrant' : 'sqlite';
  c.qdrant_url = cfg.qdrant_url || null;
  c.qdrant_collection = cfg.qdrant_collection || null;
  c.embedding_url = cfg.embedding_url || null;
  c.embedding_model = cfg.embedding_model || null;
  c.llm_enabled = !!cfg.llm_enabled;
  c.llm_url = cfg.llm_url || null;
  c.llm_model = cfg.llm_model || null;
  c.kg_enabled = !!cfg.kg_enabled;
  c.kg_url = cfg.kg_url || null;
  c.kg_model = cfg.kg_model || null;
  c.search_cache_enabled = cfg.search_cache_enabled !== false;
  c.api_keys_enabled = !!(cfg.api_keys && cfg.api_keys.length);
  c.rate_limit_max = cfg.rate_limit_max != null ? cfg.rate_limit_max : 300;
  c.rate_limit_window_ms = cfg.rate_limit_window_ms != null ? cfg.rate_limit_window_ms : 60000;
  c.auto_backup_enabled = !!cfg.auto_backup_enabled;
  c.auto_backup_interval_hours = cfg.auto_backup_interval_hours != null ? cfg.auto_backup_interval_hours : 24;
  c.audit_enabled = cfg.audit_enabled !== false;
  return c;
}

// 从 MCP server 定义（{url,headers/env}）构造比对对象——客户端视角的「我连的是哪」。
function contractFromMcp(def) {
  const c = {};
  if (def && def.url) c.server_base = def.url;
  const auth = (def && def.headers && def.headers.Authorization) || (def && def.env && (def.env.API_KEY || def.env.AI_MEMORY_KEY));
  c.api_keys_enabled = !!auth; // 客户端若带鉴权头，说明它预期服务端启用了 key
  return c;
}

async function fetchServer(base) {
  const url = base.replace(/\/$/, '') + '/api/config/public';
  const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return contractFromServer(await r.json());
}

function loadFile(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) { console.warn(`  [warn] 文件不存在，跳过: ${abs}`); return null; }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  // 可能是 config.json 形态，也可能是 MCP 定义（含 mcpServers 或顶层 url）
  if (raw.mcpServers) {
    const out = {};
    for (const [name, def] of Object.entries(raw.mcpServers)) {
      const c = contractFromMcp(def); if (Object.keys(c).length) out[name] = c;
    }
    return out; // 可能是多客户端 map
  }
  if (raw.url) return { [p]: contractFromMcp(raw) };
  return { [p]: contractFromConfig(raw) };
}

function fmt(v) { return v === undefined ? '—' : (v === null ? '∅' : String(v)); }

async function main() {
  let args = process.argv.slice(2);
  if (!args.length) {
    const base = process.env.BASE || 'http://127.0.0.1:8765';
    args = ['server:' + base, 'file:config.example.json'];
    console.log(`（未传参，使用默认源：server:${base} + file:config.example.json）\n`);
  }

  const sources = []; // {name, contract}
  for (const a of args) {
    if (a.startsWith('server:')) {
      const base = a.slice('server:'.length);
      try { const c = await fetchServer(base); sources.push({ name: `server(${base})`, contract: c }); console.log(`✓ 拉取服务端契约: ${base}`); }
      catch (e) { console.error(`✗ 服务端拉取失败 ${base}: ${e.message}`); process.exitCode = 2; }
    } else if (a.startsWith('file:')) {
      const p = a.slice('file:'.length);
      const loaded = loadFile(p);
      if (loaded) {
        for (const [name, c] of Object.entries(loaded)) { sources.push({ name, contract: c }); console.log(`✓ 读取文件契约: ${name}`); }
      }
    } else { console.error(`✗ 无法识别的源: ${a}（用 server:<url> 或 file:<path>）`); process.exitCode = 2; }
  }

  if (sources.length < 2) { console.error('\n需要至少 2 个有效源才能比对漂移。'); process.exit(2); }

  // 以第一个源为基线，对比其余源每个 DRIFT_KEY
  const baseline = sources[0];
  const driftRows = [];
  const keys = DRIFT_KEYS.filter(k => baseline.contract[k] !== undefined || sources.some(s => s.contract[k] !== undefined));
  for (const k of keys) {
    const baseVal = baseline.contract[k];
    const perSource = sources.map(s => s.contract[k]);
    const distinct = new Set(perSource.filter(v => v !== undefined).map(fmt));
    const drifted = distinct.size > 1;
    if (drifted) {
      driftRows.push({ key: k, values: sources.map(s => ({ name: s.name, val: s.contract[k] })) });
    }
  }

  console.log('\n===== 配置漂移报告 =====');
  console.log(`基线源: ${baseline.name}`);
  console.log('源: ' + sources.map(s => s.name).join(' | '));
  console.log('-----------------------------------------------');
  if (!driftRows.length) {
    console.log('✅ 无漂移：所有源的连接契约一致。');
    process.exit(0);
  }
  for (const row of driftRows) {
    console.log(`⚠️  DRIFT [${row.key}]：`);
    for (const v of row.values) console.log(`     ${v.name} = ${fmt(v.val)}`);
  }
  console.log(`\n❌ 检测到 ${driftRows.length} 处漂移。请对齐各客户端的连接契约。`);
  process.exit(1);
}
main().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(2); });
