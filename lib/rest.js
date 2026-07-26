// REST / Admin / SSE 接入层（Fastify v5）。所有功能以 REST 与 MCP(SSE) 暴露。
// v1.14.0: 从原生 http.createServer 迁移到 Fastify，路由更清晰、Schema 校验自动、错误格式统一。
const fs = require('fs');
const path = require('path');
const fastify = require('fastify');
const cors = require('@fastify/cors');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const config = require('./config');
const errC = config.errStats;
const qdrant = require('./qdrant');
const mcp = require('./mcp');
const memory = require('./memory');
const util = require('./util');
const correction = require('./correction');
const projects = require('./projects');
const capture = require('./capture');
const diagnostics = require('./diagnostics');
const quality = require('./quality');
const backend = require('./backend');
const embed = require('./embed');
const webhook = require('./webhook');
const insight = require('./insight');
const scheduler = require('./scheduler'); // v1.17.0 (#102) 后台异步扫描

let ADMIN_HTML = '';
try { ADMIN_HTML = fs.readFileSync(path.join(config.ROOT, 'admin.html'), 'utf8'); } catch (e) { errC.other++; }

// 结构化日志（pino）：启动早期用 console，createApp 后切到 pino 实例
let log = console;
// Prometheus 指标计数器（单进程内存计数，重启归零）
const metrics = {
  mem_add_total: 0,
  mem_update_total: 0,
  mem_delete_total: 0,
  mem_search_total: 0,
  mem_search_errors: 0,
  mem_capture_total: 0,
  mem_error_total: 0,
  search_durations: [],
};

// 登录失败计数（防暴力破解）：按 IP 记录连续鉴权失败，超阈值临时封锁一段时间。
const _authFail = new Map(); // ip -> { count, first, blockUntil }
const AUTH_FAIL_MAX = 10;               // 滑动窗口内最大失败次数
const AUTH_FAIL_WINDOW = 5 * 60 * 1000; // 5 分钟窗口
const AUTH_FAIL_BLOCK = 5 * 60 * 1000;  // 触发后封锁时长
function regAuthFail(ip) {
  const now = Date.now();
  const e = _authFail.get(ip) || { count: 0, first: now, blockUntil: 0 };
  if (now - e.first > AUTH_FAIL_WINDOW) { e.count = 0; e.first = now; }
  e.count++;
  if (e.count >= AUTH_FAIL_MAX) e.blockUntil = now + AUTH_FAIL_BLOCK;
  _authFail.set(ip, e);
}

// ---- v1.17.0 (#99) 同源 / DNS-rebinding 防护 ----
// 仅当 mcp_allowed_origins 为具体域名列表（非 ['*']）时拦截：要求请求 Origin 命中白名单。
// 单端点 /mcp 处理 POST（JSON-RPC 请求/响应）、GET（SSE 流）、DELETE（终止会话）。
// SDK v1.29.0 原生支持 session 管理、SSE 流、同源验证。
let StreamableHTTPServerTransport, isInitializeRequest;
try {
  const sdkStreamable = require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const sdkTypes = require.resolve('@modelcontextprotocol/sdk/types.js');
  StreamableHTTPServerTransport = require(sdkStreamable).StreamableHTTPServerTransport;
  isInitializeRequest = require(sdkTypes).isInitializeRequest;
} catch (e) {
  // 降级：SDK 未安装时继续走旧 SSE 传输
  StreamableHTTPServerTransport = null;
  isInitializeRequest = null;
}
const _mcpStreamableTransports = new Map();
async function handleMcp(req, reply) {
  if (!StreamableHTTPServerTransport) { reply.code(501).send({ error: 'Streamable HTTP not available (SDK missing)' }); return; }
  const origin = req.headers['origin'] || req.headers['referer'];
  const allowed = config.CONFIG.mcp_allowed_origins;
  if (allowed && allowed.length && origin) {
    const ok = allowed.includes('*') || allowed.some(a => origin.startsWith(a));
    if (!ok) { reply.code(403).send({ error: 'origin_not_allowed' }); return; }
  }
  reply.hijack();
  const sessionId = req.headers['mcp-session-id'];
  if (req.method === 'DELETE') {
    const t = sessionId ? _mcpStreamableTransports.get(sessionId) : null;
    if (t) { try { await t.close(); } catch (e) {} _mcpStreamableTransports.delete(sessionId); }
    reply.raw.writeHead(200, { 'Content-Type': 'application/json' });
    reply.raw.end(JSON.stringify({ ok: true }));
    return;
  }
  let transport = sessionId ? _mcpStreamableTransports.get(sessionId) : null;
  if (!transport) {
    if (req.method !== 'POST') { reply.raw.writeHead(405); reply.raw.end('Method Not Allowed'); return; }
    if (!isInitializeRequest(req.body)) { reply.raw.writeHead(400, { 'Content-Type': 'application/json' }); reply.raw.end(JSON.stringify({ error: 'no session; send initialize first' })); return; }
    const server = mcp.createServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => require('crypto').randomUUID(),
      onsessioninitialized: (sid) => {
        _mcpStreamableTransports.set(sid, transport);
        transport.onclose = () => _mcpStreamableTransports.delete(sid);
      },
    });
    await server.connect(transport);
  }
  if (req.authScope) { req.auth = req.auth || {}; req.auth.project = req.authScope; }
  if (!req.body) req.body = {};
  await transport.handleRequest(req.raw, reply.raw, req.body);
}

