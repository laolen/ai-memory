// MCP Prompts 原语（v1.17.0 #97）：开箱即用的提示模板，调用方一键触发复杂流程。
// 每个 prompt 返回 messages[]，引导模型调用对应的 MCP 工具完成实际工作。
const PROMPTS = [
  {
    name: 'summarize_project',
    description: '生成某项目的记忆概览与维护建议：先用 memory_health 评估健康度，再导出全文，最后给出关键事实、重复/冲突项与维护建议。',
    arguments: [{ name: 'project', description: '项目名（可选，省略则全局）', required: false }],
    get(a = {}) {
      const p = a.project ? (' project=' + a.project) : '（全局）';
      return {
        description: '项目记忆概览' + p,
        messages: [
          { role: 'user', content: { type: 'text', text:
            `请分三步梳理项目${p}的记忆：\n` +
            `1. 调用 memory_health${a.project ? (' 并传入 project="' + a.project + '"') : ''} 评估健康度（重复/标签/遗忘曲线/卫生度）；\n` +
            `2. 调用 export_memories_markdown${a.project ? (' 并传入 project="' + a.project + '"') : ''} 导出全文；\n` +
            `3. 用中文给出：①项目关键事实与偏好 ②发现的重复或潜在冲突项 ③可执行的维护建议（可结合 prune_memories / merge_memories / due_recalls）。` } },
        ],
      };
    },
  },
  {
    name: 'find_contradictions',
    description: '针对一段候选内容，检测与已有记忆的事实冲突并给出处理建议（引导调用 detect_contradictions）。',
    arguments: [
      { name: 'content', description: '要核查的候选陈述', required: true },
      { name: 'project', description: '项目作用域（可选）', required: false },
    ],
    get(a = {}) {
      const c = String(a.content || '').trim();
      return {
        description: '矛盾检测',
        messages: [
          { role: 'user', content: { type: 'text', text:
            `请调用 detect_contradictions 并传入 content="${c}"` +
            (a.project ? (' project="' + a.project + '"') : '') +
            `，查看返回是否 has_conflict。若冲突，用中文说明冲突点，并建议：用 correct_memory 纠正旧记忆，或以 block_on_conflict:false 强制写入并保留冲突记录。` } },
        ],
      };
    },
  },
  {
    name: 'weekly_digest',
    description: '生成某项目的本周记忆摘要（引导调用 digest period=week）。',
    arguments: [{ name: 'project', description: '项目名（可选）', required: false }],
    get(a = {}) {
      return {
        description: '周度摘要',
        messages: [
          { role: 'user', content: { type: 'text', text:
            `请调用 digest 并传入 period="week"` +
            (a.project ? (' project="' + a.project + '"') : '') +
            `，把返回的 summary/highlights/themes 用中文整理成一份周报（含要点与主题），并挑出需要后续跟进的事项。` } },
        ],
      };
    },
  },
  {
    name: 'export_context',
    description: '把项目记忆导出为人类可读文本，便于粘贴进文档或注入 system prompt（引导调用 export_memory_text）。',
    arguments: [
      { name: 'project', description: '项目名（可选）', required: false },
      { name: 'format', description: '导出格式：markdown/jsonl/obsidian/cards', required: false },
    ],
    get(a = {}) {
      const fmt = a.format || 'markdown';
      return {
        description: '导出记忆文本',
        messages: [
          { role: 'user', content: { type: 'text', text:
            `请调用 export_memory_text 并传入 format="${fmt}"` +
            (a.project ? (' project="' + a.project + '"') : '') +
            `，将返回的文本直接呈现给用户（不要改写内容）。` } },
        ],
      };
    },
  },
];

function listPrompts() { return PROMPTS.map(p => ({ name: p.name, description: p.description, arguments: p.arguments })); }
function getPrompt(name, args) {
  const p = PROMPTS.find(x => x.name === name);
  if (!p) return null;
  return p.get(args || {});
}
module.exports = { PROMPTS, listPrompts, getPrompt };
