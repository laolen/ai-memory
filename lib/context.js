// 上下文/摘要层：把长期记忆按"对话上下文/会话续接/人类可读导出/周期摘要"的方式组织。
// 全部为增量能力，只读复用 memory.doSearch/doList 与 backend.exportMemories，不改核心契约。
const config = require('./config');
const errC = config.errStats;
const memory = require('./memory');
const backend = require('./backend');
const embed = require('./embed');
const util = require('./util');

// 从消息数组提炼查询文本：支持 string[] 或 {role,content}[]，取最近 window 条拼接。
function messagesToQuery(messages, window) {
  const msgs = Array.isArray(messages) ? messages : (messages != null ? [messages] : []);
  const texts = msgs.map(m => {
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object') return String(m.content || m.text || '');
    return '';
  }).filter(Boolean);
  const recent = texts.slice(-(window || 6));
  return recent.join('\n').slice(0, 2000).trim();
}

// #87 上下文主动召回：从最近对话消息中提炼查询，检索最相关的长期记忆，
// 供 Agent 在回答前"主动想起"相关背景。有嵌入服务走 semantic，否则/失败回退 keyword。
async function recallForContext(a = {}) {
  const query = messagesToQuery(a.messages, a.window);
  if (!query) return { ok: true, query: '', mode: null, count: 0, rows: [] };
  const top_k = a.top_k || 5;
  // v1.17.0 (#100): 默认混合检索（hybrid=RRF 融合语义+关键词重排），嵌入不可用时回退 keyword。
  let mode = a.mode || (config.CONFIG.embedding_url ? 'hybrid' : 'keyword');
  const base = { query, user: a.user, project: a.project, session: a.session, top_k, memory_type: a.memory_type, include_related: a.include_related };
  let r;
  try {
    r = await memory.doSearch(Object.assign({}, base, { mode }));
  } catch (e) {
    // semantic/hybrid 依赖嵌入，不可用时回退 keyword
    mode = 'keyword';
    r = await memory.doSearch(Object.assign({}, base, { mode }));
  }
  const rows = (r.rows || []).map(m => ({
    id: m.id, content: m.content, tags: m.tags || [], project: m.project,
    score: m.score != null ? m.score : null, related_project: m.related_project || null,
  }));
  return { ok: true, query: query.length > 200 ? query.slice(0, 200) + '\u2026' : query, mode, count: rows.length, rows };
}

// #88 启动自动续接：拉取项目近期记忆（含工作记忆），推断"上次进行到哪里 / 待继续线索"。
// 有 LLM 则生成 summary+threads；否则回退近期条目清单。
async function resumeState(a = {}) {
  const limit = a.limit || 15;
  const listRes = await memory.doList({ project: a.project, user: a.user, session: a.session, limit, include_working: true });
  const rows = listRes.rows || [];
  const recent = rows.map(r => ({
    id: r.id, content: r.content, tags: r.tags || [], tier: r.tier || 'long', updated_at: r.updated_at || null,
  }));
  let summary = null, threads = null;
  if (rows.length && config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
    const contents = rows.map((r, i) => (i + 1) + '. ' + String(r.content || '').slice(0, 300)).join('\n');
    try {
      const c = await embed.chatJSON({
        url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
        messages: [
          { role: 'system', content: '你是记忆助理。根据近期记忆条目，用中文简要总结"上次进行到哪里/当前状态"，并抽取需要继续跟进的线索。只返回 JSON：{"summary":"...","threads":["...","..."]}' },
          { role: 'user', content: '项目：' + (a.project || '(默认)') + '\n近期记忆：\n' + contents },
        ], temperature: 0.2, jsonMode: true,
      });
      const parsed = util.parseLooseJson(c);
      if (parsed) { summary = parsed.summary ? String(parsed.summary).trim() : null; threads = Array.isArray(parsed.threads) ? parsed.threads.map(String) : null; }
    } catch (e) { errC.other++; }
  }
  return { ok: true, project: a.project || null, count: recent.length, summary, threads, recent };
}

// ---- 时间窗工具（用于 digest）----
function periodStart(period) {
  const now = Date.now();
  const days = period === 'week' ? 7 : (period === 'month' ? 30 : 1);
  return new Date(now - days * 86400000).toISOString();
}

// Markdown 转义：避免 content 中的 | 破坏结构（此处只做最小处理，正文按段落输出）。
function mdEscape(s) { return String(s == null ? '' : s).replace(/\r/g, ''); }

// 分组键提取
function groupKeyOf(item, groupBy) {
  if (groupBy === 'tag') { const t = (item.tags && item.tags[0]) || '(untagged)'; return t; }
  if (groupBy === 'category') return item.mem_category || item.category || '(uncategorized)';
  if (groupBy === 'date') { const d = item.updated_at || item.created_at || ''; return String(d).slice(0, 10) || '(no-date)'; }
  return item.project || '(default)'; // 默认按项目
}

