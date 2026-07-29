const fs = require('fs');
const path = require('path');

// 项目根目录（server.js 位于 /opt/ai-memory，本文件位于 /opt/ai-memory/lib，故上溯一级）
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// HTTP 监听端口（与 128 部署的 :8765 一致）
const PORT = process.env.PORT || 8765;

// v1.9.0: 单一版本常量，从 package.json 读取作为单一真实来源
const SERVER_VERSION = (() => { try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return '0.0.0'; } })();
// v1.6.0: salience 评分权重（显性的「衰减+强化」综合分，夹 [0,1]）
const SALIENCE_W_IMP = 0.5, SALIENCE_W_ACC = 0.5, SALIENCE_ACCESS_K = 10, SALIENCE_SCORE_W = 0.7;

// ---- Config (persisted to config.json, env as fallback) ----
function loadConfig() {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  return {
    // v1.9.0: Qdrant 向量主存储。留空则降级 SQLite。
    qdrant_url: (f.qdrant_url !== undefined) ? f.qdrant_url : (process.env.QDRANT_URL || ''),
    qdrant_collection: f.qdrant_collection || process.env.QDRANT_COLLECTION || 'memories',
    embedding_url: (f.embedding_url !== undefined) ? f.embedding_url : (process.env.EMBEDDING_URL || ''),
    embedding_model: f.embedding_model || process.env.EMBEDDING_MODEL || 'nomic-embed-text',
    embedding_api_key: f.embedding_api_key || process.env.EMBEDDING_API_KEY || '',
    dedup_enabled: (f.dedup_enabled !== undefined) ? f.dedup_enabled : true,
    dedup_threshold: (f.dedup_threshold !== undefined) ? f.dedup_threshold : 0.92,
    recency_enabled: (f.recency_enabled !== undefined) ? f.recency_enabled : true,
    recency_half_life: (f.recency_half_life !== undefined) ? f.recency_half_life : 30,
    expiry_days: (f.expiry_days !== undefined) ? f.expiry_days : 0,
    lifecycle_policy: f.lifecycle_policy || 'none',
    llm_enabled: (f.llm_enabled !== undefined) ? f.llm_enabled : false,
    llm_url: (f.llm_url !== undefined) ? f.llm_url : 'http://127.0.0.1:11434/v1/chat/completions',
    llm_model: f.llm_model || 'minicpm5-1b',
    llm_api_key: f.llm_api_key || process.env.LLM_API_KEY || '',
    llm_timeout_ms: (f.llm_timeout_ms !== undefined) ? Number(f.llm_timeout_ms) : 90000,
    embedding_timeout_ms: (f.embedding_timeout_ms !== undefined) ? Number(f.embedding_timeout_ms) : 60000, // v1.22.1: 默认 60s（冷启动需要更长时间）
    capture_watch_enabled: (f.capture_watch_enabled !== undefined) ? f.capture_watch_enabled : false,
    capture_watch_path: f.capture_watch_path || '',
    capture_min_chars: (f.capture_min_chars !== undefined) ? f.capture_min_chars : 20,
    capture_keywords: f.capture_keywords || '',
    capture_max_per_call: (f.capture_max_per_call !== undefined) ? f.capture_max_per_call : 20,
    fact_types: Array.isArray(f.fact_types) ? f.fact_types : ['preference', 'decision', 'convention', 'project_fact', 'anti_pattern', 'person', 'tooling', 'temporal'],
    auto_filter: (f.auto_filter !== undefined) ? f.auto_filter : false,
    fact_confidence_threshold: (f.fact_confidence_threshold !== undefined) ? f.fact_confidence_threshold : 0.5,
    reconcile_enabled: (f.reconcile_enabled !== undefined) ? f.reconcile_enabled : true,
    kg_enabled: (f.kg_enabled !== undefined) ? f.kg_enabled : false,
    kg_max_entities: (f.kg_max_entities !== undefined) ? f.kg_max_entities : 30,
    kg_synonyms: (f.kg_synonyms && typeof f.kg_synonyms === 'object') ? f.kg_synonyms : {},
    kg_model: f.kg_model || f.llm_model || 'minicpm5-1b',
    kg_url: f.kg_url || '',
    kg_api_key: f.kg_api_key || '',
    // ---- v1.5.0 ----
    entity_link_boost: (f.entity_link_boost !== undefined) ? Number(f.entity_link_boost) : 0.15,
    session_ttl_hours: (f.session_ttl_hours !== undefined) ? Number(f.session_ttl_hours) : 0,
    source_trust_enabled: (f.source_trust_enabled !== undefined) ? f.source_trust_enabled : true,
    source_trust_weights: (f.source_trust_weights && typeof f.source_trust_weights === 'object') ? f.source_trust_weights : { human: 1.0, agent: 0.85, tool: 0.7, system: 0.6 },
    preserve_on_conflict: (f.preserve_on_conflict !== undefined) ? f.preserve_on_conflict : false,
    salience_enabled: (f.salience_enabled !== undefined) ? f.salience_enabled : true,
    related_projects_enabled: (f.related_projects_enabled !== undefined) ? f.related_projects_enabled : true,
    // ---- v1.8.0: 用户纠正学习（B1）自动检测开关（默认关闭，显式 correct_memory 工具始终可用）----
    correction_auto_detect: (f.correction_auto_detect !== undefined) ? f.correction_auto_detect : false,
    // ---- v1.11.0: 抽取模型版本（v1=旧管线不产 mem_category；v2=带 Mem0 式高层语义类别 fact/preference/opinion/event/procedure/skill）----
    extract_version: f.extract_version || 'v2',
    // v1.11.0: 短时工作记忆（tier=working）自动过期小时数（0=不过期，仅按调用方设 expires_at 控制），默认 24
    working_ttl_hours: (f.working_ttl_hours !== undefined) ? Number(f.working_ttl_hours) : 24,
    // ---- v1.12.0 (gap④): Webhooks 事件推送 ----
    webhook_enabled: (f.webhook_enabled !== undefined) ? f.webhook_enabled : false,
    webhook_urls: Array.isArray(f.webhook_urls) ? f.webhook_urls : [],
    webhook_timeout_ms: (f.webhook_timeout_ms !== undefined) ? Number(f.webhook_timeout_ms) : 5000,
    webhook_secret: f.webhook_secret || '', // v1.14.0: webhook HMAC 签名密钥（在 example 中存在但未消费，现加以备后用）
    // ---- v1.13.0: 检索增强 + 生命周期 + 认证 ----
    // v1.13.0 gap①: MMR 多样性重排（λ：0=纯语义，1=纯多样性，默认 0.3）
    mmr_lambda: (f.mmr_lambda !== undefined) ? Number(f.mmr_lambda) : 0.3,
    mmr_enabled: (f.mmr_enabled !== undefined) ? f.mmr_enabled : false,
    // v1.13.0 gap②: 可插拔 reranker 管线
    reranker_url: (f.reranker_url !== undefined) ? f.reranker_url : '',
    reranker_model: f.reranker_model || '',
    reranker_api_key: f.reranker_api_key || '',
    // v1.13.0: API 认证（简单 Bearer token 认证，空数组=不启用）
    api_keys: Array.isArray(f.api_keys) ? f.api_keys : [],
    // v1.13.0 gap③: 自动压缩（capture 后自动触发 consolidate）
    auto_compress: (f.auto_compress !== undefined) ? f.auto_compress : false,
    // v1.13.0 gap⑤: 备份路径
    backup_path: f.backup_path || process.env.BACKUP_PATH || (ROOT || '') + '/backups',
    // v1.14.0: Docker 环境变量覆盖——以下字段在无 config.json 时可纯靠 env 配置
    llm_model: f.llm_model || process.env.LLM_MODEL || 'minicpm5-1b',
    webhook_urls: Array.isArray(f.webhook_urls) ? f.webhook_urls : (process.env.WEBHOOK_URLS ? process.env.WEBHOOK_URLS.split(',').map(s => s.trim()).filter(Boolean) : []),
    api_keys: Array.isArray(f.api_keys) ? f.api_keys : (process.env.API_KEYS ? process.env.API_KEYS.split(',').map(s => s.trim()).filter(Boolean) : []),
    mmr_enabled: (f.mmr_enabled !== undefined) ? f.mmr_enabled : (process.env.MMR_ENABLED === 'true'),
    auto_compress: (f.auto_compress !== undefined) ? f.auto_compress : (process.env.AUTO_COMPRESS === 'true'),
    webhook_enabled: (f.webhook_enabled !== undefined) ? f.webhook_enabled : (process.env.WEBHOOK_ENABLED === 'true'),
    kg_enabled: (f.kg_enabled !== undefined) ? f.kg_enabled : (process.env.KG_ENABLED === 'true'),
    llm_enabled: (f.llm_enabled !== undefined) ? f.llm_enabled : (process.env.LLM_ENABLED === 'true'),
    extract_version: f.extract_version || process.env.EXTRACT_VERSION || 'v2',
    working_ttl_hours: (f.working_ttl_hours !== undefined) ? Number(f.working_ttl_hours) : (process.env.WORKING_TTL_HOURS ? Number(process.env.WORKING_TTL_HOURS) : 24),
    // v1.17.0: MCP 传输与安全
    // MCP 端点允许的 Origin 白名单（同源/DNS-rebinding 防护）。['*'] 表示反射请求方 Origin（宽松，兼容无 Origin 头的非浏览器客户端）；
    // 配置为具体域名数组时，仅放行匹配来源，其余拒绝。留空视为 ['*']。
    mcp_allowed_origins: Array.isArray(f.mcp_allowed_origins) ? f.mcp_allowed_origins : (process.env.MCP_ALLOWED_ORIGINS ? process.env.MCP_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : ['*']),
    // v1.17.0: 后台异步扫描（矛盾检测/健康/到期）间隔（分钟），0 表示关闭。
    scheduler_interval_min: (f.scheduler_interval_min !== undefined) ? Number(f.scheduler_interval_min) : 30,
    // v1.17.0: 记忆老化/二级存储（冷记忆归档）。archive_enabled=true 时 archive 工具才会真正移动，否则仅 dry-run 报告候选。
    archive_enabled: (f.archive_enabled !== undefined) ? !!f.archive_enabled : false,
    archive_idle_days: (f.archive_idle_days !== undefined) ? Number(f.archive_idle_days) : 90, // 超过此天数无访问视为冷记忆
    archive_min_access: (f.archive_min_access !== undefined) ? Number(f.archive_min_access) : 1, // 访问次数低于此值且空闲视为冷记忆
    // v1.18.0 (#4): 请求队列并发度控制——单 GPU=1，多 GPU=N
    embedding_max_concurrent: (f.embedding_max_concurrent !== undefined) ? Number(f.embedding_max_concurrent) : 1,
    llm_max_concurrent: (f.llm_max_concurrent !== undefined) ? Number(f.llm_max_concurrent) : 1,
    embedding_batch_window_ms: (f.embedding_batch_window_ms !== undefined) ? Number(f.embedding_batch_window_ms) : 50,
    queue_max_size: (f.queue_max_size !== undefined) ? Number(f.queue_max_size) : 100,
    // v1.19.0: 虚假完成自动检测——扫描 promise/impl-done/completed 记忆并验证
    verify_enabled: (f.verify_enabled !== undefined) ? !!f.verify_enabled : true,
    verify_base_url: f.verify_base_url || 'http://127.0.0.1:' + (process.env.PORT || 8765),
    // v1.20.0 (#2): SSRF 防护——拒绝出站请求打到内网 IP（webhook/reranker 等用户可配的 URL）
    ssrf_protection: (f.ssrf_protection !== undefined) ? !!f.ssrf_protection : true,
    ssrf_allowlist: Array.isArray(f.ssrf_allowlist) ? f.ssrf_allowlist : ['127.0.0.1', 'localhost'],
    // v1.20.0 (#3): 记忆质量自动化——过期事实检测/矛盾主动修复/置信度衰减
    quality_auto_enabled: (f.quality_auto_enabled !== undefined) ? !!f.quality_auto_enabled : true,
    stale_fact_days: (f.stale_fact_days !== undefined) ? Number(f.stale_fact_days) : 180,
    confidence_decay_days: (f.confidence_decay_days !== undefined) ? Number(f.confidence_decay_days) : 90,
    confidence_decay_rate: (f.confidence_decay_rate !== undefined) ? Number(f.confidence_decay_rate) : 0.05,
    // v1.20.0 (#4b): 搜索结果 LRU 缓存
    search_cache_enabled: (f.search_cache_enabled !== undefined) ? !!f.search_cache_enabled : true,
    search_cache_ttl_ms: (f.search_cache_ttl_ms !== undefined) ? Number(f.search_cache_ttl_ms) : 60000,
    search_cache_max: (f.search_cache_max !== undefined) ? Number(f.search_cache_max) : 200,
    // v1.20.0 (#6): 记忆关联推荐
    suggest_related: (f.suggest_related !== undefined) ? !!f.suggest_related : true,
    suggest_related_limit: (f.suggest_related_limit !== undefined) ? Number(f.suggest_related_limit) : 5,
    // v1.21.0: salience 评分权重（原来硬编码，现可配置）
    salience_w_imp: (f.salience_w_imp !== undefined) ? Number(f.salience_w_imp) : 0.5,
    salience_w_acc: (f.salience_w_acc !== undefined) ? Number(f.salience_w_acc) : 0.5,
    salience_access_k: (f.salience_access_k !== undefined) ? Number(f.salience_access_k) : 10,
    // v1.22.0: 审计日志开关——控制变更账本 memory_changelog 是否写入（关闭后不记任何操作）
    audit_enabled: (f.audit_enabled !== undefined) ? !!f.audit_enabled : true,
    salience_score_w: (f.salience_score_w !== undefined) ? Number(f.salience_score_w) : 0.7,
    // v1.22.0 (P1-3): 全局请求限流（固定窗口 / 按客户端 IP / 内存态，防御失控洪水）。
    // 0 或负数=关闭；默认 300 次/分钟/客户端——宽松到不影响正常多智能体并发，但能挡住持续洪水。
    rate_limit_max: (f.rate_limit_max !== undefined) ? Number(f.rate_limit_max) : (process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : 300),
    rate_limit_window_ms: (f.rate_limit_window_ms !== undefined) ? Number(f.rate_limit_window_ms) : (process.env.RATE_LIMIT_WINDOW_MS ? Number(process.env.RATE_LIMIT_WINDOW_MS) : 60000),
    // v1.21.0: 定时备份
    auto_backup_interval_hours: (f.auto_backup_interval_hours !== undefined) ? Number(f.auto_backup_interval_hours) : 0,
    // v1.22.1 (#139): 过期记忆自动清理开关（scheduler 周期运行）
    auto_cleanup_enabled: (f.auto_cleanup_enabled !== undefined) ? !!f.auto_cleanup_enabled : true,
  };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
// v1.13.x: 配置热更新——重新从文件加载，使非 systemd 部署（如 Windows 直接 node）改配置后即时生效。
function reload() {
  CONFIG = loadConfig();
}
let CONFIG = loadConfig();

// 全模块共享的错误计数（替代散落在各文件的单体 catch(e){}，每处失败都记一笔）
const errStats = { embed: 0, fts: 0, kg: 0, webhook: 0, bump: 0, changelog: 0, cleanup: 0, capture: 0, backup: 0, config: 0, other: 0 };

module.exports = {
  ROOT, CONFIG_PATH, PORT, loadConfig, saveConfig, reload, errStats,
  SERVER_VERSION, SALIENCE_W_IMP, SALIENCE_W_ACC, SALIENCE_ACCESS_K, SALIENCE_SCORE_W,
  // 用 getter 暴露可变单例，避免解构后拿到陈旧引用
  get CONFIG() { return CONFIG; },
  get qdrantUrl() { return CONFIG.qdrant_url; },
  get qdrantCollection() { return CONFIG.qdrant_collection; },
};
