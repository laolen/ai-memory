// 事实抽取管线（v1.4.0）：shouldCapture → extractFacts → reconcileFact(judgeRelation)。
// reconcileFact 需要把事实落库，故依赖 memory(doAdd/doUpdate)；memory 不反向依赖本模块（无循环）。
const config = require('./config');
const embed = require('./embed');
const backend = require('./backend');
const memory = require('./memory');
const util = require('./util');

function splitSentences(text) {
  const raw = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  const punct = /[。！？!?；;]/;
  for (const line of raw) {
    let buf = '', seg = '';
    const flush = () => { if (buf.trim().length >= config.CONFIG.capture_min_chars) out.push(buf.trim()); buf = ''; };
    for (const ch of line) {
      seg += ch;
      if (punct.test(ch)) { buf += seg; seg = ''; flush(); }
    }
    if (seg.trim()) { buf += seg; flush(); }
  }
  return out;
}
function keywordAllowed(text) {
  const kw = (config.CONFIG.capture_keywords || '').trim();
  if (!kw) return true;
  try { return new RegExp(kw, 'i').test(text); } catch (e) { return true; }
}
async function llmExtract(text) {
  if (!config.CONFIG.llm_enabled || !config.CONFIG.llm_url) return null;
  const sys = 'You are a memory extraction engine. Given a conversation or notes, extract durable, self-contained memory items worth remembering long-term: facts, decisions, user preferences, commitments, and useful context. Ignore chit-chat, greetings, and ephemeral content. 重要：保持输入原文的【语言】，不要翻译（中文输入必须输出中文，英文输入输出英文）；实体/专有名词必须与原文逐字一致。 Respond with ONLY a JSON array of objects, each: {"content": string, "tags": string[], "importance": number (1-5)}. No markdown, no commentary. If nothing is worth remembering, return [].';
  try {
    const content = await embed.chatJSON({ url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: 'Extract memory items from the following:\n\n' + text } ], temperature: 0.2, jsonMode: false });
    if (!content) return [];
    let c = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let parsed; try { parsed = JSON.parse(c); } catch (e) { return []; }
    const arr = Array.isArray(parsed) ? parsed : (parsed.items || parsed.memories || []);
    return arr.filter(x => x && x.content).map(x => ({ content: String(x.content), tags: Array.isArray(x.tags) ? x.tags : [], importance: Number(x.importance) || 3 }));
  } catch (e) { return []; }
}

// ---- v1.4.0 事实抽取管线：shouldCapture → extractFacts → reconcileFact(judgeRelation) ----
// 触发判定（Natural Memory Triggers）：auto_filter 关闭或无 LLM 时不拦截，保持旧行为
async function shouldCapture(text) {
  if (!config.CONFIG.auto_filter) return true;
  if (!config.CONFIG.llm_enabled || !config.CONFIG.llm_url) return true;
  const sys = 'You decide whether a piece of text contains information worth saving to long-term memory (durable facts, decisions, user preferences, commitments). Reply with ONLY JSON: {"keep": true|false, "reason": string}. No markdown.';
  try {
    const content = await embed.chatJSON({ url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: text } ], temperature: 0.1, jsonMode: true });
    if (!content) return true;
    let p; try { p = JSON.parse(content); } catch (e) { return true; }
    return !!(p && p.keep === true);
  } catch (e) { return true; }
}