// #92/#107 导出为人类可读文本：复用 backend.exportMemories，按 group_by 分组。
// format ∈ markdown(默认)/jsonl/obsidian/cards；group_by ∈ project(默认)/tag/category/date。
async function exportMarkdown(a = {}) {
  const items = await backend.exportMemories({ project: a.project, user: a.user, limit: a.limit || 10000 });
  const format = (a.format || 'markdown').toLowerCase();
  const groupBy = a.group_by || 'project';
  const groups = new Map();
  for (const it of items) {
    const k = groupKeyOf(it, groupBy);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  let text;
  if (format === 'jsonl') {
    text = items.map(it => JSON.stringify({ id: it.id, content: it.content, tags: it.tags || [], project: it.project, user: it.user, updated_at: it.updated_at || it.created_at })).join('\n');
  } else if (format === 'obsidian') {
    // Obsidian vault 风格：每条一个带 frontmatter 与 wikilink 的笔记
    text = items.map(it => {
      const tags = (it.tags || []).map(t => '#' + String(t).replace(/\s+/g, '_')).join(' ');
      const date = String(it.updated_at || it.created_at || '').slice(0, 10);
      const fm = ['---', 'id: ' + it.id, 'project: ' + (it.project || '(default)'), 'date: ' + date, 'tags: [' + (it.tags || []).join(', ') + ']', '---'].join('\n');
      const links = (it.tags || []).length ? '\n相关标签：' + (it.tags || []).map(t => '[[' + t + ']]').join(' ') : '';
      return fm + '\n\n' + mdEscape(it.content).replace(/\n+/g, '\n') + links + '\n';
    }).join('\n---\n\n');
  } else if (format === 'cards') {
    // 卡片式：按标签分组，每组一张卡片
    const lines = [];
    const sortedKeys = [...groups.keys()].sort((x, y) => groups.get(y).length - groups.get(x).length);
    for (const k of sortedKeys) {
      lines.push('## ' + mdEscape(k) + ' (' + groups.get(k).length + ')');
      lines.push('');
      for (const it of groups.get(k)) {
        const date = String(it.updated_at || it.created_at || '').slice(0, 10);
        lines.push('> ' + mdEscape(it.content).replace(/\n+/g, ' ') + (date ? '  _' + date + '_' : ''));
      }
      lines.push('');
    }
    text = lines.join('\n');
  } else { // markdown
    const lines = [];
    const title = a.project ? ('记忆导出 · ' + a.project) : '记忆导出';
    lines.push('# ' + title);
    lines.push('');
    lines.push('> 导出时间：' + new Date().toISOString() + '　|　共 ' + items.length + ' 条　|　分组：' + groupBy + '　|　格式：' + format);
    lines.push('');
    const sortedKeys = [...groups.keys()].sort((x, y) => groups.get(y).length - groups.get(x).length);
    for (const k of sortedKeys) {
      const arr = groups.get(k);
      lines.push('## ' + mdEscape(k) + ' (' + arr.length + ')');
      lines.push('');
      arr.sort((p, q) => new Date(q.updated_at || q.created_at || 0) - new Date(p.updated_at || p.created_at || 0));
      for (const it of arr) {
        const tags = (it.tags && it.tags.length) ? '  `' + it.tags.join('` `') + '`' : '';
        const date = String(it.updated_at || it.created_at || '').slice(0, 10);
        lines.push('- ' + mdEscape(it.content).replace(/\n+/g, ' ') + tags + (date ? '  \u2014 _' + date + '_' : ''));
      }
      lines.push('');
    }
    text = lines.join('\n');
  }
  return { ok: true, count: items.length, format, group_by: groupBy, groups: groups.size, content: text, markdown: text };
}

// #96 周期摘要：汇总某项目在 period(day|week|month) 内更新的记忆，
// 有 LLM 则生成结构化摘要（highlights/themes/action_items），否则回退分组清单。
async function digest(a = {}) {
  const period = a.period || 'day';
  const from = periodStart(period);
  const listRes = await memory.doList({ project: a.project, user: a.user, limit: a.limit || 200, from });
  const rows = listRes.rows || [];
  const base = { ok: true, project: a.project || null, period, from, count: rows.length };
  if (!rows.length) return Object.assign(base, { summary: null, highlights: [], items: [] });
  const items = rows.map(r => ({ id: r.id, content: r.content, tags: r.tags || [], updated_at: r.updated_at || null }));
  let summary = null, highlights = null, themes = null;
  if (config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
    const contents = rows.map((r, i) => (i + 1) + '. ' + String(r.content || '').slice(0, 300)).join('\n');
    try {
      const c = await embed.chatJSON({
        url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
        messages: [
          { role: 'system', content: '你是记忆助理。根据一段时间内新增/更新的记忆，用中文生成周期摘要。只返回 JSON：{"summary":"整体概述","highlights":["要点1","要点2"],"themes":["主题标签"]}' },
          { role: 'user', content: '项目：' + (a.project || '(默认)') + '　周期：' + period + '\n记忆条目：\n' + contents },
        ], temperature: 0.3, jsonMode: true,
      });
      const parsed = util.parseLooseJson(c);
      if (parsed) {
        summary = parsed.summary ? String(parsed.summary).trim() : null;
        highlights = Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : null;
        themes = Array.isArray(parsed.themes) ? parsed.themes.map(String) : null;
      }
    } catch (e) { errC.other++; }
  }
  return Object.assign(base, { summary, highlights: highlights || [], themes: themes || [], items });
}

module.exports = { recallForContext, resumeState, exportMarkdown, digest, messagesToQuery };
