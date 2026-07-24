// 自动捕获层：把原始对话/文本提炼成记忆入库。复用 facts(抽取/合并) 与 memory(落库)。
// watch 偏移文件落地到 config.ROOT（与 memories.db 同目录，重启续传）。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const util = require('./util');
const memory = require('./memory');
const facts = require('./facts');
const backend = require('./backend');

async function captureText(text, scope) {
  scope = scope || {};
  // v1.11.0 (gap⑥): per-call 抽取引导透传
  const extractOpts = { extract_instructions: scope.extract_instructions, extract_version: scope.extract_version || config.CONFIG.extract_version };
  // v1.12.0 (gap①): 项目级持久配置注入——per-call 优先，项目配置兜底
  if (scope.project) {
    try {
      const pc = backend.projectConfigGet(scope.project);
      if (pc) {
        if (!extractOpts.extract_instructions && pc.extract_instructions) extractOpts.extract_instructions = pc.extract_instructions;
        if (Array.isArray(pc.custom_categories) && pc.custom_categories.length) extractOpts.custom_categories = pc.custom_categories;
      }
    } catch (e) {}
  }
  if (Array.isArray(scope.custom_categories) && scope.custom_categories.length) extractOpts.custom_categories = scope.custom_categories;
  if (!(await facts.shouldCapture(text))) {
    return { captured: 0, skipped: 1, mode: 'filtered', items: [], reason: 'auto_filter discarded', usage: { tokens: Math.ceil((text || '').length / 4) } };
  }
  // 新管线：事实抽取 + 冲突调和（reconcile_enabled 或开了 LLM 时启用）
  if (config.CONFIG.reconcile_enabled || config.CONFIG.llm_enabled) {
    let fcts = await facts.extractFacts(text, extractOpts);
    if (fcts === null) fcts = []; // LLM 不可用，回退启发式
    if (fcts.length === 0) {
      fcts = facts.splitSentences(text)
        .filter(c => c.length >= config.CONFIG.capture_min_chars && facts.keywordAllowed(c))
        .map(c => ({ statement: c, type: 'project_fact', category: 'semantic', entities: [], confidence: 0.6, scope: 'global', expires_in_days: null }));
    }
    const cap = config.CONFIG.capture_max_per_call || 20;
    const items = [];
    let captured = 0, skipped = 0, updated = 0, supplemented = 0;
    for (const f of fcts.slice(0, cap)) {
      try {
        const r = await facts.reconcileFact(f, scope);
        if (r.action === 'added') { captured++; items.push({ id: r.id, content: f.statement }); }
        else if (r.action === 'updated') { updated++; items.push({ id: r.id, content: f.statement, action: 'updated' }); }
        else if (r.action === 'supplemented') { supplemented++; items.push({ id: r.id, content: f.statement, action: 'supplemented' }); }
        else { skipped++; }
      } catch (e) { skipped++; }
    }
    return { captured, skipped, updated, supplemented, mode: 'fact-pipeline', items, usage: { tokens: Math.ceil((text || '').length / 4) } };
  }
  // 兼容旧逻辑（未开 reconcile 且无 LLM）：启发式按句 + doAdd
  let mode = (config.CONFIG.llm_enabled && config.CONFIG.llm_url) ? 'llm' : 'heuristic';
  let candidates = [];
  if (mode === 'llm') {
    try { candidates = (await facts.llmExtract(text, extractOpts)) || []; }
    catch (e) { candidates = []; mode = 'heuristic'; }
  }
  if (mode !== 'llm') {
    candidates = facts.splitSentences(text)
      .filter(c => c.length >= config.CONFIG.capture_min_chars && facts.keywordAllowed(c))
      .map(c => ({ content: c, tags: [], importance: 2 }));
  }
  const cap = config.CONFIG.capture_max_per_call || 20;
  candidates = candidates.slice(0, cap);
  const items = [];
  let captured = 0, skipped = 0;
  for (const c of candidates) {
    const m = { content: c.content, user: scope.user || 'auto', project: scope.project || null,
      session: scope.session || null, tags: Array.from(new Set([...(scope.tags || []), ...(c.tags || []), 'auto-captured'])),
      org: scope.org || null, tier: scope.tier || 'long',
      actor_id: scope.actor_id || null, agent_id: scope.agent_id || null, run_id: scope.run_id || null }; // v1.12.0 (gap②)
    // v1.9.0: 每次捕获都盖章溯源（trigger='capture' + captured_at），不再依赖调用方显式传 source。
    m.source = util.normalizeSource(scope.source, 'capture');
    try { const r = await memory.doAdd(m); captured++; items.push({ id: r.id, merged: !!r.merged, working: !!r.working, content: c.content }); }
    catch (e) { skipped++; }
  }
  const result = { captured, skipped, mode, items, usage: { tokens: Math.ceil((text || '').length / 4) } };
  // v1.13.0: 自动压缩——capture 后非阻塞自动 consolidate（仅作用于该项目）
  if (config.CONFIG.auto_compress && captured > 0 && scope.project) {
    memory.consolidate({ project: scope.project, max_per_run: 5 }).catch(() => {});
  }
  return result;
}

// ---- auto-capture: file/dir watcher ----
const _capturing = new Set();
let watchOffsets = {};
try { watchOffsets = JSON.parse(fs.readFileSync(path.join(config.ROOT, '.capture.offsets.json'), 'utf8')); } catch (e) {}
function saveWatchOffsets() { try { fs.writeFileSync(path.join(config.ROOT, '.capture.offsets.json'), JSON.stringify(watchOffsets)); } catch (e) {} }
async function tailAndCapture(filepath, scope) {
  if (_capturing.has(filepath)) return;
  _capturing.add(filepath);
  try {
    const stat = fs.statSync(filepath);
    const start = watchOffsets[filepath] || 0;
    const off = (stat.size < start) ? 0 : start;
    const fd = fs.openSync(filepath, 'r');
    const len = stat.size - off;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      watchOffsets[filepath] = stat.size; saveWatchOffsets();
      const newText = buf.toString('utf8');
      fs.closeSync(fd);
      if (newText.trim()) await captureText(newText, scope);
    } else { fs.closeSync(fd); }
  } catch (e) {} finally { _capturing.delete(filepath); }
}
function startWatcher() {
  if (!config.CONFIG.capture_watch_enabled || !config.CONFIG.capture_watch_path) return;
  const p = config.CONFIG.capture_watch_path;
  const scope = { user: 'auto', project: 'watched', session: null, tags: ['watched'] };
  try {
    const st = fs.statSync(p);
    if (st.isFile()) { tailAndCapture(p, scope); fs.watch(p, () => tailAndCapture(p, scope)); }
    else if (st.isDirectory()) {
      const processDir = () => { try { for (const f of fs.readdirSync(p)) { if (!/\.(log|txt|md|jsonl)$/i.test(f)) continue; tailAndCapture(path.join(p, f), scope); } } catch (e) {} };
      processDir(); fs.watch(p, () => processDir());
    }
  } catch (e) {}
}

module.exports = { captureText, startWatcher, tailAndCapture, saveWatchOffsets };