// ---- Docs ----
const DOCS = {
  server_version: config.SERVER_VERSION,
  overview: 'AI Memory 是记忆体 MCP 服务：主存储基于 Qdrant 向量数据库，当 qdrant_url 未配置或无嵌入模型时自动降级为本地 SQLite。',
  transport: 'MCP 通过 SSE 暴露：客户端连接 GET /sse 建立会话，工具调用经 POST /message 转发(JSON-RPC 2.0)。',
  tools: mcp.TOOLS,
  rest_api: [
    { method: 'GET', path: '/api/health', desc: '服务健康与配置摘要。' },
    { method: 'GET', path: '/api/config', desc: '读取当前配置（密码以 ****** 掩码返回）。' },
    { method: 'POST', path: '/api/config', desc: '保存配置到 config.json，自动重启生效。' },
    { method: 'GET', path: '/api/memories?q=&mode=&limit=&project=&user=', desc: '搜索或列出记忆。' },
    { method: 'GET', path: '/api/memories/:id', desc: '读取单条记忆。' },
    { method: 'PUT', path: '/api/memories/:id', desc: '编辑记忆。' },
    { method: 'DELETE', path: '/api/memories/:id', desc: '删除记忆。' },
    { method: 'POST', path: '/api/memories', desc: '存入一条记忆（含去重合并）。body: {content,user?,project?,tags?,merge?,session?,memory_type?,category?}' },
    { method: 'POST', path: '/api/capture', desc: '自动捕获（事实抽取 + 冲突调和 + 入库）。' },
    { method: 'POST', path: '/api/correct/:id', desc: '提交纠正反馈。' },
    { method: 'GET', path: '/api/projects', desc: '列出所有已知项目。' },
    { method: 'GET', path: '/api/project-links', desc: '读取所有项目关联。' },
    { method: 'POST', path: '/api/project-links', desc: '创建或更新项目关联。' },
    { method: 'DELETE', path: '/api/project-links', desc: '删除项目关联。' },
    { method: 'POST', path: '/api/diagnose', desc: '后端连通性自测（embedding/llm/kg/db）。' },
    { method: 'GET', path: '/api/metrics', desc: '质量监控数据。' },
    { method: 'GET', path: '/api/memories/duplicates?threshold=&limit=', desc: '重复/冲突记忆检测（向量余弦或内容 jaccard）。' },
    { method: 'GET', path: '/api/tags/cluster', desc: '标签频率与共现聚类分析。' },
    { method: 'GET', path: '/api/learning/forgetting-curve', desc: '间隔重复遗忘曲线与复习紧迫度分布。' },
    { method: 'GET', path: '/api/kg', desc: '导出持久化知识图谱。' },
    { method: 'GET', path: '/api/kg/neighbors', desc: '图谱邻居查询。' },
    { method: 'POST', path: '/api/reindex', desc: '重建 FTS5 索引 + 持久化图谱 + content_hash 回填。' },
    { method: 'POST', path: '/api/consolidate', desc: '触发记忆巩固。' },
    { method: 'GET', path: '/api/webhooks/recent', desc: '最近 webhook 投递记录。' },
    { method: 'POST', path: '/api/memories/pin', desc: '固定记忆。' },
    { method: 'POST', path: '/api/memories/unpin', desc: '解固记忆。' },
    { method: 'GET', path: '/api/export', desc: '导出记忆。' },
    { method: 'POST', path: '/api/import', desc: '导入记忆。' },
    { method: 'POST', path: '/api/reset', desc: '重置全部记忆。' },
    { method: 'POST', path: '/api/backup', desc: '备份到文件。' },
    { method: 'GET', path: '/api/stats', desc: '记忆统计。' },
    { method: 'GET', path: '/api/capture/offsets', desc: '读取文件监听偏移量。' },
    { method: 'GET', path: '/api/memories/working', desc: '列出工作记忆。' },
    { method: 'POST', path: '/api/memories/working', desc: '添加工作记忆。' },
    { method: 'DELETE', path: '/api/memories/working', desc: '删除工作记忆。' },
    { method: 'POST', path: '/api/memories/working/promote', desc: '提升工作记忆为长期记忆。' },
    { method: 'GET', path: '/api/memories/working/search', desc: '搜索工作记忆。' },
    { method: 'POST', path: '/api/kv', desc: '写入 KV。' },
    { method: 'GET', path: '/api/kv/:key', desc: '读取 KV。' },
    { method: 'DELETE', path: '/api/kv/:key', desc: '删除 KV。' },
  ].sort((a, b) => a.path.localeCompare(b.path)),
  config_fields: [
    { key: 'qdrant_url', desc: 'Qdrant 地址（留空自动降级 SQLite）' },
    { key: 'api_keys', desc: 'Bearer token 数组（空=不启用鉴权）' },
    { key: 'backup_path', desc: '备份文件存储目录' },
    { key: 'embedding_url', desc: '嵌入模型 OpenAI 兼容端点（留空关闭向量检索）' },
    { key: 'embedding_model', desc: '嵌入模型名（如 qwen3-embedding:0.6b）' },
    { key: 'dedup_enabled', desc: '相似记忆自动合并（默认开）' },
    { key: 'dedup_threshold', desc: '合并相似度阈值（默认 0.92）' },
    { key: 'recency_enabled', desc: '启用时间衰减权重（默认开）' },
    { key: 'recency_half_life', desc: '时间衰减半衰期（天，默认 30）' },
    { key: 'expiry_days', desc: '记忆过期天数（0=不过期）' },
    { key: 'lifecycle_policy', desc: '生命周期策略：none / compress / delete' },
    { key: 'capture_watch_enabled', desc: '监听文件自动捕获（默认关）' },
    { key: 'capture_watch_path', desc: '自动捕获监听的目录' },
    { key: 'kg_enabled', desc: '启用知识图谱抽取（默认关）' },
    { key: 'llm_enabled', desc: '启用 LLM 事实抽取/冲突调和（默认开）' },
    { key: 'llm_url', desc: 'LLM OpenAI 兼容端点' },
    { key: 'llm_model', desc: 'LLM 模型名' },
    { key: 'webhook_enabled', desc: '启用 Webhook 投递（默认关）' },
    { key: 'webhook_urls', desc: 'Webhook 目标 URL 数组' },
    { key: 'mmr_enabled', desc: '启用 MMR 重排（默认关）' },
    { key: 'reranker_enabled', desc: '启用重排模型（默认关）' },
    { key: 'auto_compress', desc: '启用自动压缩（默认关）' },
    { key: 'working_ttl_hours', desc: '工作记忆存活时长（小时，默认 24）' },
    { key: 'session_ttl_hours', desc: '会话记忆存活时长（小时，默认 0）' },
    { key: 'preserve_on_conflict', desc: '冲突时保留旧记忆（默认关）' },
    { key: 'salience_enabled', desc: '启用显著性打分（默认开）' },
    { key: 'related_projects_enabled', desc: '启用项目关联（默认开）' },
    { key: 'correction_auto_detect', desc: '纠正自动检测冲突（默认关）' },
    { key: 'mcp_allowed_origins', desc: 'MCP 同源白名单（[\'*\']=放行所有来源，内网场景推荐。生产可设为具体域名。' },
    { key: 'archive_enabled', desc: '启用冷记忆自动归档（默认关）' },
    { key: 'archive_idle_days', desc: '记忆空闲多少天后视为冷记忆（默认 90）' },
    { key: 'archive_min_access', desc: '冷记忆允许最低访问次数（默认 1）' },
    { key: 'embedding_max_concurrent', desc: 'Embedding 并发数（单 GPU=1，多 GPU=N，默认 1）' },
    { key: 'llm_max_concurrent', desc: 'LLM 并发数（单 GPU=1，多 GPU=N，默认 1）' },
    { key: 'embedding_batch_window_ms', desc: 'Embedding 批量窗口毫秒（默认 50）' },
    { key: 'queue_max_size', desc: '请求队列最大长度（默认 100）' },
    { key: 'verify_enabled', desc: '启用虚假完成自动检测（默认开）' },
    { key: 'verify_base_url', desc: '验证 API 端点时的基础 URL（默认 http://127.0.0.1:8765）' },
    { key: 'ssrf_protection', desc: 'v1.20.0 启用 SSRF 防护（拦截内网 IP 出站，默认开）' },
    { key: 'ssrf_allowlist', desc: 'v1.20.0 SSRF 白名单 IP/域名列表' },
    { key: 'quality_auto_enabled', desc: 'v1.20.0 启用记忆质量自动化（过期检测+矛盾修复+置信度衰减，默认开）' },
    { key: 'stale_fact_days', desc: 'v1.20.0 事实过期天数阈值（默认 180）' },
    { key: 'confidence_decay_days', desc: 'v1.20.0 置信度衰减起始天数（默认 90）' },
    { key: 'confidence_decay_rate', desc: 'v1.20.0 置信度衰减速率（默认 0.05）' },
    { key: 'search_cache_enabled', desc: 'v1.20.0 启用搜索结果缓存（默认开）' },
    { key: 'search_cache_ttl_ms', desc: 'v1.20.0 搜索缓存 TTL 毫秒（默认 60000）' },
    { key: 'search_cache_max', desc: 'v1.20.0 搜索缓存最大条目数（默认 200）' },
    { key: 'suggest_related', desc: 'v1.20.0 启用记忆关联推荐（默认开）' },
    { key: 'suggest_related_limit', desc: 'v1.20.0 关联推荐返回条数（默认 5）' },
  ],
  search_modes: [
    { id: 'semantic', desc: '语义 kNN（Qdrant + 嵌入）' },
    { id: 'keyword', desc: '关键词 BM25（FTS5）' },
    { id: 'hybrid', desc: '混合（RRF 应用层融合）' },
  ],
  notes: [
    'MCP SSE 端点为 GET /sse，鉴权通过 ?key=xxx 查询参数传递（兼容不支持自定义 header 的客户端）',
  ],
  curl_examples: [
    { title: '健康检查', cmd: 'curl http://localhost:8765/api/health' },
    { title: '搜索记忆（关键词）', cmd: 'curl -H "Authorization: Bearer $KEY" "http://localhost:8765/api/memories?q=会议&mode=keyword&limit=10"' },
    { title: '存入一条记忆', cmd: "curl -X POST -H \"Authorization: Bearer $KEY\" -H \"Content-Type: application/json\" -H \"X-Requested-With: ai-memory\" -d '{\"content\":\"团队用 PostgreSQL\",\"project\":\"db\",\"tags\":[\"fact\"]}' http://localhost:8765/api/memories" },
    { title: '重复/冲突检测', cmd: 'curl -H "Authorization: Bearer $KEY" "http://localhost:8765/api/memories/duplicates?threshold=0.92&limit=20"' },
    { title: '导出记忆', cmd: 'curl -H "Authorization: Bearer $KEY" "http://localhost:8765/api/export?project=db" -o export.json' },
  ],
  forgetting_curve_note: '遗忘曲线基于间隔重复（SM-2 风格）稳定性 S 预测留存：S 由真实复习间隔（next_review_at − 锚点时间）或访问次数派生（2^access·2h，封顶 720h）。留存 R(t)=e^(−Δt/S)，Δt 为距锚点小时数。曲线展示「假设不再复习」未来 30 天平均留存衰减；due_count 为已到复习时点的记忆数。调高 recency_half_life 或增大访问频次可提升 S，减缓遗忘。',
};