// 原子事实抽取：把文本拆成原子事实，带类型/实体/置信度/生命周期
async function extractFacts(text) {
  if (!config.CONFIG.llm_enabled || !config.CONFIG.llm_url) return null;
  const types = (config.CONFIG.fact_types && config.CONFIG.fact_types.length) ? config.CONFIG.fact_types.join(', ') : 'preference, decision, convention, project_fact';
  const sys = 'You are a fact-extraction engine. From the given conversation/notes, extract durable ATOMIC facts worth remembering long-term (one fact per item, no compound sentences). For each fact provide: statement (one self-contained sentence), type (one of: ' + types + '), category (one of: semantic=durable fact/preference, episodic=specific event/decision in a context, procedural=how-to/workflow/communication style), entities (REQUIRED — an array of EVERY named entity / proper noun that appears in this fact: people, organizations/companies, products, technologies/tools, systems, files, places, version numbers and dates. Copy each entity VERBATIM from the original text, preserving its exact wording and language. This array MUST NOT be empty whenever the statement contains any proper noun; only return an empty array for a fact that genuinely mentions no named entity), confidence (0-1), scope (global|project|session), expires_in_days (integer or null; null for durable facts, e.g. 90 for temporary decisions). Ignore chit-chat, greetings, ephemeral content. 重要：保持输入原文的【语言】，不要翻译（中文输入必须输出中文，英文输入输出英文）；实体/专有名词必须与原文逐字一致，不得翻译、缩写或改写。 示例：输入「周明远是青龙数据(QingLong) 的 CTO，2026 年负责把订单系统从 PostgreSQL 迁移到 TiDB」应抽出两条事实，其 entities 分别为 ["周明远","青龙数据","QingLong"] 与 ["周明远","订单系统","PostgreSQL","TiDB"]。 Respond with ONLY JSON: {"facts":[...]}. If nothing worth keeping, return {"facts":[]}. No markdown, no commentary.';
  try {
    const content = await embed.chatJSON({ url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: 'Extract facts from:\n\n' + text } ], temperature: 0.2, jsonMode: true });
    if (!content) return null;
    let parsed; try { parsed = JSON.parse(content); } catch (e) { return null; }
    const arr = Array.isArray(parsed.facts) ? parsed.facts : [];
    return arr.filter(x => x && x.statement).map(x => ({
      statement: String(x.statement),
      type: (function (t) {
        if (!t) return 'project_fact';
        const s = String(t).trim();
        const TM = { '人员角色': 'person', '人物': 'person', '人': 'person', '技术栈': 'tooling', '技术': 'tooling', '工具': 'tooling', '网络配置': 'project_fact', '网络': 'project_fact', '发布时间': 'temporal', '时间': 'temporal', '决定': 'decision', '决策': 'decision', '偏好': 'preference', '喜好': 'preference', '规范': 'convention', '约定': 'convention', '反模式': 'anti_pattern', '事实': 'project_fact' };
        if (TM[s]) return TM[s];
        const ft = (config.CONFIG.fact_types || []).map(String);
        return ft.includes(s) ? s : s; // 未知标签原样保留（多为英文规范值）
      })(x.type),
      category: ['semantic', 'episodic', 'procedural'].includes(x.category) ? x.category : 'semantic',
      entities: Array.isArray(x.entities) ? x.entities : [],
      confidence: Number(x.confidence) || 0.5,
      scope: (function (s) {
        const m = { global: 'global', '全局': 'global', project: 'project', '项目级': 'project', '项目': 'project', session: 'session', '会话级': 'session', '会话': 'session' };
        return m[String(s || '').toLowerCase().trim()] || 'global';
      })(x.scope),
      expires_in_days: (x.expires_in_days && Number(x.expires_in_days) > 0) ? Number(x.expires_in_days) : null
    }));
  } catch (e) { return null; }
}

// 关系判定：相同/矛盾/补充/无关（兼容 9b 等返回中文枚举的模型）
async function judgeRelation(newText, oldDoc) {
  if (!config.CONFIG.llm_enabled || !config.CONFIG.llm_url) return 'same';
  const REL_MAP = {
    same: 'same', '相同': 'same', '等价': 'same', '重复': 'same', '一致': 'same',
    contradict: 'contradict', '矛盾': 'contradict', '冲突': 'contradict',
    supplement: 'supplement', '补充': 'supplement', '追加': 'supplement',
    irrelevant: 'irrelevant', '无关': 'irrelevant', '不同': 'irrelevant', '不一样': 'irrelevant'
  };
  const oldText = (oldDoc && oldDoc.content) || '';
  const sys = 'Compare two memory statements. Classify their relationship as exactly one of: same (redundant/equivalent), contradict (new overrides old, they conflict), supplement (new adds compatible detail to old), irrelevant (similar wording but different meaning). Reply with ONLY JSON: {"relation":"same|contradict|supplement|irrelevant"}. No markdown. Use the English keyword only.';
  try {
    const content = await embed.chatJSON({ url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: 'OLD: ' + oldText + '\nNEW: ' + newText } ], temperature: 0.1, jsonMode: true });
    if (!content) return 'same';
    let p; try { p = JSON.parse(content); } catch (e) { return 'same'; }
    const raw = (p && p.relation) ? String(p.relation).toLowerCase().trim() : '';
    return REL_MAP[raw] || 'same';
  } catch (e) { return 'same'; }
}

