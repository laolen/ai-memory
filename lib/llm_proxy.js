// lib/llm_proxy.js — LLM 代理旁路（无感自动记忆捕获）
// -----------------------------------------------------------------------------
// 设计目标：让 ai-memory 充当 OpenAI 兼容的 LLM「前置代理」。宿主客户端（WorkBuddy /
// opencode / 任意 OpenAI SDK 客户端）只需把 LLM base_url 指向
//   http(s)://<ai-memory-host>:<port>/llm/v1
// 用户提问 + 助手回答就会被整段镜像进 capture 抽取管线并高质量入库——
// 宿主零代码改动、用户与 agent 都无需显式触发，实现「无感自动记忆存储」。
//
// 行为：
//   - POST /llm/v1/chat/completions : 透明转发到真实 LLM（llm_proxy_url || llm_url）。
//       非流式 → 透传原始 JSON；流式(stream:true) → 透传上游 SSE。
//   - GET  /llm/v1/models           : 返回配置中的模型列表（OpenAI 客户端兼容）。
//   - 响应返回/流结束后，只取「本轮用户输入 + 本轮助手回复」两段异步交给
//       capture.captureText 入库（不阻塞响应）。**不传整段历史**——system 提示、历次
//       问答、工具输出对抽取引擎是纯噪声，且会让旧轮次被反复重抽（v1.23.1）。
//       如需回到旧行为可设 llm_proxy_capture_scope='full'。
//   - 上游故障 → 透传错误状态码/正文，不伪造 LLM 回复；本代理只做转发，不合成回答。
//
// 依赖：仅 config / capture / stream（Node 内置），无新增 npm 包。
// -----------------------------------------------------------------------------

const { Readable } = require('stream');
const config = require('./config');
const capture = require('./capture');
const errC = config.errStats;

// 本地统计（供 rest.js 在 Prometheus / 健康接口展示）
const stats = {
  proxy_total: 0,          // 经代理处理的请求数
  proxy_stream_total: 0,   // 其中流式请求数
  proxy_errors: 0,         // 代理自身或上游故障数
  capture_total: 0,        // 已触发自动捕获数
  capture_ok: 0,           // 其中成功入库（captured>0）数
};

// 解析上游地址：llm_proxy_url 优先，否则复用 llm_url；自动补齐 /chat/completions 后缀。
function upstreamUrl() {
  const C = config.CONFIG;
  let base = (C.llm_proxy_url && C.llm_proxy_url.trim()) ? C.llm_proxy_url : C.llm_url;
  if (!base) return null;
  base = base.trim();
  if (!/\/chat\/completions$/i.test(base)) {
    base = base.replace(/\/+$/, '') + '/chat/completions';
  }
  return base;
}

// 解析上游鉴权头（llm_proxy_api_key 优先，否则复用 llm_api_key）。
function upstreamHeaders() {
  const C = config.CONFIG;
  const key = (C.llm_proxy_api_key && C.llm_proxy_api_key.trim()) ? C.llm_proxy_api_key : (C.llm_api_key || '');
  const h = { 'Content-Type': 'application/json' };
  if (key) h['Authorization'] = 'Bearer ' + key;
  return h;
}

// 推断本次对话归属的 project：scoped key 作用域 > X-Project-Path 头 > query.project > 配置默认。
function resolveProject(req) {
  const C = config.CONFIG;
  if (req.authScope) return req.authScope;                          // 受保护路由鉴权钩子对 scoped key 注入
  const h = req.headers || {};
  const headerProj = h['x-project-path'] || h['x-project'] || '';
  if (headerProj && String(headerProj).trim()) return String(headerProj).trim();
  const q = req.query || {};
  if (q.project && String(q.project).trim()) return String(q.project).trim();
  return (C.llm_proxy_capture_project && C.llm_proxy_capture_project.trim()) ? C.llm_proxy_capture_project.trim() : '';
}

// 非流式：从完整 JSON 响应中提取 assistant 文本
function extractContent(d) {
  try {
    if (d && Array.isArray(d.choices) && d.choices[0] && d.choices[0].message && typeof d.choices[0].message.content === 'string') {
      return d.choices[0].message.content;
    }
  } catch (e) {}
  return '';
}

// 流式：从拼接的 SSE 文本中累计 assistant delta.content
function parseSSEContent(raw) {
  let out = '';
  if (!raw) return out;
  const lines = String(raw).split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (delta && typeof delta.content === 'string') out += delta.content;
    } catch (e) { /* 跳过非 JSON 行（注释/心跳） */ }
  }
  return out;
}

// 单条消息的 content 归一化为纯文本：
// OpenAI 多模态格式 content 可能是 [{type:'text',text}, {type:'image_url',...}] 数组。
function textOf(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

// 单段内容上限：避免超长工具输出/贴入的整份文件把抽取 LLM 的上下文撑爆
const MAX_SEG = 8000;
function clip(s) {
  s = String(s || '').trim();
  return s.length > MAX_SEG ? (s.slice(0, MAX_SEG) + '\n…（已截断）') : s;
}

// v1.23.1：只挑出「本轮」——最后一条 user 消息 + 本次助手回复。
// 丢弃 system 提示、历史轮次、tool 消息：它们对事实抽取是噪声，且会导致旧轮次被重复抽取。
function pickCurrentTurn(messages, assistantContent) {
  const list = Array.isArray(messages) ? messages : [];
  let userText = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === 'user') { userText = textOf(m); break; }
  }
  const out = [];
  if (userText.trim()) out.push({ role: 'user', content: clip(userText) });
  if (assistantContent && String(assistantContent).trim()) {
    out.push({ role: 'assistant', content: clip(assistantContent) });
  }
  return out;
}