// ---- Fastify 应用 ----
const MCP_TOOLS = mcp.TOOLS;

function createApp() {
  const app = fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  log = app.log;

  // CORS（v1.17.0 #99）：按配置 mcp_allowed_origins 放行。['*'] 反射请求方 Origin（宽松，兼容无 Origin 头的非浏览器 MCP 客户端）；
  // 具体域名数组时仅放行匹配来源。非浏览器客户端（无 Origin 头，如 MCP SDK / curl）一律放行。
  const _allowedOrigins = config.CONFIG.mcp_allowed_origins || ['*'];
  const _originWild = _allowedOrigins.length === 1 && _allowedOrigins[0] === '*';
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 非浏览器客户端
      if (_originWild) return cb(null, true);
      const ok = _allowedOrigins.some(o => {
        if (!o || o === '*') return false;
        if (o.startsWith('*.')) { const dom = o.slice(2); try { const u = new URL(origin); return u.host === dom || u.host.endsWith('.' + dom); } catch (e) { return false; } }
        return origin === o;
      });
      cb(null, ok);
    },
    credentials: true,
  });

  // 限流：v1.17.0 临时移除（回归中 ECONNRESET，待排查后恢复）
  // 对破坏性操作再加一层限制（经过 auth 后）
  const strictRate = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

  // OpenAPI Swagger 文档（暴露 /docs + /api/docs/json）
  app.register(require('@fastify/swagger'), {
    openapi: { info: { title: 'ai-memory API', version: config.SERVER_VERSION, description: 'AI 长期记忆服务' },
      servers: [{ url: 'http://localhost:' + config.PORT }] },
    exposeRoute: true,
  });
  app.register(require('@fastify/swagger-ui'), { routePrefix: '/docs' });

  // 允许空的 JSON body（DELETE/cleanup 等发空 body 带 Content-Type 的场景）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body || !body.trim()) { done(null, {}); return; }
    try { done(null, JSON.parse(body)); } catch (e) { done(new Error('Invalid JSON'), null); }
  });

  // 统一错误格式
  app.setErrorHandler((err, req, reply) => {
    const code = err.statusCode || err.status || 500;
    metrics.mem_error_total++;
    errC.other++;
    reply.code(code).send({ error: err.message || 'Internal Server Error' });
  });

  // ---- 公开路径（无鉴权）----
  app.get('/api/health', async (req, reply) => {
    const now = Date.now();
    if (_healthCache && _healthCache.ts && now - _healthCache.ts < 1000) return _healthCache.body;
    let qOk = false;
    if (qdrant.useQdrant()) { try { qOk = await qdrant.health(); } catch (e) { errC.other++; } }
    const store = qdrant.useQdrant() ? 'qdrant' : 'sqlite';
    const body = {
      ok: true, version: config.SERVER_VERSION, store, qdrant_connected: qOk,
      dedup_stats: backend.dedupStats, err_stats: backend.errStats,
      config: { qdrant_url: config.CONFIG.qdrant_url, qdrant_collection: config.CONFIG.qdrant_collection,
        embedding_url: config.CONFIG.embedding_url, embedding_model: config.CONFIG.embedding_model,
        embedding_enabled: !!config.CONFIG.embedding_url, llm_enabled: config.CONFIG.llm_enabled,
        capture_watch_enabled: config.CONFIG.capture_watch_enabled, kg_enabled: config.CONFIG.kg_enabled } };
    _healthCache = { ts: now, body };
    return body;
  });

  app.get('/admin', async (req, reply) => {
    if (!ADMIN_HTML) { reply.code(500).send('admin.html missing'); return; }
    reply.type('text/html').send(ADMIN_HTML);
  });

  // Prometheus 指标端点（监控抓取用，公开）
  app.get('/metrics', async (req, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return renderPrometheus();
  });

  // docs 端点（免鉴权，返回 OpenAPI 格式文档）
  app.get('/api/docs', async (req, reply) => {
    const out = { server_version: config.SERVER_VERSION, tools: MCP_TOOLS, rest_api: DOCS.rest_api, config_fields: DOCS.config_fields, search_modes: DOCS.search_modes, notes: DOCS.notes, curl_examples: DOCS.curl_examples, forgetting_curve_note: DOCS.forgetting_curve_note, overview: DOCS.overview, transport: DOCS.transport };
    return out;
  });

  // ---- 受保护路径（需要 Bearer token）----
  app.register(async function protectedRoutes(instance) {
  // 鉴权中间件
  // 受保护路由统一限流：比全局(100/min)更紧，防鉴权后的接口被滥用。
  instance.register(require('@fastify/rate-limit'), { max: 60, timeWindow: '1 minute', keyGenerator: (req) => req.ip });
  instance.addHook('preHandler', async (req, reply) => {
      const p = (req.routeOptions && req.routeOptions.url) || req.url || '';
      const isMcp = p === '/sse' || p === '/message' || p === '/mcp';
      const keys = config.CONFIG.api_keys;
      if (!Array.isArray(keys) || !keys.length) { req.authScope = null; return; } // 未配 key 时放行
      const ip = req.ip;
      // 登录失败锁定：同一 IP 连续鉴权失败超阈值后临时封锁，防暴力破解。
      const af = _authFail.get(ip);
      if (af && af.blockUntil && Date.now() < af.blockUntil) {
        const retry = Math.ceil((af.blockUntil - Date.now()) / 1000);
        reply.code(429).header('Retry-After', retry).send({ error: 'too_many_failed_attempts', retry_after: retry });
        return;
      }
      const ah = req.headers['authorization'] || '';
      const tok = ah.startsWith('Bearer ') ? ah.slice(7) : (req.query.key || '');
      if (!tok) { regAuthFail(ip); reply.code(401).send({ error: 'unauthorized' }); return; }
      const cryptoMod = require('crypto');
      let matched = null;
      for (const k of keys) {
        try {
          // v1.17.0 (#105): 支持对象式 scoped key {key, project}，也兼容旧式字符串主 key
          if (typeof k === 'string') { if (k && tok.length === k.length && cryptoMod.timingSafeEqual(Buffer.from(k), Buffer.from(tok))) { matched = { scope: null }; break; } }
          else if (k && typeof k.key === 'string') { if (tok.length === k.key.length && cryptoMod.timingSafeEqual(Buffer.from(k.key), Buffer.from(tok))) { matched = { scope: k.project || null }; break; } }
        } catch (e) { errC.other++; }
      }
      if (!matched) { regAuthFail(ip); reply.code(401).send({ error: 'unauthorized' }); return; }
      _authFail.delete(ip); // 成功即清零失败计数
      req.authScope = matched.scope;
      // 身份通过：REST 写操作需同源校验（防 CSRF 跨站请求）；MCP 端点（SDK/非浏览器）豁免该 header 要求
      if (!isMcp && req.method !== 'GET' && !req.query.key) {
        const xrw = req.headers['x-requested-with'];
        if (xrw !== 'ai-memory') { reply.code(403).send({ error: 'forbidden', reason: 'missing X-Requested-With header' }); return; }
      }
    });

  // v1.17.0 (#105): scoped key 作用域强制——限定 memory 类接口只能访问指定 project
  instance.addHook('preHandler', async (req, reply) => {
    if (!req.authScope) return;
    const p = (req.routeOptions && req.routeOptions.url) || '';
    if (/^\/api\/memories(\/|$)/.test(p) || p === '/api/context' || /^\/api\/memories\/working/.test(p)) {
      if (req.query) req.query.project = req.authScope;
      if (req.body && typeof req.body === 'object') req.body.project = req.authScope;
    }
  });

    // ==== 配置 ====
    instance.get('/api/config', async (req, reply) => {
      const c = Object.assign({}, config.CONFIG);
      if (c.api_keys && c.api_keys.length) c.api_keys = '******';
      if (c.embedding_api_key) c.embedding_api_key = '******';
      if (c.llm_api_key) c.llm_api_key = '******';
      if (c.kg_api_key) c.kg_api_key = '******';
      return c;
    });
    instance.post('/api/config', strictRate, async (req, reply) => { reply.code(200);
      const b = req.body;
      const newCfg = {};
      for (const k of ['qdrant_url', 'qdrant_collection', 'embedding_url', 'embedding_model', 'embedding_api_key', 'embedding_timeout_ms',
        'dedup_enabled', 'dedup_threshold', 'recency_enabled', 'recency_half_life', 'expiry_days', 'lifecycle_policy',
        'llm_enabled', 'llm_url', 'llm_model', 'llm_api_key', 'llm_timeout_ms',
        'capture_watch_enabled', 'capture_watch_path', 'capture_min_chars', 'capture_keywords', 'capture_max_per_call',
        'fact_types', 'auto_filter', 'fact_confidence_threshold', 'reconcile_enabled',
        'kg_enabled', 'kg_max_entities', 'kg_synonyms', 'kg_model', 'kg_url', 'kg_api_key',
        'entity_link_boost', 'session_ttl_hours', 'source_trust_enabled', 'source_trust_weights',
        'preserve_on_conflict', 'salience_enabled', 'related_projects_enabled',
        'correction_auto_detect', 'extract_version', 'working_ttl_hours',
        'webhook_enabled', 'webhook_urls', 'webhook_timeout_ms', 'webhook_secret',
        'mmr_lambda', 'mmr_enabled', 'reranker_url', 'reranker_model', 'reranker_api_key',
        'api_keys', 'auto_compress', 'backup_path',
        // v1.20.0 新增配置项
        'ssrf_protection', 'ssrf_allowlist',
        'quality_auto_enabled', 'stale_fact_days', 'confidence_decay_days', 'confidence_decay_rate',
        'search_cache_enabled', 'search_cache_ttl_ms', 'search_cache_max',
        'suggest_related', 'suggest_related_limit']) {
        if (b[k] !== undefined) newCfg[k] = b[k];
      }
      // api_keys 掩码处理
      if (b.api_keys === '******') { const cur = config.CONFIG.api_keys; if (Array.isArray(cur) && cur.length) newCfg.api_keys = cur; }
      Object.assign(config.CONFIG, newCfg);
      config.saveConfig(config.CONFIG);
      setTimeout(() => { try { require('child_process').exec('systemctl restart ai-memory'); } catch (e) { errC.other++; } }, 400);
      return { ok: true, restarting: true, message: '配置已保存，服务即将重启（约 3-5 秒）' };
    });

    // ==== 记忆 CRUD ====
    instance.post('/api/memories', async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = await memory.doAdd(b);
      metrics.mem_add_total++;
      reply.code(200);
      return r;
    });
    instance.get('/api/memories', async (req, reply) => {
      // Fastify 的 query 全是字符串，需转数字
      const q = req.query.q || '';
      const query = { ...req.query };
      if (query.limit) query.limit = parseInt(query.limit, 10);
      if (query.from) query.from = String(query.from);
      if (query.to) query.to = String(query.to);
      // 空字符串参数要剔除（Fastify 对 ?user=&project= 返回空字符串而非 undefined）
      const cleaned = Object.fromEntries(Object.entries(query).filter(([_, v]) => v !== '' && v !== undefined && v !== null));
      if (!q) {
        const out = await memory.doList(cleaned);
        return { count: out.rows.length, rows: out.rows, next_cursor: out.next_cursor || null, usage: out.usage };
      }
      const mode = cleaned.mode || 'hybrid';
      const limit = parseInt(cleaned.limit || '20');
      const filters = cleaned.filters ? JSON.parse(cleaned.filters) : null;
      const t0 = Date.now();
      let out;
      try {
        out = await memory.doSearch({ query: q, mode, limit, filters, ...cleaned });
      } catch (e) {
        metrics.mem_search_errors++;
        throw e;
      }
      metrics.mem_search_total++;
      const dt = Date.now() - t0;
      metrics.search_durations.push(dt);
      if (metrics.search_durations.length > 200) metrics.search_durations.shift();
      return { count: out.rows.length, rows: out.rows, next_cursor: out.next_cursor || null, usage: out.usage };
    });
    instance.get('/api/memories/:id', async (req, reply) => {
      const m = await memory.getMemory(req.params.id);
      return m;
    });
    instance.put('/api/memories/:id', async (req, reply) => { reply.code(200);
      const r = await memory.doUpdate(req.params.id, req.body);
      metrics.mem_update_total++;
      return r;
    });
    instance.delete('/api/memories/:id', async (req, reply) => { reply.code(200);
      await memory.doDelete(req.params.id);
      metrics.mem_delete_total++;
      return { ok: true };
    });
    instance.post('/api/memories/pin', async (req, reply) => { reply.code(200);
      const r = await memory.doUpdate(req.body.id, { pinned: true });
      return r;
    });
    instance.post('/api/memories/unpin', async (req, reply) => { reply.code(200);
      const r = await memory.doUpdate(req.body.id, { pinned: false });
      return r;
    });
    // 清理过期记忆（按 days/scope）
    instance.delete('/api/memories/cleanup', async (req, reply) => { reply.code(200);
      const purged = await memory.purgeMemories({ days: req.query.days, user: req.query.user, project: req.query.project, session: req.query.session });
      return { ok: true, purged };
    });
    // 按过滤器批量删除
    instance.delete('/api/memories/filter', async (req, reply) => { reply.code(200);
      const b = req.body || {};
      const r = await memory.deleteByFilter(b.filters, b);
      return r;
    });

    // 深度记忆巩固
    instance.post('/api/memories/:id/infer', async (req, reply) => { reply.code(200);
      const facts = require('./facts');
      const r = await facts.inferMemory(req.params.id);
      return r;
    });

    // 会话总结与批量 promote
    instance.post('/api/session/conclude', async (req, reply) => { reply.code(200);
      const b = req.body || {};

    // 错误模式学习与跨 Agent 总览
    instance.get('/api/learning/summary', async (req, reply) => {
      const project = req.query.project || '';
      const user = req.query.user || '';
      // 纠正统计
      const d = backend.sqliteInit();
      let corrections = [];
      try {
        let sql = 'SELECT memory_id, op, ts, before, after FROM memory_changelog WHERE op=?';
        const params = ['CORRECT'];
        if (project) { sql += ' AND project=?'; params.push(project); }
        if (user) { sql += ' AND user=?'; params.push(user); }
        sql += ' ORDER BY ts DESC LIMIT 20';
        corrections = d.prepare(sql).all(...params).map(c => ({ id: c.memory_id, ts: c.ts, before: JSON.parse(c.before || 'null'), after: JSON.parse(c.after || 'null') }));
      } catch (e) { errC.other++; }
      // Agent 列表
      let agents = [];
      try {
        if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
          const pts = await qdrant.scrollAll({});
          const agentSet = new Set();
          for (const p of pts) { if (p.payload && p.payload.actor_id) agentSet.add(p.payload.actor_id); if (p.payload && p.payload.agent_id) agentSet.add(p.payload.agent_id); }
          agents = [...agentSet];
        } else {
          const all = d.prepare('SELECT DISTINCT actor_id, agent_id FROM memories').all();
          const agentSet = new Set();
          for (const r of all) { if (r.actor_id) agentSet.add(r.actor_id); if (r.agent_id) agentSet.add(r.agent_id); }
          agents = [...agentSet];
        }
      } catch (e) { errC.other++; }
      return { ok: true, total_corrections: corrections.length, recent_corrections: corrections, known_agents: agents };
    });
      const session = b.session;
      if (!session) { reply.code(400).send({ error: 'session required' }); return; }
      const wm = await memory.listWorking({ session });
      if (!wm.length) { return { ok: true, promoted: 0, summarized: false, message: '无工作记忆' }; }
      const contents = wm.map(w => '- ' + (w.content || '')).join('\n');
      let summary = null;
      const url = config.CONFIG.llm_url;
      if (url && wm.length > 1) {
        try {
          const embedMod = require('./embed');
          const c = await embedMod.chatJSON({ url, model: config.CONFIG.llm_model, apiKey: config.CONFIG.llm_api_key || null,
            messages: [{ role: 'system', content: '把以下会话中的关键信息合并成一条简洁摘要。只返回 JSON: {"summary":"..."}' },
              { role: 'user', content: '会话要点：\n' + contents }], temperature: 0.2, jsonMode: true });
          if (c && c.summary) summary = String(c.summary).trim();
        } catch (e) { errC.other++; }
      }
      let promoted = 0;
      for (const w of wm) {
        try { await memory.promoteWorking(w.id, b); promoted++; } catch (e) { errC.other++; }
      }
      if (summary) {
        try { await memory.doAdd({ content: summary, user: b.user || wm[0].user, project: b.project || wm[0].project, session: b.session, tags: ['session-summary', 'consolidated'], memory_type: 'consolidated' }); } catch (e) { errC.other++; }
      }
      return { ok: true, promoted, summarized: !!summary, summary };
    });

    // ==== 批量操作 ====
    instance.post('/api/capture', async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = await capture.captureText(b.text, b);
      metrics.mem_capture_total++;
      return r;
    });
    instance.post('/api/correct/:id', async (req, reply) => { reply.code(200);
      const b = req.body || {};
      // 校正逻辑在 correction.doCorrect（按 target_id 定位 + LLM 解析纠正陈述 + 提升置信度）。
      const r = await correction.doCorrect({ target_id: req.params.id, feedback: b.feedback, user: b.user, project: b.project, session: b.session });
      return r;
    });

    // 测试后端连接（admin 页面的测试按钮）
    instance.post('/api/test-backend', async (req, reply) => { reply.code(200);
      const b = req.body, type = b.type || '';
      try {
        if (type === 'db') return await diagnostics.testDatabase(b);
        if (type === 'embedding') return await diagnostics.testEmbedding(b);
        if (type === 'llm') return await diagnostics.testChat(b);
        if (type === 'kg') return await diagnostics.testKG(b);
        reply.code(400).send({ ok: false, message: '未知测试类型' });
      } catch (e) { reply.code(500).send({ ok: false, message: '测试异常: ' + (e.message || e) }); }
    });

    // ==== 项目 ====
    instance.get('/api/projects', async (req, reply) => { return projects.listProjects(); });
    instance.get('/api/project-links', async (req, reply) => { return backend.sqliteInit().prepare('SELECT * FROM project_links').all(); });
    instance.post('/api/project-links', async (req, reply) => { reply.code(200);
      const b = req.body || {};
      // 兼容 from/to 与 from_project/to_project 两种命名（客户端与测试曾混用）。
      const from = b.from || b.from_project;
      const to = b.to || b.to_project;
      if (!from || !to) { reply.code(400).send({ error: 'from and to required' }); return; }
      projects.upsertProjectLink(from, to, b.strength || 0.5, b.note || '');
      return { ok: true };
    });
    instance.delete('/api/project-links', async (req, reply) => { reply.code(200);
      const b = req.body || {};
      // 兼容 body / query、from/to 与 from_project/to_project 多种命名。
      const from = b.from || b.from_project || req.query.from || req.query.from_project;
      const to = b.to || b.to_project || req.query.to || req.query.to_project;
      if (!from || !to) { reply.code(400).send({ error: 'from and to required' }); return; }
      projects.removeProjectLink(from, to);
      return { ok: true };
    });

    // ==== 诊断 ====
    instance.post('/api/diagnose', async (req, reply) => { reply.code(200);
      const b = req.body || {};
      const dg = await diagnostics.testAll(b);
      return dg;
    });

    // ==== 质量监控 ====
    instance.get('/api/metrics', async (req, reply) => { return quality.getMetrics(); });

    // ==== 智能深化（T9）：重复/冲突、标签聚类、遗忘曲线 ====
    instance.get('/api/memories/duplicates', async (req, reply) => {
      const threshold = req.query.threshold ? parseFloat(req.query.threshold) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      return await insight.findDuplicates(threshold, limit);
    });
    instance.get('/api/tags/cluster', async (req, reply) => {
      const mems = await insight.loadAllCached();
      return insight.clusterTags(mems);
    });
    instance.get('/api/learning/forgetting-curve', async (req, reply) => {
      const mems = await insight.loadAllCached();
      return insight.forgettingCurve(mems);
    });

    // ==== 知识图谱 ====
    instance.get('/api/kg', async (req, reply) => {
      const project = req.query.project || null;
      const limit = parseInt(req.query.limit || '200');
      return backend.kgExport(project, limit);
    });
    instance.get('/api/kg/neighbors', async (req, reply) => {
      const entity = req.query.entity || '';
      const limit = parseInt(req.query.limit || '30');
      return { entity, neighbors: backend.kgNeighbors(entity, limit) };
    });

    // ==== 重索引 ====
    instance.post('/api/reindex', async (req, reply) => { reply.code(200);
      let fts = 0, kg = { entities: 0, relations: 0 }, ch = 0;
      try { fts = await backend.ftsReindexAll(); } catch (e) { fts = -1; }
      try { kg = await backend.kgReindexAll(); } catch (e) {}
      try { ch = await backend.backfillContentHash(); } catch (e) { ch = -1; }
      return { ok: true, fts_indexed: fts, kg, content_hash_backfilled: ch };
    });

    // ==== 巩固 ====
    instance.post('/api/consolidate', async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = await memory.consolidate({ project: b.project || null, min_cluster: b.min_cluster || 2, max_per_run: b.max_per_run || 10 });
      return r;
    });

    // ==== Webhooks ====
    instance.get('/api/webhooks/recent', async (req, reply) => { return webhook.recentDeliveries(); });

    // ==== 导入/导出/重置 ====
    instance.get('/api/export', async (req, reply) => {
      const items = await backend.exportMemories({ user: req.query.user || '', project: req.query.project || '', session: req.query.session || '' });
      return items;
    });
    instance.post('/api/import', async (req, reply) => { reply.code(200);
      const r = await backend.importMemories(req.body.items || []);
      return r;
    });
    instance.post('/api/reset', { config: { rateLimit: { max: 2, timeWindow: '5 minutes' } } }, async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = backend.resetMemories(b.confirm);
      return r;
    });
    instance.post('/api/backup', async (req, reply) => { reply.code(200);
      const b = req.body || {};
      const scope = { user: b.user || '', project: b.project || '', session: b.session || '' };
      const items = await backend.exportMemories(scope);
      const bp = util.safePath(config.CONFIG.backup_path || config.ROOT + '/backups');
      if (!bp) { reply.code(400).send({ ok: false, message: 'backup_path 无效' }); return; }
      try { require('fs').mkdirSync(bp, { recursive: true }); } catch (e) { errC.backup++; }
      const fn = bp + '/memories_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      require('fs').writeFileSync(fn, JSON.stringify({ version: config.SERVER_VERSION, exported_at: new Date().toISOString(), count: items.length, items }, null, 2));
      return { ok: true, file: fn, count: items.length };
    });
    instance.get('/api/stats', async (req, reply) => {
      const project = req.query.project || '';
      let total = 0, pinned = 0, expired = 0, catDist = [];
      if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
        try {
          const allFilt = project ? { must: [{ key: 'project', match: { value: project } }] } : undefined;
          total = await qdrant.count(allFilt);
          const pinFilter = project ? { must: [{ key: 'project', match: { value: project } }, { key: 'pinned', match: { value: true } }] } : { must: [{ key: 'pinned', match: { value: true } }] };
          pinned = await qdrant.count(pinFilter);
          const nowIso = new Date().toISOString();
          const expFilter = project ? { must: [{ key: 'project', match: { value: project } }, { key: 'expires_at', range: { lt: nowIso } }] } : { must: [{ key: 'expires_at', range: { lt: nowIso } }] };
          expired = await qdrant.count(expFilter);
        } catch (e) { errC.other++; }
      } else {
        const d = backend.sqliteInit();
        if (project) {
          total = (d.prepare('SELECT COUNT(*) as c FROM memories WHERE project=?').get(project) || {}).c || 0;
          pinned = (d.prepare('SELECT COUNT(*) as c FROM memories WHERE project=? AND pinned=1').get(project) || {}).c || 0;
          expired = (d.prepare('SELECT COUNT(*) as c FROM memories WHERE project=? AND expires_at IS NOT NULL AND expires_at < ?').get(project, new Date().toISOString()) || {}).c || 0;
        } else {
          total = (d.prepare('SELECT COUNT(*) as c FROM memories').get() || {}).c || 0;
          pinned = (d.prepare('SELECT COUNT(*) as c FROM memories WHERE pinned=1').get() || {}).c || 0;
          expired = (d.prepare('SELECT COUNT(*) as c FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').get(new Date().toISOString()) || {}).c || 0;
        }
      }
      return { ok: true, server_version: config.SERVER_VERSION, memories: { total, pinned, expired, by_category: catDist } };
    });

    // ==== 主动上下文（供客户端注入 system prompt，第三项）====
    instance.get('/api/context', async (req, reply) => {
      const project = req.query.project || '';
      const user = req.query.user || '';
      const session = req.query.session || '';
      const limit = parseInt(req.query.limit || '5');
      const out = { project, user, session, retrieved_at: new Date().toISOString() };

      // 高 salience 记忆 top-N
      const topMems = await memory.doList({ project: project || undefined, user: user || undefined, session: session || undefined, limit });
      out.top_memories = (topMems.rows || []).slice(0, limit).map(r => ({
        id: r.id, content: r.content, score: r.score, importance: r.confidence,
        accessed: r.access_count, tags: r.tags, memory_type: r.memory_type,
      }));

      // 待复习记忆（next_review_at < now）
      const due = await memory.doList({ project: project || undefined, user: user || undefined, session: session || undefined, limit: 20, due_review: 'true' });
      out.due_review = (due.rows || []).filter(r => r.next_review_at).slice(0, limit).map(r => ({
        id: r.id, content: r.content, next_review_at: r.next_review_at,
      }));

      // 近期纠正
      try {
        const ch = backend.sqliteInit().prepare('SELECT * FROM memory_changelog WHERE op=? ORDER BY ts DESC LIMIT 5').all('CORRECT');
        out.recent_corrections = ch.map(c => ({ id: c.memory_id, ts: c.ts, after: JSON.parse(c.after || '{}') }));
      } catch (e) { out.recent_corrections = []; }

      // Markdown 格式的纯文本（客户端可直接注入 system prompt）
      let md = '';
      if (out.top_memories.length) {
        md += '## 项目关键背景\n';
        out.top_memories.forEach(m => { md += `- ${m.content}（重要性: ${m.importance || '?'}）\n`; });
      }
      if (out.due_review.length) {
        md += '\n## 待回顾事项\n';
        out.due_review.forEach(m => { md += `- ${m.content}\n`; });
      }
      if (out.recent_corrections.length) {
        md += '\n## 近期用户纠正\n';
        out.recent_corrections.forEach(c => { try { const a = typeof c.after === 'object' ? c.after : JSON.parse(c.after); if (a.content) md += `- ${a.content}\n`; } catch (e) {} });
      }
      out.memory_context = md || '（暂无记忆）';
      return out;
    });
    instance.get('/api/capture/offsets', async (req, reply) => {
      let off = {};
      try { off = JSON.parse(fs.readFileSync(path.join(config.ROOT, '.capture.offsets.json'), 'utf8')); } catch (e) { errC.capture++; }
      return off;
    });

    // ==== 工作记忆 ====
    instance.get('/api/memories/working', async (req, reply) => { return memory.listWorking(Object.fromEntries(Object.entries(req.query || {}).filter(([_, v]) => v !== ''))); });
    instance.post('/api/memories/working', async (req, reply) => { reply.code(200); return await memory.addWorking(req.body); });
    instance.delete('/api/memories/working', async (req, reply) => { reply.code(200);
      const { id } = req.body || {};
      if (!id) { reply.code(400).send({ error: 'id required' }); return; }
      memory.deleteWorking(id);
      return { ok: true };
    });
    instance.post('/api/memories/working/promote', async (req, reply) => { reply.code(200); return await memory.promoteWorking(req.body.id, req.body); });
    instance.get('/api/memories/working/search', async (req, reply) => { return memory.searchWorking(req.query); });

    // ==== KV ====
    instance.post('/api/kv', async (req, reply) => { reply.code(200);
      const { key, value, org } = req.body || {};
      if (!key) { reply.code(400).send({ error: 'key required' }); return; }
      backend.kvSet(key, value, org || '');
      return { ok: true };
    });
    instance.get('/api/kv/:key', async (req, reply) => {
      const org = req.query.org || '';
      const v = backend.kvGet(req.params.key, org);
      if (v === null || v === undefined) { reply.code(404).send({ error: 'not found' }); return; }
      return { key: req.params.key, value: v };
    });
    instance.delete('/api/kv/:key', async (req, reply) => { reply.code(200);
      const org = req.query.org || '';
      backend.kvDelete(req.params.key, org);
      return { ok: true };
    });

    // ==== MCP SSE（需要 raw response，使用 hijack）====
    const transports = {};
    const server = mcp.createServer();

    instance.get('/sse', async (req, reply) => {
      reply.hijack();
      const transport = new SSEServerTransport('/message', reply.raw);
      transport.scope = req.authScope || null; // v1.17.0 (#105): 记录该连接的 scope
      transports[transport.sessionId] = transport;
      reply.raw.on('close', () => { delete transports[transport.sessionId]; });
      await server.connect(transport);
    });

    instance.post('/message', async (req, reply) => {
      reply.hijack();
      const sid = req.query.sessionId || '';
      const t = transports[sid];
      if (!t) { reply.raw.writeHead(400, { 'Content-Type': 'application/json' }); reply.raw.end('{"error":"no session"}'); return; }
      // v1.17.0 (#105): 注入 scope 到 JSON-RPC 消息，供工具层强制 project 作用域
      let body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      if (t.scope) { try { const parsed = JSON.parse(body); if (Array.isArray(parsed)) parsed.forEach(m => m._scope = t.scope); else parsed._scope = t.scope; body = JSON.stringify(parsed); } catch (e) {} }
      await t.handlePostMessage(req.raw, reply.raw, body);
    });

    // ==== v1.17.0 (#99): MCP Streamable HTTP（单端点 /mcp，SDK v1.29.0 内置传输）====
    instance.all('/mcp', async (req, reply) => { await handleMcp(req, reply); });
  });

  return app;
}

