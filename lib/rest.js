// REST / Admin / SSE 接入层：HTTP 服务把所有功能以 REST 与 MCP(SSE) 暴露。
// 依赖 mcp(createServer/TOOLS)、memory、correction、projects、capture、diagnostics、quality、config、backend、embed。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const config = require('./config');
const qdrant = require('./qdrant');
const mcp = require('./mcp');
const memory = require('./memory');
const correction = require('./correction');
const projects = require('./projects');
const capture = require('./capture');
const diagnostics = require('./diagnostics');
const quality = require('./quality');
const backend = require('./backend');
const embed = require('./embed');

// ---- REST helpers ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', c => data += c);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

let ADMIN_HTML = '';
try { ADMIN_HTML = fs.readFileSync(path.join(config.ROOT, 'admin.html'), 'utf8'); } catch (e) {}

// ---- Docs (interface reference for admin help page; TOOLS reused so it stays in sync) ----
const DOCS = {
  server_version: config.SERVER_VERSION,
  overview: 'AI Memory 是记忆体 MCP 服务：主存储基于 Qdrant 向量数据库（语义 kNN + 结构化 payload 过滤），当 qdrant_url 未配置或无嵌入模型时自动降级为本地 SQLite 文件库（memories.db）。提供记忆的存储(add)、查询(search/list)、编辑、删除能力，支持关键词(语义候选+子串加权)、语义(kNN 向量)与混合(RRF 应用层融合)三种检索模式。本管理界面可管理记忆数据、配置数据库与嵌入模型。',
  transport: 'MCP 通过 SSE 暴露：客户端连接 GET /sse 建立会话，工具调用经 POST /message 转发(JSON-RPC 2.0)。',
  tools: mcp.TOOLS,
  rest_api: [
    { method: 'GET', path: '/api/health', desc: '服务健康与配置摘要：Qdrant 是否连接、向量检索是否启用、当前参数。' },
    { method: 'GET', path: '/api/config', desc: '读取当前配置（密码以 ****** 掩码返回）。' },
    { method: 'POST', path: '/api/config', desc: '保存配置到 config.json，并自动 systemctl restart ai-memory 生效。' },
    { method: 'GET', path: '/api/memories?q=&mode=&limit=&project=&user=', desc: '搜索或列出记忆。q 为空则按时间倒序列出全部。' },
    { method: 'GET', path: '/api/memories/:id', desc: '读取单条记忆原始文档。' },
    { method: 'PUT', path: '/api/memories/:id', desc: '编辑记忆（content/project/tags；改内容会异步重算向量）。' },
    { method: 'DELETE', path: '/api/memories/:id', desc: '删除指定记忆。' },
    { method: 'DELETE', path: '/api/memories/cleanup?expired=1&days=&user=&project=&session=', desc: '生命周期清理：删除超过 N 天的记忆（按 updated_at）。expired=1 用配置的 expiry_days，或传 days 指定天数。' },
    { method: 'GET', path: '/api/memories/:id/history', desc: 'v1.9.1 审计历史：返回该记忆的完整变更时间线（ADD/UPDATE/CORRECT/DELETE 及 before/after 快照、触发来源）。' },
    { method: 'GET', path: '/api/changelog?limit=', desc: 'v1.9.1 全局审计历史：返回所有记忆变更的时间线（按时间倒序）。' },
    { method: 'POST', path: '/api/capture', desc: '自动捕获：把原始对话/文本提炼成记忆并入库。text 必填；可选 user/project/session/tags。配了 llm_enabled+llm_url 时走 LLM 智能提取，否则启发式按句切分去重入库。返回 {captured,skipped,mode,items}。' },
    { method: 'POST', path: '/api/correct', desc: 'v1.8.0 B1 用户纠正学习：把纠正反馈应用到最相关记忆。body:{feedback,target_id?,user?,project?,session?}。返回 {corrected,id,before,after,confidence,correction_count}。' },
    { method: 'GET', path: '/api/metrics', desc: 'v1.8.0 质量监控：实时操作计数/错误率/平均延迟，按操作与按日汇总（SQLite metrics 表持久化）。' },
    { method: 'GET', path: '/api/graph?entity=&type=&limit=', desc: '知识图谱：返回与某实体相连的所有实体（含关系类型与出现次数）及来源记忆。type 可过滤关系类型。需 kg_enabled 且已有抽取数据。' },
    { method: 'GET', path: '/api/graph/path?a=&b=', desc: '知识图谱：在两实体间做关系路径查找（BFS）。无路径返回 path:null。需 kg_enabled。' },
    { method: 'GET', path: '/api/kg?project=&limit=', desc: 'v1.10.0 持久化图谱：聚合跨记忆的实体/关系导出（kg_entities/kg_relations 表），供可视化。project 可过滤。' },
    { method: 'GET', path: '/api/kg/neighbors?entity=&limit=', desc: 'v1.10.0 持久化图谱：返回某实体的邻居（按共现强度排序）。' },
    { method: 'POST', path: '/api/reindex', desc: 'v1.10.0 重建索引：扫描主存储全量记忆，回填 FTS5 全文镜像表与持久化图谱表（迁移存量数据用，幂等）。' },
    { method: 'POST', path: '/api/consolidate', desc: 'v1.10.0 记忆巩固：把同主题碎片化低 salience 记忆 LLM 归纳为一条摘要记忆，原记忆标记 SUPERSEDED。body:{project?,min_cluster?,max_per_run?}。' },
    { method: 'POST', path: '/api/test-backend', desc: '后端自测：验证嵌入/捕获 LLM/图谱三后端是否可用（本地或云端）。body:{type:"embedding"|"llm"|"kg"|"db"} 可选覆盖字段。返回 {ok,message,detail}。' },
  ],
  config_fields: [
    { key: 'qdrant_url', desc: 'Qdrant 节点地址，如 http://192.168.110.248:6333。主存储（向量+结构化 payload），优先于 es_url。' },
    { key: 'qdrant_collection', desc: '记忆存储集合名，默认 memories。向量为 dense_vector 1024 维余弦(本机 Qwen3-Embedding-0.6B)。' },
    { key: 'es_url', desc: 'Elasticsearch 节点地址（历史选项），未配置 qdrant_url 时仍可作为主存储。' },
    { key: 'es_index', desc: '记忆存储索引名，默认 ai_memories。embedding 字段为 dense_vector 1024 维(本机 Qwen3-Embedding-0.6B)。' },
    { key: 'es_user', desc: 'ES 用户名，如 elastic。' },
    { key: 'es_pwd', desc: 'ES 密码。界面留空表示不修改。' },
    { key: 'embedding_url', desc: '嵌入服务接口 URL。兼容 Ollama /api/embed 或 OpenAI /v1/embeddings（云端）。留空则关闭向量检索（仅关键词可用）。' },
    { key: 'embedding_model', desc: '嵌入模型名，如 qwen3-embedding（本地，输出 1024 维向量）。' },
    { key: 'embedding_api_key', desc: '云端 Embedding 的 API Key（OpenAI 兼容 /v1/embeddings 需要 Bearer 鉴权）。本地 Ollama 嵌入留空即可。' },
    { key: 'dedup_enabled', desc: '记忆去重合并开关（true/false），默认 true。开启后相似内容会合并到已有记忆而非新增。' },
    { key: 'dedup_threshold', desc: '合并相似度阈值（0.7~1.0），默认 0.92。余弦相似度 >= 阈值才合并。' },
    { key: 'recency_enabled', desc: '时序加权开关（true/false），默认 true。检索/列出时对结果按「最近访问/强化时间」(last_accessed_at，未访问则回退 updated_at) 做指数衰减加权。' },
    { key: 'salience_enabled', desc: 'v1.6.0: salience 评分开关（true/false），默认 true。salience = 0.5*重要性(confidence) + 0.5*访问强化(access_count 归一)，夹 [0,1]。' },
    { key: 'recency_half_life', desc: '时序半衰期（天），默认 30。' },
    { key: 'expiry_days', desc: '记忆过期天数（0=不过期），默认 0。配合 lifecycle_policy=expire 自动/手动清理超期记忆。' },
    { key: 'lifecycle_policy', desc: '生命周期策略：none（永久保留，仅时序加权）/ expire（超过 expiry_days 的记忆被清理）。默认 none。' },
    { key: 'llm_enabled', desc: '自动捕获的 LLM 智能提取开关（true/false），默认 false。' },
    { key: 'llm_url', desc: 'chat 补全端点（OpenAI 兼容 /v1/chat/completions）。本地 Ollama 或云端（如 https://api.deepseek.com/v1/chat/completions，需配 llm_api_key）。' },
    { key: 'llm_model', desc: '用于提取的 chat 模型名。需在对应端点已可用。' },
    { key: 'llm_api_key', desc: '云端 chat 服务的 API Key。本地 Ollama 留空即无鉴权。' },
    { key: 'llm_timeout_ms', desc: '出站 chat 调用超时毫秒，默认 90000（90s）。' },
    { key: 'embedding_timeout_ms', desc: '出站嵌入调用超时毫秒，默认 30000（30s）。' },
    { key: 'capture_watch_enabled', desc: '自动捕获文件监听开关（true/false），默认 false。' },
    { key: 'capture_watch_path', desc: '监听路径：单个日志文件，或一个目录（.log/.txt/.md/.jsonl）。' },
    { key: 'capture_min_chars', desc: '启发式捕获的单条最小字符数，默认 20。' },
    { key: 'capture_keywords', desc: '可选关键词/正则白名单（留空=全部捕获）。' },
    { key: 'capture_max_per_call', desc: '单次捕获最多入库条数，默认 20。' },
    { key: 'kg_enabled', desc: '知识图谱开关（true/false），默认 false。开启后写入/编辑记忆会用 LLM 抽取实体与关系。' },
    { key: 'kg_max_entities', desc: '单条记忆最多抽取的实体数，默认 30。' },
    { key: 'kg_synonyms', desc: '实体同义词/别名归一表（JSON 对象，alias→canonical）。' },
    { key: 'kg_model', desc: '知识图谱抽取专用 chat 模型名（默认回退到 llm_model）。建议用更强模型（如本地 qwen3.5:9b 或云端 deepseek 系列）。' },
    { key: 'kg_url', desc: '知识图谱抽取专用的 chat 端点（OpenAI 兼容）。留空则复用自动捕获的 llm_url。' },
    { key: 'kg_api_key', desc: '图谱抽取端点（kg_url）的 API Key。留空则复用 llm_api_key。' },
    { key: 'fact_types', desc: '事实抽取的类型本体（JSON 数组）。v1.4.0 新增。' },
    { key: 'auto_filter', desc: '自动捕获的触发判定开关（true/false），默认 false。v1.4.0 新增。' },
    { key: 'fact_confidence_threshold', desc: '事实最低置信度阈值（0-1），默认 0.5。v1.4.0 新增。' },
    { key: 'reconcile_enabled', desc: '冲突检测与合并开关（true/false），默认 true。v1.4.0 新增。' },
    { key: 'entity_link_boost', desc: '实体链接检索加权系数（0-1），默认 0.15。v1.5.0 新增。' },
    { key: 'session_ttl_hours', desc: 'Session 级记忆自动过期小时数（0=关闭），默认 0。v1.5.0 新增。' },
    { key: 'source_trust_enabled', desc: '来源信任加权开关（true/false），默认 true。v1.5.0 新增。' },
    { key: 'source_trust_weights', desc: '来源信任权重表（JSON 对象），默认 {human:1.0,agent:0.85,tool:0.7,system:0.6}。v1.5.0 新增。' },
    { key: 'preserve_on_conflict', desc: '时序 ADD-only 开关（true/false），默认 false。v1.5.0 新增。' },
    { key: 'related_projects_enabled', desc: '跨项目借鉴开关（true/false），默认 true。v1.7.0 新增。' },
    { key: 'correction_auto_detect', desc: '纠正自动检测开关（true/false），默认 false。v1.8.0 新增：开启后捕获时自动识别"不对/应该"类纠正文本并走 correct_memory 逻辑。' },
    { key: 'category', desc: '记忆分类（非配置项，是每条记忆的字段）：semantic/episodic/procedural。' },
  ],
  search_modes: [
    { mode: 'keyword', desc: 'BM25 关键词匹配。不依赖嵌入服务，始终可用。' },
    { mode: 'semantic', desc: 'kNN 向量检索。需 embedding_url 已配置。' },
    { mode: 'hybrid', desc: '关键词 + 语义 的应用层 RRF 融合排序。' },
  ],
  architecture: 'ai-memory.service(Node, :8765) ── 直连 ──> Elasticsearch(:9200)。向量由 llama-embed.service(llama.cpp，CPU 运行，:11435，OpenAI /v1/embeddings) 用 Qwen3-Embedding-0.6B 生成 1024 维向量。配置持久化于 /opt/ai-memory/config.json。代码以 lib/ 分层模块组织（config/util/embed/backend/intelligence/projects/graph/facts/memory/capture/correction/quality/diagnostics/mcp/rest）。',
  notes: [
    '当前 ES 为 basic 许可证，混合检索使用「应用层 RRF」而非服务端 RRF。',
    '向量在 CPU 上生成，单次嵌入约数百毫秒；修改记忆内容会异步重算向量（失败静默跳过）。',
    'Elasticsearch 近实时刷新：写入后约 1 秒才可被搜索到，属正常现象。',
    '管理界面当前无访问鉴权，仅限受信任的内网环境访问。',
    '在 WorkBuddy/opencode 中使用前，需先在连接器页对该 MCP 端点点「信任」/重启加载。',
    '无 Qdrant 降级：config 的 qdrant_url 留空时自动改用本地 SQLite 文件库（memories.db），无需任何外部服务即可存储/检索；embedding 仍可选配（语义检索需要）。',
    '记忆去重合并：dedup_enabled=true 且已配 embedding_url 时，写入内容若与某条已有记忆余弦相似度 >= dedup_threshold（默认 0.92），则合并到该记忆（内容覆盖为最新、标签取并集、重算向量、更新合并时间），而非新增重复条目。add_memory 传 merge:false 可强制新增。',
    '时序感知：每条记忆带 created_at 与 updated_at。检索/列出受 recency_enabled 控制做时间衰减加权（近期优先），并可用 from/to 按 updated_at 做时间窗过滤。合并/编辑内容时会把旧版本压入 history（保留最近 10 条），可用 get_memory / GET /api/memories/:id 查看演变。lifecycle_policy=expire 且 expiry_days>0 时，超期记忆在写入时自动清理，也可用 purge_memories 工具或 DELETE /api/memories/cleanup 手动清理（清理条件：expires_at 过期 或 无 expires_at 且 updated_at 超期）。',
    '自动捕获：新增 capture_memory 工具与 POST /api/capture 端点，把原始对话/文本自动提炼成记忆。配了 llm_enabled+llm_url 时走 LLM 智能提取，否则走启发式入库。所有捕获项打 auto-captured 标签。另支持 capture_watch_enabled + capture_watch_path 服务端文件/目录监听，tail 新增内容自动捕获（offset 持久化到 .capture.offsets.json，重启续传）。',
    '知识图谱：kg_enabled 开启且配了可用端点时，写入/编辑记忆会用 LLM 抽取实体与关系，存入 entities/relations/source/entity_names 字段。新增 related_to / graph_query / path_between 三个 MCP 工具与 GET /api/graph、GET /api/graph/path 两个 REST 端点。',
    'v1.5.0 记忆分层与治理：① 实体链接加权检索；② 记忆分类（category）；③ Session 自动过期；④ 来源信任加权；⑤ 时序 ADD-only（preserve_on_conflict）。',
    'v1.7.0 项目隔离 + 跨项目借鉴 + 溯源：项目间强弱关联（project_links 表 + manage_project_link + /api/project-links），检索/列出按 relationDecay(strength) 衰减借用关联项目记忆，include_related 可逐请求关闭；溯源 normalizeSource 打 captured_at/trigger，admin 可点击查看。',
    'v1.8.0 模块化拆分 + 用户纠正学习(B1) + 质量监控：① 按功能拆分 lib/ 模块（降低单体文件改错风险）；② correct_memory 工具 + POST /api/correct 把用户纠正反馈应用到最相关记忆（更新内容、corrected_at、confidence 提升至 0.9、correction_count+1、保留 history）；③ /api/metrics 暴露实时操作计数/错误率/平均延迟（按操作与按日汇总，SQLite 持久化）。',
    'v1.10.0 检索增强 + 持久化图谱 + 记忆巩固：① FTS5 全文索引（memories.db 的 memory_fts 镜像表，零新依赖）补上 Qdrant 缺失的原生 BM25——keyword 模式做 BM25 硬过滤、hybrid 用 RRF 融合，语义召回放宽后再收敛；② 持久化图谱（kg_entities/kg_relations 表）聚合跨记忆实体关系，GET /api/kg 导出供可视化；③ 记忆巩固（POST /api/consolidate）把同主题碎片化低 salience 记忆 LLM 归纳为摘要记忆，原记忆标记 SUPERSEDED；④ 技术债修复：dedup 始终按 project 作用域隔离（杜绝空 project 跨项目合并污染）、实体词表改为增量更新（不再每次写入全量扫描 O(n)）、doList 末次排序改为 score 优先让跨项目借鉴衰减权重生效。迁移存量数据用 POST /api/reindex 一次回填 FTS 与图谱。',
  ],
};

