// 按需间隔召回层（#95）：让 Agent/用户显式安排"N 天后再想起某条内容"，
// 并在到期时批量取出。复用 memory.doAdd（落库）+ doUpdate（精确设 next_review_at）+ doList(due_review)。
const memory = require('./memory');

// 计算到期时间：优先 at（ISO 时间），其次 in_hours，再次 in_days，默认 1 天后。
// 允许非正区间：in_hours/in_days 为 0 或负数时表示"立即到期/已逾期"，
// 这类召回会被 dueRecalls 立即取出（用于测试或补做复习）。
function computeDueIso(a) {
  if (a.at) { const t = new Date(a.at); if (!isNaN(t.getTime())) return t.toISOString(); }
  const now = Date.now();
  if (typeof a.in_hours === 'number') return new Date(now + a.in_hours * 3600000).toISOString();
  const days = (typeof a.in_days === 'number') ? a.in_days : 1;
  return new Date(now + days * 86400000).toISOString();
}

// #95a 安排一次未来召回：新增一条记忆并把 next_review_at 设为目标时间。
// 打 scheduled-recall 标签，便于筛选/审计。
async function scheduleRecall(a = {}) {
  if (!a || !a.content || !String(a.content).trim()) { const e = new Error('content is required'); e.statusCode = 400; throw e; }
  const dueIso = computeDueIso(a);
  const tags = Array.from(new Set(['scheduled-recall', ...((a.tags || []).map(String))]));
  const added = await memory.doAdd({
    content: a.content, user: a.user, project: a.project, session: a.session,
    tags, memory_type: a.memory_type || 'user', source: a.source,
  });
  const id = added.merged ? added.merged_from : added.id;
  let updated = null;
  try { updated = await memory.doUpdate(id, { next_review_at: dueIso }); } catch (e) {}
  return {
    ok: true, id, next_review_at: dueIso,
    merged: !!added.merged,
    content: a.content,
  };
}

// #95b 取出到期的召回项：doList(due_review=true) 只返回 next_review_at 已过的记忆。
async function dueRecalls(a = {}) {
  const listRes = await memory.doList({
    project: a.project, user: a.user, session: a.session,
    limit: a.limit || 50, due_review: true,
  });
  const rows = (listRes.rows || []).map(r => ({
    id: r.id, content: r.content, tags: r.tags || [], project: r.project,
    next_review_at: r.next_review_at || null, updated_at: r.updated_at || null,
  }));
  // 只保留确实带 next_review_at 的（doList 的 due_review 已过滤，此处再稳一层）
  const due = rows.filter(r => r.next_review_at);
  due.sort((x, y) => new Date(x.next_review_at) - new Date(y.next_review_at));
  return { ok: true, count: due.length, now: new Date().toISOString(), rows: due };
}

module.exports = { scheduleRecall, dueRecalls, computeDueIso };