let _httpServer = null;
let _healthCache = null;
let _alertPrevious = '';

// 健康告警：每 5 分钟检查 err_stats，有累积错误时推 webhook 通知
function startAlertWatcher() {
  setInterval(() => {
    const es = backend.errStats;
    const keys = ['embed','fts','kg','webhook','bump','changelog','cleanup','capture','backup','config','other'];
    const alerts = keys.filter(k => es[k] > 0).map(k => k + '=' + es[k]);
    if (!alerts.length) return;
    const sig = alerts.join(',');
    if (sig === _alertPrevious) return; // 同内容不重复推送
    _alertPrevious = sig;
    webhook.emit('system.alert', { err_stats: es, summary: 'err_stats 非零: ' + sig });
    console.log('[alert] err_stats 告警: ' + sig);
  }, 5 * 60 * 1000);
}

function startServer() {
  const app = createApp();
  _httpServer = app.server;
  // v1.15.3: 调高 socket 超时。捕获管线(capture)在 LLM/embedding 推理期间对客户端「无数据下发」，
  // 整段空闲时长可达 20~40s；30s 的默认超时会在捕获返回前销毁连接(表现为客户端 "other side closed")。
  // 真正挂死的 upstream 由 capture 内部的 llm_timeout_ms / embedding_timeout_ms 兜底，此处仅给足单请求空闲余量。
  _httpServer.timeout = 120000;
  app.listen({ port: config.PORT, host: '0.0.0.0' }).then(async () => {
    console.log('ai-memory MCP+Admin server (v' + config.SERVER_VERSION + ') listening on port ' + config.PORT);
    await runStartupDiagnostics();
    capture.startWatcher();
    startAlertWatcher();
    try { scheduler.start(); } catch (e) { console.warn('[ai-memory] 调度器启动失败:', e.message); } // v1.17.0 (#102)
    // v1.20.0 (#4c): 启动时为 Qdrant payload 高频过滤字段创建索引（幂等）
    try { if (qdrant.useQdrant()) { const r = await qdrant.ensureIndexes(); if (r.created) console.log('[ai-memory] Qdrant payload 索引已创建:', r.created + '/' + r.total); } } catch (e) { /* 静默 */ }
  }).catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

async function shutdown(signal) {
  console.log('[ai-memory] 收到 ' + signal + '，开始关闭...');
  try { _httpServer && await new Promise(r => _httpServer.close(r)); } catch (e) {}
  try { capture.stopWatcher(); } catch (e) {}
  console.log('[ai-memory] 已关闭完毕');
  process.exit(0);
}

async function runStartupDiagnostics() {
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r({ ok: false, message: '超时跳过' }), ms))]);
  try {
    const [database, embedding, llm, kg] = await Promise.all([
      withTimeout(diagnostics.testDatabase({}), 5000),
      withTimeout(diagnostics.testEmbedding({}), 8000),
      withTimeout(diagnostics.testChat({}), 8000),
      withTimeout(diagnostics.testKG({}), 8000),
    ]);
    console.log('[ai-memory] 启动自检:');
    const line = (n, x) => '  ' + n.padEnd(10) + ': ' + ((x && x.ok) ? 'OK  ' : 'FAIL') + (x && x.message ? ' ' + x.message : '');
    console.log(line('storage', database));
    console.log(line('embedding', embedding));
    console.log(line('llm', llm));
    console.log(line('kg', kg));
  } catch (e) {
    console.warn('[ai-memory] 启动自检异常: ' + (e.message || e));
  }
}

