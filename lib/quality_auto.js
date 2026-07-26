// v1.20.0 (#3): 记忆质量自动化——从被动存储走向主动质量保证。
// 三个子功能（均由 scheduler 周期性调用，失败静默不影响主流程）：
// ① scanStaleFacts：过期事实检测——扫描 fact 标签记忆，LLM 判定是否过时，打 stale 标签
// ② repairContradictions：矛盾主动修复——发现矛盾后创建 conflict 修复任务（类似 v1.19 fix-needed 机制）
// ③ decayConfidence：置信度自然衰减——长期未访问的记忆 confidence 递减，被引用时回升
const config = require('./config');
const errC = config.errStats;
const insight = require('./insight');
const memory = require('./memory');
const embed = require('./embed');
const util = require('./util');

// ① 过期事实检测：扫描带 fact/preference/decision 标签的记忆，
// 有 LLM 时让 LLM 判断是否可能已过时；无 LLM 时按时间+访问量启发式判断。
// 过时的打 stale 标签，供 AI 轮询发现并核实更新。
async function scanStaleFacts() {
  const out = { at: new Date().toISOString(), checked: 0, stale: 0, error: null };
  try {
    let pool;
    try { pool = await insight.loadAllCached(); } catch (e) { pool = []; }
    const factTags = ['fact', 'preference', 'decision', 'project_fact', 'convention'];
    const candidates = pool.filter(m =>
      m.tags && Array.isArray(m.tags) && m.tags.some(t => factTags.includes(t))
      && !(m.tags.includes('stale'))        // 已标 stale 的跳过
      && !m.pinned                           // 固定的不衰减
    );
    out.checked = candidates.length;
    const now = Date.now();
    const staleDays = config.CONFIG.stale_fact_days || 180;
    const staleMs = staleDays * 24 * 3600 * 1000;

    for (const m of candidates) {
      try {
        let isStale = false;
        // 有 LLM：让模型判断是否过时
        if (config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
          const c = await embed.chatJSON({
            url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
            messages: [
              { role: 'system', content: '判断以下记忆是否可能已过时（技术栈更新、项目变更、事实已被推翻等）。只返回 JSON：{"stale":true/false,"reason":"简短原因"}' },
              { role: 'user', content: '记忆内容：' + (m.content || '').slice(0, 500) + '\n创建时间：' + (m.created_at || '未知') + '\n最后访问：' + (m.last_accessed_at || '从未') },
            ], temperature: 0.1, jsonMode: true,
          });
          const p = util.parseLooseJson(c);
          if (p && p.stale === true) isStale = true;
        } else {
          // 无 LLM：启发式——创建超过 staleDays 天且 access_count=0
          const ageMs = now - new Date(m.updated_at || m.created_at || now).getTime();
          if (ageMs > staleMs && (m.access_count || 0) === 0) isStale = true;
        }
        if (isStale) {
          const newTags = Array.from(new Set([...(m.tags || []), 'stale']));
          await memory.doUpdate(m.id, { tags: newTags });
          out.stale++;
        }
      } catch (e) { errC.other++; }
    }
  } catch (e) { out.error = e.message || String(e); }
  return out;
}

