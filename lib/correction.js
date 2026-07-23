// 用户纠正学习（B1，v1.8.0）：把用户纠正反馈应用到最相关记忆——
// 更新内容、标记 corrected_at、提升 confidence 至 0.9（用户纠正=强可信信号）、correction_count+1，
// 旧版本自动进 history（doUpdate 处理）。可被 correct_memory 工具 / POST /api/correct 调用。
const config = require('./config');
const embed = require('./embed');
const util = require('./util');
const memory = require('./memory');

async function doCorrect(a) {
  const feedback = (a.feedback || a.text || '').trim();
  if (!feedback) throw new Error('feedback (correction text) required');
  const user = a.user || 'human';
  const project = a.project || null;
  const session = a.session || null;
  const targetId = a.target_id || null;
  let correctedStatement = null;
  let hint = feedback;

  // 1) 若配置了 LLM，先解析出「被纠正后的陈述」与「目标记忆线索」
  if (config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
    try {
      const c = await embed.chatJSON({ url: config.CONFIG.llm_url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
        messages: [ { role: 'system', content: 'You process a user correction message. If the user is correcting a fact, extract the corrected statement. Reply ONLY JSON: {"correction": string|null, "target_hint": string|null}. No markdown, no commentary.' },
          { role: 'user', content: feedback } ], temperature: 0.1, jsonMode: true });
      if (c) {
        try {
          const p = JSON.parse(String(c).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim());
          if (p && p.correction) correctedStatement = String(p.correction);
          if (p && p.target_hint) hint = String(p.target_hint);
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 2) 定位目标记忆：优先用显式 target_id，否则按语义/关键词检索最相关
  let target = null;
  if (targetId) { try { target = await memory.getMemory(targetId); } catch (e) { target = null; } }
  if (!target) {
    const mode = config.CONFIG.embedding_url ? 'hybrid' : 'keyword';
    const hits = await memory.doSearch({ query: hint, project, user, session, top_k: 3, mode });
    if (hits && hits.length) target = hits[0];
  }
  if (!target) return { corrected: false, reason: 'no matching memory found to correct', suggested: correctedStatement };

  // 3) 应用纠正：内容更新(若有) + corrected_at + confidence 提升 + correction_count+1
  const before = target.content;
  const patch = {
    source: util.normalizeSource({ type: 'human', trigger: 'correction' }),
    corrected_at: new Date().toISOString()
  };
  if (correctedStatement) patch.content = correctedStatement;
  if (target.confidence == null || Number(target.confidence) < 0.9) patch.confidence = 0.9;
  const updated = await memory.doUpdate(target.id, patch);
  await memory.bumpCorrection(target.id);
  return {
    corrected: true,
    id: target.id,
    before,
    after: updated.content || correctedStatement,
    confidence: updated.confidence,
    correction_count: (target.correction_count || 0) + 1
  };
}

module.exports = { doCorrect };
