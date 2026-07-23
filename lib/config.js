const fs = require('fs');
const path = require('path');
const { Client } = require('@elastic/elasticsearch');

// 项目根目录（server.js 位于 /opt/ai-memory，本文件位于 /opt/ai-memory/lib，故上溯一级）
const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// HTTP 监听端口（与 128 部署的 :8765 一致）
const PORT = process.env.PORT || 8765;

// v1.9.0: 单一版本常量，Server.version / health / DOCS 全部引用它，避免硬编码漂移
const SERVER_VERSION = '1.9.0';
// v1.6.0: salience 评分权重（显性的「衰减+强化」综合分，夹 [0,1]）
const SALIENCE_W_IMP = 0.5, SALIENCE_W_ACC = 0.5, SALIENCE_ACCESS_K = 10, SALIENCE_SCORE_W = 0.7;

// ---- Config (persisted to config.json, env as fallback) ----
function loadConfig() {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  return {
    es_url: (f.es_url !== undefined) ? f.es_url : (process.env.ES_URL || 'http://192.168.110.248:9200'),
    es_user: f.es_user || process.env.ES_USER || 'elastic',
    es_pwd: (f.es_pwd !== undefined) ? f.es_pwd : (process.env.ES_PWD || ''),
    es_index: f.es_index || process.env.ES_INDEX || 'ai_memories',
    // v1.9.0: Qdrant 向量主存储（替代 Elasticsearch）。留空则降级 SQLite。
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
    embedding_timeout_ms: (f.embedding_timeout_ms !== undefined) ? Number(f.embedding_timeout_ms) : 30000,
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
  };
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let CONFIG = loadConfig();
let client = null;
function rebuildClient() {
  client = CONFIG.es_url ? new Client({ node: CONFIG.es_url, auth: { username: CONFIG.es_user, password: CONFIG.es_pwd } }) : null;
}
rebuildClient();

module.exports = {
  ROOT, CONFIG_PATH, PORT, loadConfig, saveConfig, rebuildClient,
  SERVER_VERSION, SALIENCE_W_IMP, SALIENCE_W_ACC, SALIENCE_ACCESS_K, SALIENCE_SCORE_W,
  // 用 getter 暴露可变单例，避免解构后拿到陈旧引用（client 在 rebuildClient 时会被重赋值）
  get CONFIG() { return CONFIG; },
  get client() { return client; },
  get qdrantUrl() { return CONFIG.qdrant_url; },
  get qdrantCollection() { return CONFIG.qdrant_collection; },
};