// ② 矛盾主动修复：在 scheduler 已有矛盾抽样基础上，发现矛盾后创建 conflict 修复任务。
// AI 轮询 list_conflicts 发现后可用 merge_memories 或 correct_memory 修复。
async function repairContradictions() {
  const out = { at: new Date().toISOString(), checked: 0, conflicts_found: 0, tasks_created: 0, error: null };
  try {
    const maintain = require('./maintain');
    let pool;
    try { pool = await insight.loadAllCached(); } catch (e) { pool = []; }
    // 只检查近期 N 条（避免全量扫描太慢）
    const sampleN = 40;
    const recent = pool.slice(0, sampleN);
    out.checked = recent.length;
    for (const m of recent) {
      try {
        // 已有 conflict-task 标签的跳过
        if (m.tags && m.tags.includes('conflict-task')) continue;
        const r = await maintain.detectContradictions({ content: m.content, project: m.project, user: m.user, min_similarity: 0.7 });
        if (r && r.has_conflict) {
          out.conflicts_found++;
          // 为每个冲突创建修复任务
          for (const cf of (r.conflicts || [])) {
            try {
              const taskContent = '【矛盾待修复】新记忆与已有记忆可能矛盾。\n新记忆：' + (m.content || '').slice(0, 200) + '\n冲突记忆：' + (cf.content || '').slice(0, 200) + '\n冲突原因：' + (cf.reason || '未知');
              await memory.doAdd({
                content: taskContent,
                user: m.user || 'system',
                project: m.project || 'default',
                tags: ['conflict-task', 'fix-needed', ...(m.tags || []).filter(t => !['fact', 'preference', 'decision'].includes(t))],
                memory_type: 'system',
                entities: [
                  { name: m.id, type: 'ref', label: '新记忆' },
                  { name: cf.id, type: 'ref', label: '冲突记忆' },
                ],
                relations: [{ type: 'conflict-with', target: cf.id }],
              });
              out.tasks_created++;
            } catch (e) { errC.other++; }
          }
        }
      } catch (e) { errC.other++; }
    }
  } catch (e) { out.error = e.message || String(e); }
  return out;
}

// ③ 置信度自然衰减：长期未访问且非 pinned 的记忆，confidence 递减。
// 衰减公式：confidence -= confidence_decay_rate * (days_idle / confidence_decay_days)
// 衰减到 0.1 以下标记为 archive 候选（但不自动归档，由 archive_memories dry-run 发现）。
async function decayConfidence() {
  const out = { at: new Date().toISOString(), checked: 0, decayed: 0, error: null };
  try {
    let pool;
    try { pool = await insight.loadAllCached(); } catch (e) { pool = []; }
    const now = Date.now();
    const decayDays = config.CONFIG.confidence_decay_days || 90;
    const decayRate = config.CONFIG.confidence_decay_rate || 0.05;
    const decayMs = decayDays * 24 * 3600 * 1000;
    for (const m of pool) {
      // 跳过：固定记忆、系统记忆、无 confidence 的
      if (m.pinned) continue;
      if (m.memory_type === 'system') continue;
      if (m.confidence == null) continue;
      const lastAccess = m.last_accessed_at || m.updated_at || m.created_at;
      if (!lastAccess) continue;
      const idleMs = now - new Date(lastAccess).getTime();
      if (idleMs < decayMs) continue; // 未到衰减窗口
      const daysIdle = Math.floor(idleMs / (24 * 3600 * 1000));
      const decayAmount = decayRate * (daysIdle / decayDays);
      const newConf = Math.max(0, (m.confidence || 1) - decayAmount);
      // 只在有实际变化时更新（避免无意义的 Qdrant 写入）
      if (Math.abs(newConf - m.confidence) < 0.001) continue;
      out.checked++;
      try {
        await memory.doUpdate(m.id, { confidence: +newConf.toFixed(4) });
        out.decayed++;
      } catch (e) { errC.other++; }
    }
  } catch (e) { out.error = e.message || String(e); }
  return out;
}

// 置信度回升：当记忆被搜索命中（bumpAccess）时调用，confidence 回升。
// 由 memory.js 的 bumpAccess 路径间接调用（而非 scheduler）。
async function boostConfidence(id) {
  try {
    const m = await memory.getMemory(id);
    if (!m || m.confidence == null) return;
    const boost = 0.1; // 每次被命中回升 0.1
    const newConf = Math.min(1, (m.confidence || 0.5) + boost);
    if (Math.abs(newConf - m.confidence) >= 0.001) {
      await memory.doUpdate(id, { confidence: +newConf.toFixed(4) });
    }
  } catch (e) { /* 静默 */ }
}

// 列出待修复的矛盾任务（供 AI 轮询）
async function listConflicts(project, limit) {
  let pool;
  try { pool = await insight.loadAllCached(); } catch (e) { pool = []; }
  let items = pool.filter(m => m.tags && Array.isArray(m.tags) && m.tags.includes('conflict-task'));
  if (project) items = items.filter(m => m.project === project);
  return items.slice(0, limit || 50);
}

module.exports = { scanStaleFacts, repairContradictions, decayConfidence, boostConfidence, listConflicts };
