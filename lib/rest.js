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

let ADMIN_HTML = '';
try { ADMIN_HTML = fs.readFileSync(path.join(config.ROOT, 'admin.html'), 'utf8'); } catch (e) { errC.other++; }

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
  ],
  search_modes: [
    { id: 'semantic', desc: '语义 kNN（Qdrant + 嵌入）' },
    { id: 'keyword', desc: '关键词 BM25（FTS5）' },
    { id: 'hybrid', desc: '混合（RRF 应用层融合）' },
  ],
  notes: [
    'MCP SSE 端点为 GET /sse，鉴权通过 ?key=xxx 查询参数传递（兼容不支持自定义 header 的客户端）',
  ],
};

// ---- Fastify 应用 ----
const MCP_TOOLS = mcp.TOOLS;

function createApp() {
  const app = fastify({ logger: false });

  // CORS
  app.register(cors, { origin: true });

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
    errC.other++;
    reply.code(code).send({ error: err.message || 'Internal Server Error' });
  });

  // 请求日志（所有路径）
  app.addHook('onResponse', (req, reply, done) => {
    console.log('[req] ' + req.method + ' ' + req.url.split('?')[0] + ' ' + reply.statusCode + ' ' + reply.elapsedTime + 'ms');
    done();
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

  // docs 端点（免鉴权，返回 OpenAPI 格式文档）
  app.get('/api/docs', async (req, reply) => {
    const out = { server_version: config.SERVER_VERSION, tools: MCP_TOOLS, rest_api: DOCS.rest_api, config_fields: DOCS.config_fields, search_modes: DOCS.search_modes, notes: DOCS.notes, overview: DOCS.overview, transport: DOCS.transport };
    return out;
  });

  // ---- 受保护路径（需要 Bearer token）----
  app.register(async function protectedRoutes(instance) {
    // 鉴权中间件
    instance.addHook('preHandler', async (req, reply) => {
      const keys = config.CONFIG.api_keys;
      if (!Array.isArray(keys) || !keys.length) return; // 未配 key 时放行
      const ah = req.headers['authorization'] || '';
      const tok = ah.startsWith('Bearer ') ? ah.slice(7) : (req.query.key || '');
      if (!tok) { reply.code(401).send({ error: 'unauthorized' }); return; }
      const cryptoMod = require('crypto');
      for (const k of keys) {
        try {
          if (k && tok && k.length === tok.length && cryptoMod.timingSafeEqual(Buffer.from(k), Buffer.from(tok))) return;
        } catch (e) { errC.other++; }
      }
      reply.code(401).send({ error: 'unauthorized' });
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
    instance.post('/api/config', async (req, reply) => { reply.code(200);
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
        'api_keys', 'auto_compress', 'backup_path']) {
        if (b[k] !== undefined) newCfg[k] = b[k];
      }
      // api_keys 掩码处理
      if (b.api_keys === '******') { const cur = config.CONFIG.api_keys; if (Array.isArray(cur) && cur.length) newCfg.api_keys = cur; }
      Object.assign(config.CONFIG, newCfg);
      config.saveConfig(config.CONFIG);
      setTimeout(() => { try { require('child_process').exec('systemctl restart ai-memory'); } catch (e) { errC.other++; } }, 400);
      return { ok: true, message: '配置已保存，服务即将重启（约 3-5 秒）' };
    });

    // ==== 记忆 CRUD ====
    instance.post('/api/memories', async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = await memory.doAdd(b);
      reply.code(200);
      return r;
    });
    instance.get('/api/memories', async (req, reply) => {
      const q = req.query.q || '';
      if (!q) {
        const out = await memory.doList(req.query);
        return { count: out.rows.length, rows: out.rows, next_cursor: out.next_cursor || null, usage: out.usage };
      }
      const mode = req.query.mode || 'hybrid';
      const limit = parseInt(req.query.limit || '20');
      const filters = req.query.filters ? JSON.parse(req.query.filters) : null;
      const out = await memory.doSearch({ query: q, mode, limit, filters, ...req.query });
      return { count: out.rows.length, rows: out.rows, next_cursor: out.next_cursor || null, usage: out.usage };
    });
    instance.get('/api/memories/:id', async (req, reply) => {
      const m = await memory.getMemory(req.params.id);
      return m;
    });
    instance.put('/api/memories/:id', async (req, reply) => { reply.code(200);
      const r = await memory.doUpdate(req.params.id, req.body);
      return r;
    });
    instance.delete('/api/memories/:id', async (req, reply) => { reply.code(200);
      await memory.doDelete(req.params.id);
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

    // ==== 批量操作 ====
    instance.post('/api/capture', async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = await capture.captureText(b.text, b);
      return r;
    });
    instance.post('/api/correct/:id', async (req, reply) => { reply.code(200);
      const b = req.body;
      const r = await correction.correctMemory(req.params.id, b.feedback, b);
      return r;
    });

    // ==== 项目 ====
    instance.get('/api/projects', async (req, reply) => { return projects.listProjects(); });
    instance.get('/api/project-links', async (req, reply) => { return backend.sqliteInit().prepare('SELECT * FROM project_links').all(); });
    instance.post('/api/project-links', async (req, reply) => { reply.code(200);
      const b = req.body;
      if (!b.from || !b.to) { reply.code(400).send({ error: 'from and to required' }); return; }
      projects.linkProjects(b.from, b.to, b.strength || 0.5, b.note || '');
      return { ok: true };
    });
    instance.delete('/api/project-links', async (req, reply) => { reply.code(200);
      const b = req.body;
      if (!b.from || !b.to) { reply.code(400).send({ error: 'from and to required' }); return; }
      projects.unlinkProjects(b.from, b.to);
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
    instance.get('/api/webhooks/recent', async (req, reply) => { return webhook.getRecent(); });

    // ==== 导入/导出/重置 ====
    instance.get('/api/export', async (req, reply) => {
      const items = await backend.exportMemories({ user: req.query.user || '', project: req.query.project || '', session: req.query.session || '' });
      return items;
    });
    instance.post('/api/import', async (req, reply) => { reply.code(200);
      const r = await backend.importMemories(req.body.items || []);
      return r;
    });
    instance.post('/api/reset', async (req, reply) => { reply.code(200);
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

    // ==== 捕获 ====
    instance.get('/api/capture/offsets', async (req, reply) => {
      let off = {};
      try { off = JSON.parse(fs.readFileSync(path.join(config.ROOT, '.capture.offsets.json'), 'utf8')); } catch (e) { errC.capture++; }
      return off;
    });

    // ==== 工作记忆 ====
    instance.get('/api/memories/working', async (req, reply) => { return memory.listWorking(req.query); });
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
      transports[transport.sessionId] = transport;
      reply.raw.on('close', () => { delete transports[transport.sessionId]; });
      await server.connect(transport);
    });

    instance.post('/message', async (req, reply) => {
      reply.hijack();
      const sid = req.query.sessionId || '';
      const t = transports[sid];
      if (!t) { reply.raw.writeHead(400, { 'Content-Type': 'application/json' }); reply.raw.end('{"error":"no session"}'); return; }
      // 读取原始 body（Fastify 已 consume body stream）
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      await t.handlePostMessage(req.raw, reply.raw, body);
    });
  });

  return app;
}

let _httpServer = null;
let _healthCache = null;

function startServer() {
  const app = createApp();
  _httpServer = app.server;
  _httpServer.timeout = 30000;
  app.listen({ port: config.PORT, host: '0.0.0.0' }).then(() => {
    console.log('ai-memory MCP+Admin server (v' + config.SERVER_VERSION + ') listening on port ' + config.PORT);
    capture.startWatcher();
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

module.exports = { startServer, shutdown, createApp, DOCS };