function createHttpServer() {
  const transports = {};
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // --- MCP SSE ---
      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/message', res);
        transports[transport.sessionId] = transport;
        res.on('close', () => { delete transports[transport.sessionId]; });
        const server = mcp.createServer();
        await server.connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/message') {
        const sid = url.searchParams.get('sessionId');
        const t = transports[sid];
        if (!t) { res.writeHead(400); res.end('unknown session'); return; }
        await t.handlePostMessage(req, res);
        return;
      }
      // --- Admin UI ---
      if (req.method === 'GET' && url.pathname === '/admin') {
        if (!ADMIN_HTML) { res.writeHead(500); res.end('admin.html missing'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ADMIN_HTML);
        return;
      }
      // --- REST: docs ---
      if (url.pathname === '/api/docs' && req.method === 'GET') {
        return sendJson(res, 200, DOCS);
      }
      // --- REST: diagnose ---
      if (url.pathname === '/api/diagnose' && req.method === 'POST') {
        const out = { store: null, qdrant: null, embedding: null };
        out.store = qdrant.useQdrant() ? 'qdrant' : (config.CONFIG.es_url ? 'elasticsearch' : 'sqlite');
        if (qdrant.useQdrant()) {
          try {
            const ok = await qdrant.health();
            let docs = 0; try { docs = await qdrant.count({}); } catch (e2) {}
            out.qdrant = { ok, connected: ok, collection: config.CONFIG.qdrant_collection, docs };
          } catch (e) { out.qdrant = { ok: false, error: String(e && e.message || e) }; }
        } else if (config.client) {
          try {
            const ping = await config.client.ping();
            let docs = null;
            try { const c = await config.client.count({ index: config.CONFIG.es_index }); docs = c.count; } catch (e2) {}
            out.qdrant = { ok: true, connected: !!ping, index: config.CONFIG.es_index, docs };
          } catch (e) { out.qdrant = { ok: false, error: String(e && e.message || e) }; }
        } else {
          out.qdrant = { ok: false, reason: 'qdrant_url 未配置，记忆使用本地 SQLite 文件存储（memories.db）' };
        }
        if (config.CONFIG.embedding_url) {
          try {
            const t0 = Date.now();
            const vec = await embed.embed('connectivity test 连接测试');
            out.embedding = { ok: true, model: config.CONFIG.embedding_model, url: config.CONFIG.embedding_url, dims: Array.isArray(vec) ? vec.length : 0, ms: Date.now() - t0, sample: Array.isArray(vec) ? vec.slice(0,3) : [] };
          } catch (e) { out.embedding = { ok: false, model: config.CONFIG.embedding_model, url: config.CONFIG.embedding_url, error: String(e && e.message || e) }; }
        } else {
          out.embedding = { ok: false, reason: 'embedding_url 未配置，向量检索关闭' };
        }
        return sendJson(res, 200, out);
      }
      // --- REST: health ---
      if (url.pathname === '/api/health' && req.method === 'GET') {
        let qOk = false;
        if (qdrant.useQdrant()) { try { qOk = await qdrant.health(); } catch (e) {} }
        const store = qdrant.useQdrant() ? 'qdrant' : (config.CONFIG.es_url ? 'elasticsearch' : 'sqlite');
        return sendJson(res, 200, {
          ok: true, version: config.SERVER_VERSION, store, qdrant_connected: qOk,
          config: { qdrant_url: config.CONFIG.qdrant_url, qdrant_collection: config.CONFIG.qdrant_collection,
            es_url: config.CONFIG.es_url, es_index: config.CONFIG.es_index, es_user: config.CONFIG.es_user,
            embedding_url: config.CONFIG.embedding_url, embedding_model: config.CONFIG.embedding_model,
            embedding_enabled: !!config.CONFIG.embedding_url, llm_enabled: config.CONFIG.llm_enabled,
            capture_watch_enabled: config.CONFIG.capture_watch_enabled, kg_enabled: config.CONFIG.kg_enabled } });
      }
      // --- REST: metrics (v1.8.0 质量监控) ---
      if (url.pathname === '/api/metrics' && req.method === 'GET') {
        return sendJson(res, 200, quality.getMetrics());
      }
      // --- REST: config GET ---
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const masked = { ...config.CONFIG,
          es_pwd: config.CONFIG.es_pwd || '',
          qdrant_url: config.CONFIG.qdrant_url || '',
          qdrant_collection: config.CONFIG.qdrant_collection || 'memories',
          embedding_api_key: config.CONFIG.embedding_api_key ? '******' : '',
          llm_api_key: config.CONFIG.llm_api_key ? '******' : '',
          kg_api_key: config.CONFIG.kg_api_key ? '******' : '' };
        return sendJson(res, 200, masked);
      }
      // --- REST: config POST (save + restart) ---
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const b = await readBody(req);
        const newCfg = config.loadConfig();
        if (b.es_url) newCfg.es_url = b.es_url;
        if (b.es_user) newCfg.es_user = b.es_user;
        if (b.es_pwd && b.es_pwd !== '******') newCfg.es_pwd = b.es_pwd;
        if (b.es_index) newCfg.es_index = b.es_index;
        if (b.qdrant_url !== undefined) newCfg.qdrant_url = b.qdrant_url;
        if (b.qdrant_collection !== undefined) newCfg.qdrant_collection = b.qdrant_collection || 'memories';
        if (b.embedding_url !== undefined) newCfg.embedding_url = b.embedding_url;
        if (b.embedding_model) newCfg.embedding_model = b.embedding_model;
        if (b.embedding_api_key !== undefined && b.embedding_api_key !== '******') newCfg.embedding_api_key = b.embedding_api_key;
        if (b.dedup_enabled !== undefined) newCfg.dedup_enabled = b.dedup_enabled;
        if (b.dedup_threshold !== undefined) newCfg.dedup_threshold = Number(b.dedup_threshold) || 0.92;
        if (b.recency_enabled !== undefined) newCfg.recency_enabled = b.recency_enabled;
        if (b.recency_half_life !== undefined) newCfg.recency_half_life = Number(b.recency_half_life) || 30;
        if (b.expiry_days !== undefined) newCfg.expiry_days = Number(b.expiry_days) || 0;
        if (b.lifecycle_policy !== undefined) newCfg.lifecycle_policy = b.lifecycle_policy;
        if (b.llm_enabled !== undefined) newCfg.llm_enabled = b.llm_enabled;
        if (b.llm_url !== undefined) newCfg.llm_url = b.llm_url;
        if (b.llm_model !== undefined) newCfg.llm_model = b.llm_model;
        if (b.llm_api_key !== undefined && b.llm_api_key !== '******') newCfg.llm_api_key = b.llm_api_key;
        if (b.llm_timeout_ms !== undefined) newCfg.llm_timeout_ms = Math.max(1000, Number(b.llm_timeout_ms) || 90000);
        if (b.embedding_timeout_ms !== undefined) newCfg.embedding_timeout_ms = Math.max(1000, Number(b.embedding_timeout_ms) || 30000);
        if (b.capture_watch_enabled !== undefined) newCfg.capture_watch_enabled = b.capture_watch_enabled;
        if (b.capture_watch_path !== undefined) newCfg.capture_watch_path = b.capture_watch_path;
        if (b.capture_min_chars !== undefined) newCfg.capture_min_chars = Number(b.capture_min_chars) || 20;
        if (b.capture_keywords !== undefined) newCfg.capture_keywords = b.capture_keywords;
        if (b.capture_max_per_call !== undefined) newCfg.capture_max_per_call = Number(b.capture_max_per_call) || 20;
        if (b.kg_enabled !== undefined) newCfg.kg_enabled = b.kg_enabled;
        if (b.kg_max_entities !== undefined) newCfg.kg_max_entities = Number(b.kg_max_entities) || 30;
        if (b.kg_synonyms !== undefined) newCfg.kg_synonyms = (b.kg_synonyms && typeof b.kg_synonyms === 'object') ? b.kg_synonyms : {};
        if (b.kg_model !== undefined) newCfg.kg_model = b.kg_model || config.CONFIG.llm_model;
        if (b.kg_url !== undefined) newCfg.kg_url = b.kg_url;
        if (b.kg_api_key !== undefined && b.kg_api_key !== '******') newCfg.kg_api_key = b.kg_api_key;
        if (b.fact_types !== undefined && Array.isArray(b.fact_types)) newCfg.fact_types = b.fact_types;
        if (b.auto_filter !== undefined) newCfg.auto_filter = b.auto_filter;
        if (b.fact_confidence_threshold !== undefined) newCfg.fact_confidence_threshold = Number(b.fact_confidence_threshold) || 0.5;
        if (b.reconcile_enabled !== undefined) newCfg.reconcile_enabled = b.reconcile_enabled;
        if (b.entity_link_boost !== undefined) newCfg.entity_link_boost = Number(b.entity_link_boost) || 0.15;
        if (b.session_ttl_hours !== undefined) newCfg.session_ttl_hours = Number(b.session_ttl_hours) || 0;
        if (b.source_trust_enabled !== undefined) newCfg.source_trust_enabled = b.source_trust_enabled;
        if (b.source_trust_weights !== undefined) newCfg.source_trust_weights = (b.source_trust_weights && typeof b.source_trust_weights === 'object') ? b.source_trust_weights : config.CONFIG.source_trust_weights;
        if (b.preserve_on_conflict !== undefined) newCfg.preserve_on_conflict = b.preserve_on_conflict;
        if (b.related_projects_enabled !== undefined) newCfg.related_projects_enabled = b.related_projects_enabled;
        if (b.correction_auto_detect !== undefined) newCfg.correction_auto_detect = b.correction_auto_detect;
        config.saveConfig(newCfg);
        sendJson(res, 200, { ok: true, restarting: true, config: { ...newCfg, es_pwd: newCfg.es_pwd || '' } });
        const { exec } = require('child_process');
        setTimeout(() => { exec('systemctl restart ai-memory'); }, 400);
        return;
      }
      // --- REST: auto-capture ---
      if (url.pathname === '/api/capture' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await capture.captureText(b.text || '', { user: b.user, project: b.project, session: b.session, tags: b.tags, source: b.source, memory_type: b.memory_type });
        return sendJson(res, 200, { ok: true, ...r });
      }
      // --- REST: user correction (B1, v1.8.0) ---
      if (url.pathname === '/api/correct' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await correction.doCorrect(b);
        return sendJson(res, 200, { ok: true, ...r });
      }
      // --- REST: backend self-test ---
      if (url.pathname === '/api/test-backend' && req.method === 'POST') {
        const b = await readBody(req);
        let r;
        if (b.type === 'embedding') r = await diagnostics.testEmbedding(b);
        else if (b.type === 'llm') r = await diagnostics.testChat(b, false);
        else if (b.type === 'kg') r = await diagnostics.testKG(b);
        else if (b.type === 'db') r = await diagnostics.testDatabase(b);
        else return sendJson(res, 400, { ok: false, message: '未知 type：' + b.type });
        return sendJson(res, 200, r);
      }
      // --- REST: knowledge graph ---
      if (url.pathname === '/api/graph' && req.method === 'GET') {
        const entity = url.searchParams.get('entity') || '';
        const relType = url.searchParams.get('type') || '';
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        return sendJson(res, 200, await graph.relatedTo(entity, relType, limit));
      }
      if (url.pathname === '/api/graph/path' && req.method === 'GET') {
        const a = url.searchParams.get('a') || ''; const b = url.searchParams.get('b') || '';
        return sendJson(res, 200, await graph.pathBetween(a, b));
      }
      // --- REST: 持久化图谱导出（v1.10.0，聚合跨记忆的实体/关系，供可视化）---
      if (url.pathname === '/api/kg' && req.method === 'GET') {
        const project = url.searchParams.get('project') || '';
        const limit = parseInt(url.searchParams.get('limit') || '200', 10);
        return sendJson(res, 200, backend.kgExport(project || null, limit));
      }
      if (url.pathname === '/api/kg/neighbors' && req.method === 'GET') {
        const entity = url.searchParams.get('entity') || '';
        const limit = parseInt(url.searchParams.get('limit') || '30', 10);
        return sendJson(res, 200, { entity, neighbors: backend.kgNeighbors(entity, limit) });
      }
      // --- REST: 重建 FTS5 全文索引 + 持久化图谱（v1.10.0，迁移存量数据用）---
      if (url.pathname === '/api/reindex' && req.method === 'POST') {
        let fts = 0, kg = { entities: 0, relations: 0 };
        try { fts = await backend.ftsReindexAll(); } catch (e) { fts = -1; }
        try { kg = await backend.kgReindexAll(); } catch (e) {}
        return sendJson(res, 200, { ok: true, fts_indexed: fts, kg });
      }
      // --- REST: 记忆巩固 / 自动压缩（v1.10.0）---
      if (url.pathname === '/api/consolidate' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await memory.consolidate({ project: b.project || null, min_cluster: b.min_cluster || 2, max_per_run: b.max_per_run || 10 });
        return sendJson(res, 200, r);
      }
      // --- REST: project links (跨项目强弱关联, v1.7.0) ---
      if (url.pathname === '/api/project-links') {
        if (req.method === 'GET') return sendJson(res, 200, { links: projects.loadProjectLinks() });
        if (req.method === 'POST') {
          const b = await readBody(req);
          const ok = projects.upsertProjectLink(b.from_project, b.to_project, b.strength, b.note);
          if (!ok) return sendJson(res, 400, { ok: false, message: 'from_project / to_project 必填且不能相同' });
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          const from = url.searchParams.get('from') || ''; const to = url.searchParams.get('to') || '';
          projects.removeProjectLink(from, to);
          return sendJson(res, 200, { ok: true });
        }
      }
      // --- REST: memories add (核心存储能力，与 MCP add_memory 工具对齐) ---
      if (url.pathname === '/api/memories' && req.method === 'POST') {
        const b = await readBody(req);
        const r = await memory.doAdd({
          content: b.content, user: b.user, project: b.project, session: b.session, tags: b.tags,
          type: b.type, category: b.category, confidence: b.confidence, memory_type: b.memory_type,
          expires_at: b.expires_at, source: b.source, fact_entities: b.fact_entities, merge: b.merge
        });
        return sendJson(res, 200, { ok: true, ...r });
      }
      // --- REST: memories list / search ---
      if (url.pathname === '/api/memories' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const mode = url.searchParams.get('mode') || 'keyword';
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const project = url.searchParams.get('project') || '';
        const user = url.searchParams.get('user') || '';
        const from = url.searchParams.get('from') || '';
        const to = url.searchParams.get('to') || '';
        const type = url.searchParams.get('type') || '';
        const category = url.searchParams.get('category') || '';
        const memory_type = url.searchParams.get('memory_type') || '';
        const minConf = url.searchParams.get('min_confidence') || '';
        const incRel = url.searchParams.get('include_related');
        const filt = { limit, project, user, from, to };
        if (type) filt.type = type;
        if (category) filt.category = category;
        if (memory_type) filt.memory_type = memory_type;
        if (minConf) filt.min_confidence = Number(minConf);
        if (incRel !== null) filt.include_related = (incRel === 'true' || incRel === '1');
        let rows;
        if (q) rows = await memory.doSearch({ query: q, mode, top_k: limit, project, user, from, to, ...filt });
        else rows = await memory.doList(filt);
        return sendJson(res, 200, { count: rows.length, rows });
      }
      // --- REST: memories cleanup (lifecycle) ---
      if (url.pathname === '/api/memories/cleanup' && req.method === 'DELETE') {
        const days = url.searchParams.get('days');
        const expiredOnly = url.searchParams.get('expired') === '1';
        const scope = { user: url.searchParams.get('user') || '', project: url.searchParams.get('project') || '',
          session: url.searchParams.get('session') || '', days: days != null ? Number(days) : (expiredOnly ? config.CONFIG.expiry_days : config.CONFIG.expiry_days) };
        const n = await memory.purgeMemories(scope);
        return sendJson(res, 200, { ok: true, purged: n });
      }
      // --- REST: memory changelog by id (v1.9.1) ---
      const hm = url.pathname.match(/^\/api\/memories\/(.+)\/history$/);
      if (hm && req.method === 'GET') {
        const id = decodeURIComponent(hm[1]);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        return sendJson(res, 200, { memory_id: id, history: backend.getChangelog(id, limit) });
      }
      // --- REST: global changelog (v1.9.1) ---
      if (url.pathname === '/api/changelog' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        return sendJson(res, 200, { history: backend.getChangelogAll(limit) });
      }
      // --- REST: memory get / put / delete by id ---
      const m = url.pathname.match(/^\/api\/memories\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'GET') {
          try {
            if (qdrant.useQdrant()) { const g = await qdrant.get(id); if (!g) return sendJson(res, 404, { error: 'not found' }); return sendJson(res, 200, { id: g.id, ...g.payload }); }
            return sendJson(res, 200, memory.getMemory(id));
          } catch (e) { return sendJson(res, 404, { error: e.message }); }
        }
        if (req.method === 'PUT') {
          const b = await readBody(req);
          const r = await memory.doUpdate(id, b);
          return sendJson(res, 200, { ok: true, ...r });
        }
        if (req.method === 'DELETE') {
          await memory.doDelete(id);
          return sendJson(res, 200, { ok: true, id });
        }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end('error: ' + e.message);
    }
  });
  return httpServer;
}

function startServer() {
  const httpServer = createHttpServer();
  httpServer.listen(config.PORT, () => {
    console.log('ai-memory MCP+Admin server (v' + config.SERVER_VERSION + ') listening on port ' + config.PORT);
    capture.startWatcher();
    backend.refreshEntityVocab().catch(() => {}); // v1.5.0: 启动即构建实体词汇表（实体链接加权用）
  });
  return httpServer;
}

module.exports = { startServer, createHttpServer, DOCS };