function renderPrometheus() {
  const m = metrics;
  const lines = [];
  const counter = (name, help, val) => {
    lines.push('# HELP ' + name + ' ' + help);
    lines.push('# TYPE ' + name + ' counter');
    lines.push(name + ' ' + val);
  };
  counter('ai_memory_mem_add_total', 'Total memories added', m.mem_add_total);
  counter('ai_memory_mem_update_total', 'Total memories updated', m.mem_update_total);
  counter('ai_memory_mem_delete_total', 'Total memories deleted', m.mem_delete_total);
  counter('ai_memory_mem_search_total', 'Total searches performed', m.mem_search_total);
  counter('ai_memory_mem_search_errors_total', 'Total search errors', m.mem_search_errors);
  counter('ai_memory_mem_capture_total', 'Total captures performed', m.mem_capture_total);
  counter('ai_memory_mem_error_total', 'Total API errors', m.mem_error_total);
  // 搜索耗时直方图
  const durs = m.search_durations;
  const sum = durs.reduce((a, b) => a + b, 0);
  const count = durs.length;
  const buckets = [10, 50, 200, 1000, 5000];
  lines.push('# HELP ai_memory_search_duration_ms Search latency in milliseconds');
  lines.push('# TYPE ai_memory_search_duration_ms histogram');
  for (const b of buckets) {
    const cum = durs.filter(d => d <= b).length;
    lines.push('ai_memory_search_duration_ms_bucket{le="' + b + '"} ' + cum);
  }
  lines.push('ai_memory_search_duration_ms_bucket{le="+Inf"} ' + count);
  lines.push('ai_memory_search_duration_ms_sum ' + sum);
  lines.push('ai_memory_search_duration_ms_count ' + count);
  return lines.join('\n') + '\n';
}

module.exports = { startServer, shutdown, createApp, DOCS };