// 兜底：整段历史模式（llm_proxy_capture_scope='full'），仅保留 user/assistant 段
function pickFull(messages, assistantContent) {
  const out = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: clip(textOf(m)) }))
    .filter(m => m.content);
  if (assistantContent && String(assistantContent).trim()) {
    out.push({ role: 'assistant', content: clip(assistantContent) });
  }
  return out;
}

// 异步把本轮对话交给 capture 入库（不阻塞代理响应）
function fireCapture(messages, assistantContent, project, user) {
  if (!config.CONFIG.llm_proxy_auto_capture) return;
  const scope = (config.CONFIG.llm_proxy_capture_scope || 'turn').toLowerCase();
  const turn = (scope === 'full')
    ? pickFull(messages, assistantContent)
    : pickCurrentTurn(messages, assistantContent);
  // 至少要有 user + assistant 两段才有捕获价值
  if (turn.length < 2) return;
  stats.capture_total++;
  capture.captureText('', {
    messages: turn,
    project: project || null,
    user: user || 'assistant',
    source: 'llm-proxy',
    tags: ['llm-proxy'],
  }).then(r => {
    if (r && (r.captured > 0 || r.updated > 0 || r.supplemented > 0)) stats.capture_ok++;
  }).catch(() => { errC.other++; });
}

// 主入口：处理 /llm/v1/chat/completions
async function handleChatCompletions(req, reply) {
  const C = config.CONFIG;
  if (!C.llm_proxy_enabled) {
    reply.code(503).send({ error: 'llm_proxy_disabled', message: 'LLM 代理未启用（config.llm_proxy_enabled=false）' });
    return;
  }
  const target = upstreamUrl();
  if (!target) {
    reply.code(503).send({ error: 'no_upstream', message: '未配置上游 LLM（需设置 llm_url 或 llm_proxy_url）' });
    return;
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const stream = !!body.stream;
  // 透明转发：client 的 model 原样下传；缺省时回退到 llm_proxy_model / llm_model
  const model = body.model || C.llm_proxy_model || C.llm_model || '';
  const fwd = Object.assign({}, body, { model, stream });

  const project = resolveProject(req);
  const user = (C.llm_proxy_user && C.llm_proxy_user.trim()) ? C.llm_proxy_user.trim() : 'assistant';

  stats.proxy_total++;
  if (stream) stats.proxy_stream_total++;

  const ctrl = new AbortController();
  const timeout = C.llm_timeout_ms || 90000;
  const to = setTimeout(() => ctrl.abort(), timeout);

  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: upstreamHeaders(),
      body: JSON.stringify(fwd),
      signal: ctrl.signal,
    });

    // 上游非 2xx → 透传错误（状态码 + 截断正文），不伪造回复
    if (!r.ok) {
      clearTimeout(to);
      const txt = await r.text().catch(() => '');
      stats.proxy_errors++;
      reply.code(r.status).send({ error: 'upstream_error', status: r.status, detail: txt.slice(0, 800) });
      return;
    }

    if (stream) {
      // 流式：接管底层响应，透传上游 SSE，结束后解析并捕获
      reply.hijack();
      const ct = r.headers.get('content-type') || 'text/event-stream';
      reply.raw.writeHead(r.status, {
        'Content-Type': ct,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const nodeStream = Readable.fromWeb(r.body);
      let acc = '';
      nodeStream.on('data', (chunk) => {
        const s = chunk.toString();
        acc += s;
        reply.raw.write(chunk);
      });
      nodeStream.on('end', () => {
        clearTimeout(to);
        try { reply.raw.end(); } catch (e) {}
        const content = parseSSEContent(acc);
        fireCapture(incomingMessages, content, project, user);
      });
      nodeStream.on('error', (err) => {
        clearTimeout(to);
        errC.other++;
        try { reply.raw.end(); } catch (e) {}
      });
      return;
    }

    // 非流式：透传原始 JSON，再异步捕获
    const d = await r.json();
    clearTimeout(to);
    reply.send(d);
    const content = extractContent(d);
    fireCapture(incomingMessages, content, project, user);
    return;
  } catch (e) {
    clearTimeout(to);
    stats.proxy_errors++;
    errC.other++;
    reply.code(502).send({ error: 'proxy_failed', message: (e && e.message) ? e.message : String(e) });
    return;
  }
}

// GET /llm/v1/models — 返回配置模型列表（OpenAI 客户端兼容）
async function handleModels(req, reply) {
  const C = config.CONFIG;
  const ids = [];
  if (C.llm_proxy_model) ids.push(C.llm_proxy_model);
  if (C.llm_model && C.llm_model !== C.llm_proxy_model) ids.push(C.llm_model);
  if (!ids.length) ids.push('default');
  return {
    object: 'list',
    data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'ai-memory' })),
  };
}

module.exports = { handleChatCompletions, handleModels, stats, upstreamUrl, pickCurrentTurn };