// 冲突检测与合并：低置信丢弃 / 相似度<0.7 新建 / >=0.7 让 LLM 判关系后 跳过|更新|补充
async function reconcileFact(fact, scope) {
  scope = scope || {};
  const now = new Date();
  const expires_at = fact.expires_in_days ? new Date(now.getTime() + fact.expires_in_days * 86400000).toISOString() : null;
  const baseTags = ['auto-captured'];
  const srcType = scope.source ? (typeof scope.source === 'object' ? scope.source.type : scope.source) : null;
  const isAgent = srcType === 'agent';
  const memType = fact.memory_type || scope.memory_type || (isAgent ? 'agent' : 'user');
  const meta = { type: fact.type, category: fact.category || 'semantic', confidence: fact.confidence, scope: fact.scope, expires_at, fact_entities: fact.entities || [], memory_type: memType };
  // v1.9.0: 捕获落地一律盖溯源戳（trigger='capture' + captured_at），不再依赖调用方显式传 source
  const captureSource = util.normalizeSource(scope.source, 'capture');
  if (config.CONFIG.fact_confidence_threshold > 0 && fact.confidence < config.CONFIG.fact_confidence_threshold) {
    return { action: 'skipped_low_conf', id: null };
  }
  const sUser = scope.user || 'auto', sProject = scope.project || null, sSession = scope.session || null;
  if (!config.CONFIG.reconcile_enabled || !config.CONFIG.embedding_url) {
    const r = await memory.doAdd({ content: fact.statement, user: sUser, project: sProject, session: sSession,
      tags: baseTags, source: captureSource, ...meta });
    return { action: 'added', id: r.id };
  }
  let vec = null;
  try { vec = await embed.embed(fact.statement); } catch (e) {}
  if (!vec) {
    const r = await memory.doAdd({ content: fact.statement, user: sUser, project: sProject, session: sSession,
      tags: baseTags, source: captureSource, ...meta });
    return { action: 'added', id: r.id };
  }
  const hit = await backend.dedupFind(vec, { user: sUser, project: sProject, session: sSession });
  if (!hit || hit.similarity < 0.7) {
    const r = await memory.doAdd({ content: fact.statement, user: sUser, project: sProject, session: sSession,
      tags: baseTags, source: captureSource, ...meta });
    return { action: 'added', id: r.id };
  }
  const rel = await judgeRelation(fact.statement, hit.source);
  if (rel === 'same') {
    return { action: 'skipped_dup', id: hit.id };
  }
  if (rel === 'irrelevant') {
    // v1.5.1: 不同含义（仅字面相近）→ 作为新记忆独立保留，避免松匹配误杀
    const r = await memory.doAdd({ content: fact.statement, user: sUser, project: sProject, session: sSession,
      tags: baseTags, source: captureSource, ...meta });
    return { action: 'added', id: r.id };
  }
  if (rel === 'contradict') {
    if (config.CONFIG.preserve_on_conflict) {
      // v1.5.0 时序 ADD-only：保留旧版（其历史已留存），新建新版记忆；新版 updated_at 更近，检索自动排序更高
      const r = await memory.doAdd({ content: fact.statement, user: sUser, project: sProject, session: sSession,
        tags: baseTags, source: captureSource, category: fact.category || 'semantic', ...meta });
      return { action: 'added_new_version', id: r.id, supersedes: hit.id };
    }
    const patch = { content: fact.statement, tags: Array.from(new Set([...(hit.source.tags || []), ...baseTags])),
      updated_at: new Date().toISOString(), type: fact.type, category: fact.category || 'semantic', confidence: fact.confidence, expires_at,
      source: scope.source || null, fact_entities: fact.entities || [] };
    await memory.doUpdate(hit.id, patch);
    return { action: 'updated', id: hit.id };
  }
  const appended = ((hit.source.content || '') + ' ' + fact.statement).trim();
  const patch = { content: appended, tags: Array.from(new Set([...(hit.source.tags || []), ...baseTags])),
    updated_at: new Date().toISOString(), type: fact.type, category: fact.category || 'semantic', confidence: Math.max(fact.confidence, hit.source.confidence || 0),
    expires_at: expires_at || hit.source.expires_at || null, source: scope.source || null, fact_entities: fact.entities || [] };
  await memory.doUpdate(hit.id, patch);
  return { action: 'supplemented', id: hit.id };
}

module.exports = { splitSentences, keywordAllowed, llmExtract, shouldCapture, extractFacts, judgeRelation, reconcileFact };
