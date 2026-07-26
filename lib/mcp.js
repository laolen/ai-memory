// MCP 接入层：工具 schema(TOOLS) + createServer（每 SSE 连接一个实例）。
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const config = require('./config');
const errC = config.errStats;
const backend = require('./backend');
const memory = require('./memory');
const correction = require('./correction');
const projects = require('./projects');
const graph = require('./graph');
const capture = require('./capture');
const webhook = require('./webhook');
const util = require('./util');
const context = require('./context');   // v1.16.0 上下文/摘要层（#87/#88/#92/#96）
const maintain = require('./maintain'); // v1.16.0 健康/维护/矛盾检测（#89/#90/#91）
const review = require('./review');     // v1.16.0 间隔召回（#95）
const watch = require('./watch');       // v1.16.0 标签订阅（#94）
const prompts = require('./prompts');   // v1.17.0 Prompts 原语（#97）
const scheduler = require('./scheduler'); // v1.17.0 后台异步扫描（#102）
const archive = require('./archive');  // v1.17.0 冷记忆归档（#106）
const quality = require('./quality');  // v1.17.0 指标（#104）
const backup = require('./backup');    // v1.18.0 备份（#8）
const embed = require('./embed');      // v1.17.0 嵌入缓存（#101）
const bus = require('./bus');          // v1.17.0 事件总线（#98）
const verify = require('./verify');    // v1.19.0 虚假完成检测闭环

// ---- MCP tool schema ----
const TOOLS = [
  { name: 'add_memory', zh: '将一条记忆（文本）存入 AI 记忆库。当 dedup_enabled 开启（默认）且有向量嵌入时，若新记忆与已有记忆高度相似（cosine ≥ dedup_threshold，默认 0.92）则合并而非新建；传 merge:false 可强制新建。', description: 'Store a memory (text) into the AI memory store. When dedup_enabled is on (default) and a vector embedding is available, an incoming memory whose content is highly similar to an existing one (cosine >= dedup_threshold, default 0.92) is merged into that memory instead of creating a duplicate. Pass merge:false to force a new entry.',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' },
      session: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      category: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], description: '记忆分类：semantic=持久事实/偏好，episodic=特定情境下的事件/决定，procedural=操作流程/沟通风格。默认 semantic。v1.5.0 新增。' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '记忆类型（v1.6.0 新增）：user=关于用户本人的持久事实/偏好（用户画像类），agent=Agent 自身的运行记忆/习得，session=仅当前会话相关、会话结束后价值衰减的临时记忆。默认 user。' },
      merge: { type: 'boolean', zh: '允许与高度相似的已有记忆合并。默认跟随全局 dedup_enabled 配置；设为 false 则总是新建。', description: 'Allow merging with a highly similar existing memory. Default: follows global dedup_enabled config. Set false to always create a new entry.' },
      mem_category: { type: 'string', enum: ['fact', 'preference', 'opinion', 'event', 'procedure', 'skill'], description: 'v1.11.0 Mem0 式高层语义类别：fact=客观事实/数据/配置, preference=用户偏好/喜好/习惯, opinion=观点/主观评价, event=具体事件, procedure=操作步骤/SOP, skill=某人会做某事的能力。' },
      tier: { type: 'string', enum: ['long', 'working'], description: 'v1.11.0 记忆分层：long=长期(默认), working=短时工作记忆缓冲(独立存储、不污染长期库、按 working_ttl_hours 过期、可 promote)。' },
      org: { type: 'string', description: 'v1.11.0 组织作用域（可选，用于组织级共享知识池隔离）。' },
      extract_version: { type: 'string', enum: ['v1', 'v2'], description: 'v1.11.0 抽取模型版本：v2(默认)会产出 mem_category 高层语义类别。' },
      extract_instructions: { type: 'string', description: 'v1.11.0 per-call 抽取引导：自然语言指令，控制「记什么/不记什么」（如"只记技术栈相关的事实"）。' },
      source: { type: 'object', zh: '可选溯源信息，例如 {type:"doc", ref:"docs/order.md", conversation_id:"...", message_id:"...", url:"https://...", file:"src/a.ts", line:42}。type 可填 human/agent/tool/system 以参与来源信任加权；系统自动补 captured_at（捕获时间）与 trigger（add/capture）。在管理界面可点击「溯源」查看完整来源与内容演变。', description: 'Optional provenance / 溯源, 例如 {type:"doc", ref:"docs/order.md", conversation_id:"...", message_id:"...", url:"https://...", file:"src/a.ts", line:42}。type 可填 human/agent/tool/system 以参与来源信任加权;系统会自动补 captured_at(捕获时间)与 trigger(add/capture)。在 admin 界面可点击「溯源」查看完整来源与内容演变。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：行为主体标识（人/系统/角色）。可选，用于按 actor 过滤检索与隔离。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：产生该记忆的 Agent 标识。可选。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：产生该记忆的运行/会话实例标识。可选。' },
      custom_categories: { type: 'array', items: { type: 'string' }, description: 'v1.12.0 (gap①) 自定义类别体系（string[]），覆盖/补充默认 mem_category 枚举；项目级持久配置优先，逐调用次之。' } },
      required: ['content', 'user'] } },
  { name: 'search_memories', zh: '搜索记忆。mode：keyword(BM25)、semantic(kNN)、hybrid(RRF)。开启 recency_enabled 时结果按时间衰减加权（越新越前），衰减基准为每条记忆的最后访问/强化时间（last_accessed_at），回退 updated_at，使频繁召回的记忆保持新鲜、长期未用的衰减（人脑记忆模型）。开启 salience_enabled 时还受显著性评分（重要性+访问强化）调节。可用 from/to（ISO 时间或 YYYY-MM-DD）限定 updated_at 时间窗。memory_type 按 user/agent/session 过滤。', description: 'Search memories. mode: keyword (BM25), semantic (kNN), hybrid (RRF). Results are recency-decay weighted (recent first) when recency_enabled — decay basis is each memory\'s last access/reinforcement time (last_accessed_at), falling back to updated_at, so frequently-recalled memories stay fresh and long-unused ones decay (human-memory model). Also modulated by a salience score (importance + access reinforcement) when salience_enabled. Use from/to (ISO date/time or YYYY-MM-DD) to limit to a time window by updated_at. memory_type filters by user/agent/session.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], default: 'keyword' }, top_k: { type: 'number', default: 5 },
      from: { type: 'string', zh: 'updated_at 的下界（ISO 时间或 YYYY-MM-DD）。', description: 'Lower bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      to: { type: 'string', zh: 'updated_at 的上界（ISO 时间或 YYYY-MM-DD）。', description: 'Upper bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      category: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], description: '按记忆分类过滤（v1.5.0 新增）。' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '按记忆类型过滤（v1.6.0 新增）。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 按行为主体 actor 过滤。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 按产生记忆的 Agent 过滤。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 按运行/会话实例过滤。' },
      criteria: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, weight: { type: 'number' } }, description: 'v1.12.0 (gap③) 准则加权检索：[{text,weight}]，按每条准则的语义相似度对候选加权融合重排（weight 越大越优先）。未显式传时回退项目级配置默认 criteria。' } } },
      required: ['query'] } },
  { name: 'list_memories', zh: '列出近期记忆，开启 recency_enabled 时按时间衰减加权。from/to 限定 updated_at 时间窗。', description: 'List recent memories, recency-weighted when recency_enabled. from/to limit to a time window by updated_at.',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' }, limit: { type: 'number', default: 20 },
      from: { type: 'string', zh: 'updated_at 的下界（ISO 时间或 YYYY-MM-DD）。', description: 'Lower bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      to: { type: 'string', zh: 'updated_at 的上界（ISO 时间或 YYYY-MM-DD）。', description: 'Upper bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '按记忆类型过滤（v1.6.0 新增）。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 按行为主体 actor 过滤。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 按产生记忆的 Agent 过滤。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 按运行/会话实例过滤。' } } } },
  { name: 'delete_memory', zh: '按 id 删除一条记忆。', description: 'Delete a memory by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'purge_memories', zh: '生命周期清理：在可选 user/project/session 范围内删除早于 N 天（按 updated_at）的记忆。expired_only=true 时用配置的 expiry_days，否则用 days 参数。两者皆未设置则不做任何事。', description: 'Lifecycle cleanup: delete memories older than N days (by updated_at) within an optional user/project/session scope. If expired_only is true, uses configured expiry_days; otherwise the days argument is used. Nothing happens if neither is set.',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      days: { type: 'number', zh: '删除早于该天数的记忆。', description: 'Delete memories older than this many days.' },
      expired_only: { type: 'boolean', zh: '若为 true，使用配置的 expiry_days 而非 days 参数。', description: 'If true, use configured expiry_days instead of the days argument.' } },
      required: [] } },
  { name: 'capture_memory', zh: '从原始对话文本或笔记自动捕获记忆。若配置了 LLM(llm_url)，文本会被智能抽取为结构化记忆项（content+tags+importance）后入库；否则启发式回退为按句切分并去重入库。所有捕获项打 auto-captured 标签。', description: 'Auto-capture memories from raw conversation text or notes. If an LLM (llm_url) is configured, the text is intelligently extracted into structured memory items (content+tags+importance) before storage; otherwise a heuristic fallback splits into sentences and stores novel chunks with dedup applied. All captured items are tagged auto-captured.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', zh: '要捕获的原始对话文本、笔记或转录内容。', description: 'Raw conversation text, notes, or transcript to capture from.' },
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      source: { type: 'object', description: 'Optional provenance / 溯源, 例如 {type:"doc", ref:"...", conversation_id:"...", url:"https://...", file:"src/a.ts", line:42}。系统自动补 captured_at 与 trigger=capture;admin 界面可点击「溯源」查看完整来源。' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '记忆类型（v1.6.0 新增）：user=关于用户本人的持久事实/偏好，agent=Agent 自身运行记忆，session=仅当前会话相关的临时记忆。默认 user。' },
      extract_instructions: { type: 'string', description: 'v1.11.0 per-call 抽取引导：控制「记什么/不记什么」的自然语言指令。' },
      org: { type: 'string', description: 'v1.11.0 组织作用域。' },
      tier: { type: 'string', enum: ['long', 'working'], description: 'v1.11.0 记忆分层：working=短时工作记忆缓冲。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：行为主体标识，随抽取结果落到记忆。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：产生记忆的 Agent 标识。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：运行/会话实例标识。' },
      custom_categories: { type: 'array', items: { type: 'string' }, description: 'v1.12.0 (gap①) 自定义类别体系（string[]），覆盖/补充默认 mem_category 枚举；项目级持久配置优先，逐调用次之。' } },
      required: ['text'] } },
  { name: 'manage_project_link', description: 'v1.7.0: 管理项目间的强弱关联。action=add/update 建立或修改从 from_project 到 to_project 的关联(强度 strength 0~1：1=强/0.6=中/0.3=弱)；action=remove 删除；action=list 列出全部。建立关联后,检索/列出某项目记忆时会同时借鉴其关联项目的记忆(按强度衰减排序),在"当前项目记忆"与"可借鉴的关联项目记忆"间建立桥梁。',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['add', 'update', 'remove', 'list'], description: 'add/update 建立或修改关联；remove 删除；list 列出全部。' },
      from_project: { type: 'string', description: '源项目名(关联起点)' },
      to_project: { type: 'string', description: '目标项目名(关联终点；双向生效)' },
      strength: { type: 'number', description: '关联强度 0~1：1=强、0.6=中、0.3=弱。默认 0.6。' },
      note: { type: 'string', description: '可选备注(如"同属支付域")' } },
      required: ['action'] } },
  { name: 'related_to', zh: '知识图谱：给定实体（人/项目/系统/...），返回通过关系与其相连的全部实体（含关系类型与出现次数），跨所有记忆，并附来源记忆。用 type 按关系过滤（如 responsible_for）。需 kg_enabled + 已抽取图谱数据。', description: 'Knowledge-graph: given an entity (person/project/system/...), return the entities connected to it via relations (with relation type and occurrence count) across all memories, plus the source memories. Use type to filter by relation (e.g. responsible_for). Requires kg_enabled + extracted graph data.',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string', zh: '实体名（接受别名，经 kg_synonyms 归一化）。', description: 'Entity name (alias accepted, normalized via kg_synonyms).' },
      type: { type: 'string', zh: '可选关系类型过滤，如 responsible_for / uses / depends_on。', description: 'Optional relation type filter, e.g. responsible_for / uses / depends_on.' },
      limit: { type: 'number', default: 20 } },
      required: ['entity'] } },
  { name: 'graph_query', zh: '知识图谱：返回提及该实体的所有记忆的原始实体与关系。用于构建/可视化子图。需 kg_enabled。', description: 'Knowledge-graph: return the raw entities and relations of all memories mentioning the given entity. Use it to build/visualize a subgraph. Requires kg_enabled.',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string' }, limit: { type: 'number', default: 50 } },
      required: ['entity'] } },
  { name: 'path_between', zh: '知识图谱：在两实体间寻找关系路径（基于抽取关系的 BFS）。不连通则返回空路径。需 kg_enabled。', description: 'Knowledge-graph: find a relation path between two entities across memories (BFS over extracted relations). Returns null path if not connected. Requires kg_enabled.',
    inputSchema: { type: 'object', properties: {
      a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'] } },
  { name: 'correct_memory', description: 'v1.8.0 B1 用户纠正学习：把用户纠正反馈(如"不对，应该是 X")应用到最相关的一条记忆——更新其内容、标记 corrected_at、提升 confidence 至 0.9、correction_count+1 并保留历史演变。可选 target_id 直接指定要纠正的记忆；否则按 feedback 语义检索最相关记忆。',
    inputSchema: { type: 'object', properties: {
      feedback: { type: 'string', description: '用户的纠正文本，例如"不对，订单系统的主库其实是 TiDB 不是 PostgreSQL"' },
      target_id: { type: 'string', description: '可选：直接指定要纠正的记忆 id' },
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' } },
      required: ['feedback'] } },
  { name: 'batch_add_memories', description: 'v1.11.0 批量新增记忆：items 为记忆对象数组（每个含 content,user 及可选 project/session/tags/tier/org/mem_category/merge 等）。逐条走与 add_memory 相同的去重/落库逻辑。返回 {added,results}。',
    inputSchema: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', description: '单条记忆：{content,user,project?,session?,tags?,tier?,org?,mem_category?,merge?}' } },
      org: { type: 'string', description: '可选：为所有 items 统一设置组织作用域。' },
      tier: { type: 'string', enum: ['long', 'working'], description: '可选：为所有 items 统一设置分层。' } },
      required: ['items'] } },
  { name: 'delete_memories_by_filter', description: 'v1.11.0 按通用过滤器批量删除：filters 为嵌套 DSL（{all:[...]}|{any:[...]}|{not:cond}|叶子{key,op,value}，op∈eq,ne,gt,gte,lt,lte,contains,in,exists,between）。scope 可选 {user,project,session}。返回 {deleted,ids}。',
    inputSchema: { type: 'object', properties: {
      filters: { type: 'object', description: '嵌套过滤 DSL，例如 {"all":[{"key":"mem_category","op":"eq","value":"preference"},{"key":"project","op":"eq","value":"x"}]}' },
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' } },
      required: ['filters'] } },
  { name: 'reextract_memory', description: 'v1.11.0 重新抽取：对某条已有记忆用新文本重新抽取事实并更新（content/type/category/mem_category/实体）。',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: '要重新抽取的记忆 id' },
      text: { type: 'string', description: '新的原文文本' },
      extract_instructions: { type: 'string', description: '可选抽取引导' } },
      required: ['id', 'text'] } },
  { name: 'kv_get', description: 'v1.11.0 KV 精确匹配通道：读取一个精确键的值（flag/配置/短字段）。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, org: { type: 'string' } }, required: ['key'] } },
  { name: 'kv_set', description: 'v1.11.0 KV 精确匹配通道：写入一个精确键值对（确定性精确查，与语义检索解耦）。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, org: { type: 'string' } }, required: ['key', 'value'] } },
  { name: 'kv_delete', description: 'v1.11.0 KV 精确匹配通道：删除一个精确键。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, org: { type: 'string' } }, required: ['key'] } },
  { name: 'add_working_memory', description: 'v1.11.0 写入短时工作记忆：独立于长期库的会话期易逝缓冲，默认按 working_ttl_hours 过期、不污染长期检索。',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' }, org: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['content'] } },
  { name: 'promote_working_memory', description: 'v1.11.0 把短时工作记忆提升为长期记忆：promote 到主存储，原 working 条目删除。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'working 记忆 id' }, org: { type: 'string' } }, required: ['id'] } },
  { name: 'set_project_config', description: 'v1.12.0 (gap①) 设置项目级持久配置：custom_categories(自定义类别体系 string[])/extract_instructions(持久抽取指令)/criteria(检索加权准则 [{text,weight}])/webhook_urls(项目级事件推送端点 string[])。合并更新（只传改动的字段）。',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: '项目名（持久配置的作用域键）。' },
      custom_categories: { type: 'array', items: { type: 'string' }, description: '自定义类别体系（覆盖/补充默认 mem_category 枚举）。' },
      extract_instructions: { type: 'string', description: '项目级持久抽取指令（自然语言），与逐调用指令拼接（逐调用优先）。' },
      criteria: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, weight: { type: 'number' } } }, description: '检索加权准则 [{text,weight}]，作为该项目检索的默认 criteria。' },
      webhook_urls: { type: 'array', items: { type: 'string' }, description: '项目级 webhook 推送端点（与全局 webhook_urls 合并去重）。' } },
      required: ['project'] } },
  { name: 'get_project_config', description: 'v1.12.0 (gap①) 读取项目级持久配置；不传 project 则返回全部项目的配置列表。',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: '项目名；省略则列出所有项目配置。' } } } },
  { name: 'get_webhook_recent', description: 'v1.12.0 (gap④) 诊断用：返回 webhook 最近投递记录（环形缓冲 50 条）与启用状态。事件：memory.added/updated/deleted/promoted/consolidated；目标 = 全局 webhook_urls + 项目级 webhook_urls 合并去重，失败自动重试 1 次。',
    inputSchema: { type: 'object', properties: {} } },
  // ---- v1.13.0 tools ----
  { name: 'pin_memory', description: 'v1.13.0 固定一条记忆，免除过期/衰减/清理。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '记忆 id' } }, required: ['id'] } },
  { name: 'unpin_memory', description: 'v1.13.0 解固一条记忆，恢复正常生命周期。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '记忆 id' } }, required: ['id'] } },
  { name: 'export_memories', description: 'v1.13.0 导出记忆为 JSON 数组（备份/迁移用）。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, user: { type: 'string' }, limit: { type: 'number', description: '最大导出条数，默认 10000' } } } },
  { name: 'import_memories', description: 'v1.13.0 导入记忆 JSON（从 export_memories 导出的数据恢复）。',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' }, description: '记忆对象数组（含 content/user/project/tags 等字段）' } }, required: ['items'] } },
  { name: 'reset_memories', description: 'v1.13.0 重置全部记忆：清空所有记忆/KG/工作记忆/KV。需传 confirm=true 以防误操作。',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean', description: '必须传 true 才能执行重置' } }, required: ['confirm'] } },
  { name: 'backup_memories', description: 'v1.13.0 备份记忆到服务端文件（JSON 格式，路径由 backup_path 配置决定）。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, user: { type: 'string' } } } },
  { name: 'get_memory_stats', description: 'v1.13.0 记忆统计：总量/固定数/过期数/按类别分布。',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } } },
  { name: 'infer_memory', description: 'v1.15.0 深度分析单条记忆，提取事实/推断/待澄清问题并追加到 history。',
    inputSchema: { type: 'object', properties: { memory_id: { type: 'string', description: '需要分析的记忆 ID' } }, required: ['memory_id'] } },
  { name: 'conclude_session', description: 'v1.15.0 结束会话：把当前会话的所有工作记忆 promote 到长期库，并 LLM 总结后存入。',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: '会话标识' }, user: { type: 'string' }, project: { type: 'string' } }, required: ['session'] } },
  // ---- v1.16.0 tools ----
  { name: 'recall_for_context', zh: 'v1.16.0 上下文主动召回：传入最近的对话消息（string[] 或 {role,content}[]），系统提炼查询并检索最相关的长期记忆，供 Agent 在回答前"主动想起"相关背景。有嵌入服务走语义检索，否则/失败自动回退关键词。', description: 'v1.16.0 Proactive context recall: pass recent conversation messages (string[] or {role,content}[]); the server distills a query and retrieves the most relevant long-term memories so the agent can proactively recall context before answering. Uses semantic search when embeddings are available, otherwise falls back to keyword.',
    inputSchema: { type: 'object', properties: {
      messages: { type: 'array', items: {}, description: '最近对话消息：字符串数组或 {role,content} 对象数组。' },
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      top_k: { type: 'number', default: 5 }, window: { type: 'number', description: '取最近多少条消息拼接为查询，默认 6。' },
      mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], description: '检索模式，默认按是否有嵌入服务自动选择。' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'] }, include_related: { type: 'boolean' } },
      required: ['messages'] } },
  { name: 'resume_state', zh: 'v1.16.0 启动自动续接：拉取某项目近期记忆（含工作记忆），有 LLM 时生成"上次进行到哪里/待继续线索"的续接摘要，否则回退近期条目清单。适合新会话开场恢复上下文。', description: 'v1.16.0 Resume state on startup: pull a project\'s recent memories (incl. working memory); with an LLM it produces a "where we left off / open threads" summary, otherwise returns a recent-items list. Ideal for restoring context at the start of a new session.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, user: { type: 'string' }, session: { type: 'string' }, limit: { type: 'number', default: 15 } } } },
  { name: 'detect_contradictions', zh: 'v1.16.0 矛盾检测：给定候选内容，找出语义相近的已有记忆并（有 LLM 时）判定是否存在事实冲突。只读、不写入。返回 has_conflict/needs_clarification 与冲突明细。也可在 add_memory 时传 check_contradictions:true 于写入前自动检测。', description: 'v1.16.0 Contradiction detection: given candidate content, find semantically similar existing memories and (with an LLM) judge whether they factually conflict. Read-only, does not write. Returns has_conflict/needs_clarification and conflict details. add_memory also accepts check_contradictions:true to run this before writing.',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' },
      top_k: { type: 'number', default: 5 }, min_similarity: { type: 'number', description: '相近候选的最低相似度阈值，默认 0.55。' } },
      required: ['content'] } },
  { name: 'memory_health', zh: 'v1.16.0 记忆健康报告：汇总重复冗余、标签聚类、遗忘曲线到期量、卫生度（未打标/低置信），给出 0-100 健康评分与维护建议。可按 project 限定范围。', description: 'v1.16.0 Memory health report: aggregates duplicate redundancy, tag clusters, forgetting-curve due counts, hygiene (untagged/low-confidence) into a 0-100 health score with actionable recommendations. Optionally scoped by project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, dup_threshold: { type: 'number', description: '重复判定相似度阈值，默认跟随 dedup_threshold。' } } } },
  { name: 'prune_memories', zh: 'v1.16.0 批量语义维护——裁剪冗余重复。可选 topic 先把记忆池按语义/关键词收敛到该主题，再在池内找重复对并保留最优、标记其余为待删。默认 dry-run 只返回候选，必须传 confirm:true 才真正删除。', description: 'v1.16.0 Bulk semantic maintenance — prune redundant duplicates. Optional topic first narrows the pool to that topic (semantic/keyword), then finds duplicate pairs, keeps the best and marks the rest for deletion. Dry-run by default (returns candidates only); pass confirm:true to actually delete.',
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string', description: '可选：主题限定（先把记忆收敛到该主题再裁剪）。' },
      project: { type: 'string' }, threshold: { type: 'number', description: '重复判定相似度阈值。' },
      topic_threshold: { type: 'number', description: '主题收敛的语义相似度阈值，默认 0.45。' },
      max: { type: 'number', description: '最多处理的候选数。' },
      confirm: { type: 'boolean', description: '必须传 true 才真正删除；否则 dry-run 只返回候选。' } } } },
  { name: 'merge_memories', zh: 'v1.16.0 合并指定的多条记忆为一条：内容用 LLM 综合（回退去重拼接）、标签取并集，主项（置信度最高/最新）保留并更新，其余删除。', description: 'v1.16.0 Merge several specified memories into one: content synthesized by LLM (fallback: dedup-concatenate), tags unioned; the primary (highest confidence / most recent) is kept and updated, the rest deleted.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: '要合并的记忆 id 数组（至少 2 个）。' } }, required: ['ids'] } },
  { name: 'export_memories_markdown', zh: 'v1.16.0 导出为人类可读 Markdown：按 group_by（project 默认/tag/category/date）分组输出，便于归档、评审或粘贴到文档。', description: 'v1.16.0 Export memories as human-readable Markdown, grouped by group_by (project default / tag / category / date). Handy for archiving, review, or pasting into docs.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, user: { type: 'string' },
      group_by: { type: 'string', enum: ['project', 'tag', 'category', 'date'], default: 'project' },
      limit: { type: 'number', description: '最大导出条数，默认 10000。' } } } },
  { name: 'watch_tag', zh: 'v1.16.0 标签级订阅：为某个标签注册一个 http(s) 回调；当新增记忆带该标签时主动 POST 通知到该 URL。订阅关系持久化。可选 project 限定只推同项目。', description: 'v1.16.0 Tag-level subscription: register an http(s) callback for a tag; when a new memory carries that tag, a notification is POSTed to the URL. Subscriptions are persisted. Optional project scopes notifications to that project.',
    inputSchema: { type: 'object', properties: {
      tag: { type: 'string' }, url: { type: 'string', description: '接收通知的 http(s) 回调地址。' },
      project: { type: 'string', description: '可选：只推送该项目的匹配记忆。' }, note: { type: 'string' } },
      required: ['tag', 'url'] } },
  { name: 'unwatch_tag', zh: 'v1.16.0 取消标签订阅：按 id 精确删除，或按 tag(+可选 url/project)批量删除。', description: 'v1.16.0 Remove tag subscription: by exact id, or by tag (+optional url/project) in bulk.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, tag: { type: 'string' }, url: { type: 'string' }, project: { type: 'string' } } } },
  { name: 'list_watches', zh: 'v1.16.0 列出标签订阅（可按 tag/project 过滤）。', description: 'v1.16.0 List tag subscriptions (optionally filtered by tag/project).',
    inputSchema: { type: 'object', properties: { tag: { type: 'string' }, project: { type: 'string' } } } },
  { name: 'schedule_recall', zh: 'v1.16.0 按需间隔召回：安排"N 天后再想起"某条内容。新增一条记忆并把复习时间设为目标时刻（in_days 优先，其次 in_hours，其次 at 绝对时间，默认 1 天）。打 scheduled-recall 标签。', description: 'v1.16.0 On-demand spaced recall: schedule "remind me of this in N days". Adds a memory and sets its review time to the target (in_days first, then in_hours, then absolute at; default 1 day). Tagged scheduled-recall.',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      in_days: { type: 'number' }, in_hours: { type: 'number' }, at: { type: 'string', description: 'ISO 绝对到期时间（覆盖 in_days/in_hours）。' },
      tags: { type: 'array', items: { type: 'string' } } },
      required: ['content'] } },
  { name: 'due_recalls', zh: 'v1.16.0 取出到期的召回项：返回 next_review_at 已过（到期该复习）的记忆，按到期时间升序。用于会话开场或定时巩固。', description: 'v1.16.0 Fetch due recalls: returns memories whose next_review_at has passed (due for review), sorted by due time ascending. Use at session start or for periodic reinforcement.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, user: { type: 'string' }, session: { type: 'string' }, limit: { type: 'number', default: 50 } } } },
  { name: 'digest', zh: 'v1.16.0 周期摘要：汇总某项目在 period(day|week|month) 内新增/更新的记忆，有 LLM 则生成 summary/highlights/themes，否则回退条目清单。', description: 'v1.16.0 Periodic digest: summarize memories added/updated within period (day|week|month) for a project; with an LLM produces summary/highlights/themes, otherwise returns an item list.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, user: { type: 'string' },
      period: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' }, limit: { type: 'number', default: 200 } } } },
  // ---- v1.17.0 tools ----
  { name: 'scheduler_status', zh: 'v1.17.0 查看后台异步扫描（健康度/到期/矛盾抽样）的最近结果与历史。', description: 'v1.17.0 View the latest and historical results of the background async scanner (health/due/contradiction sampling).',
    inputSchema: { type: 'object', properties: { history: { type: 'boolean', description: '是否一并返回最近历史（默认 false）。' } } } },
  { name: 'create_backup', zh: 'v1.18.0 创建整目录备份（tar.gz 到 backup_path），可加标签。', description: 'v1.18.0 Create a full-directory backup (tar.gz to backup_path). Optionally label it.',
    inputSchema: { type: 'object', properties: { label: { type: 'string', description: '备份标签（如 before-upgrade）。' } } } },
  { name: 'list_backups', zh: 'v1.18.0 列出已创建的备份记录。', description: 'v1.18.0 List all created backup records.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } } },
  { name: 'restore_backup', zh: 'v1.18.0 从备份文件恢复整目录（危险操作！）。', description: 'v1.18.0 Restore the full directory from a backup file (DANGEROUS!).',
    inputSchema: { type: 'object', properties: { filename: { type: 'string', description: '备份文件名（来自 list_backups）' } }, required: ['filename'] } },
  { name: 'list_watch_dead', zh: 'v1.17.0 列出标签订阅推送中最终失败、进入死信队列待重发的通知。', description: 'v1.17.0 List tag-subscription webhook deliveries that ultimately failed and are parked in the dead-letter queue for retry.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'retry_watch_dead', zh: 'v1.17.0 重发死信队列中的全部失败通知（成功即移除）。', description: 'v1.17.0 Retry all failed webhook deliveries in the dead-letter queue (removed on success).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_archived', zh: 'v1.17.0 列出已归档（冷记忆二级存储）的记忆。', description: 'v1.17.0 List archived (cold-memory secondary-store) memories.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } } },
  { name: 'archive_memories', zh: 'v1.17.0 扫描并归档冷记忆（默认 dry_run）。', description: 'v1.17.0 Scan & archive cold memories (dry_run by default); set confirm=true to execute.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, confirm: { type: 'boolean', description: '设为 true 才真正移动归档。' } } } },
  { name: 'restore_archived', zh: 'v1.17.0 从归档恢复一条记忆到主库。', description: 'v1.17.0 Restore an archived memory back into the primary store.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '归档记忆 id（来自 list_archived）' } }, required: ['id'] } },
  { name: 'export_memory_text', zh: 'v1.17.0 导出记忆为人类可读文本，支持格式 markdown(默认)/jsonl/obsidian/cards，按 group_by 分组。', description: 'v1.17.0 Export memories as human-readable text. format ∈ markdown(default)/jsonl/obsidian/cards; grouped by group_by.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string' }, user: { type: 'string' },
      group_by: { type: 'string', enum: ['project', 'tag', 'category', 'date'], default: 'project' },
      format: { type: 'string', enum: ['markdown', 'jsonl', 'obsidian', 'cards'], default: 'markdown' },
      limit: { type: 'number', description: '最大导出条数，默认 10000。' } } } },
  { name: 'run_verification', zh: 'v1.19.0 手动触发一次虚假完成全量检测。', description: 'v1.19.0 Manually trigger a full false-completion verification scan.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_fix_needed', zh: 'v1.19.0 列出所有待修复的虚假完成（fix-needed 标签）。', description: 'v1.19.0 List all pending false-completion fix tasks (tagged fix-needed).',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, limit: { type: 'number', default: 50 } } } },
  { name: 'resolve_fix', zh: 'v1.19.0 AI 修复后调用，标记虚假完成为已修复。', description: 'v1.19.0 Mark a false-completion fix task as resolved after AI has fixed it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'fix-needed 记忆的 id' } }, required: ['id'] } },
  { name: 'list_conflicts', zh: 'v1.20.0 列出所有待修复的记忆矛盾任务（conflict-task 标签），供 AI 轮询发现并处理。', description: 'v1.20.0 List all pending memory conflict tasks (tagged conflict-task) for AI to poll and resolve.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, limit: { type: 'number', default: 50 } } } },
  { name: 'resolve_conflict', zh: 'v1.20.0 AI 处理完矛盾任务后调用，标记为已解决（移除 conflict-task/fix-needed 标签、加 resolved 标签）。', description: 'v1.20.0 Mark a conflict task as resolved after AI has reconciled the contradictory memories.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'conflict-task 记忆的 id' } }, required: ['id'] } },
  { name: 'run_quality_scan', zh: 'v1.20.0 手动触发一次记忆质量扫描（过期检测 + 矛盾修复 + 置信度衰减）。', description: 'v1.20.0 Manually trigger a memory quality scan (stale facts + contradiction repair + confidence decay).',
    inputSchema: { type: 'object', properties: {} } },
];

function createServer() {
  const server = new Server({ name: 'ai-memory', version: config.SERVER_VERSION }, { capabilities: { tools: {}, resources: { listChanged: true }, prompts: {}, logging: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  async function callToolHandler(request) {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'add_memory') {
        const r = await memory.doAdd(args);
        const text = r.merged ? ('Memory merged with ' + r.merged_from + ' (similarity ' + (r.similarity || 0).toFixed(3) + ')') : ('Memory added: ' + r.id);
        return { content: [{ type: 'text', text }] };
      }
      if (name === 'search_memories') { const r = await memory.doSearch(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'list_memories') { const r = await memory.doList(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'delete_memory') { await memory.doDelete(args.id); return { content: [{ type: 'text', text: 'Deleted: ' + args.id }] }; }
      if (name === 'purge_memories') {
        const days = args.expired_only ? config.CONFIG.expiry_days : (args.days != null ? args.days : config.CONFIG.expiry_days);
        if (!(days > 0)) return { content: [{ type: 'text', text: 'Nothing to purge (no expiry_days configured and no days given).' }] };
        const n = await memory.purgeMemories({ user: args.user, project: args.project, session: args.session, days });
        return { content: [{ type: 'text', text: 'Purged ' + n + ' memories older than ' + days + ' days.' }] };
      }
      if (name === 'capture_memory') {
        const r = await capture.captureText(args.text || '', { user: args.user, project: args.project, session: args.session, tags: args.tags, source: args.source, memory_type: args.memory_type, extract_instructions: args.extract_instructions, custom_categories: args.custom_categories, actor_id: args.actor_id, agent_id: args.agent_id, run_id: args.run_id });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'related_to') {
        const r = await graph.relatedTo(args.entity, args.type, args.limit);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'graph_query') {
        const r = await graph.relatedTo(args.entity, null, args.limit);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'path_between') {
        const r = await graph.pathBetween(args.a, args.b);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'manage_project_link') {
        if (args.action === 'list') return { content: [{ type: 'text', text: JSON.stringify(projects.loadProjectLinks(), null, 2) }] };
        if (args.action === 'remove') { projects.removeProjectLink(args.from_project, args.to_project); return { content: [{ type: 'text', text: 'removed' }] }; }
        const ok = projects.upsertProjectLink(args.from_project, args.to_project, args.strength, args.note);
        if (!ok) return { content: [{ type: 'text', text: 'error: from_project / to_project 必填且不能相同' }], isError: true };
        return { content: [{ type: 'text', text: 'ok' }] };
      }
      if (name === 'correct_memory') {
        const r = await correction.doCorrect(args);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'batch_add_memories') {
        const r = await memory.batchAdd((args.items || []).map(it => Object.assign({}, it, { org: it.org || args.org || null, tier: it.tier || args.tier || 'long' })));
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'delete_memories_by_filter') {
        const r = await memory.deleteByFilter(args.filters || null, { user: args.user, project: args.project, session: args.session });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'reextract_memory') {
        const r = await memory.reextractMemory(args.id, args.text || '', { extract_instructions: args.extract_instructions, extract_version: args.extract_version });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'kv_get') { return { content: [{ type: 'text', text: JSON.stringify({ key: args.key, org: args.org || '', value: backend.kvGet(args.key, args.org || '') }, null, 2) }] }; }
      if (name === 'kv_set') { const r = backend.kvSet(args.key, args.value, args.org); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'kv_delete') { const r = backend.kvDelete(args.key, args.org); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'add_working_memory') {
        const r = await memory.addWorking({ content: args.content, user: args.user, project: args.project, session: args.session, org: args.org, tags: args.tags });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'promote_working_memory') {
        const r = await memory.promoteWorking(args.id, { org: args.org });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'set_project_config') {
        const r = backend.projectConfigSet(args.project, {
          custom_categories: args.custom_categories,
          extract_instructions: args.extract_instructions,
          criteria: args.criteria,
          webhook_urls: args.webhook_urls,
        });
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'get_project_config') {
        const r = args.project ? backend.projectConfigGet(args.project) : backend.projectConfigList();
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'get_webhook_recent') {
        const r = { enabled: !!config.CONFIG.webhook_enabled, deliveries: webhook.recentDeliveries() };
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      // ---- v1.13.0 handlers ----
      if (name === 'pin_memory') { const r = await memory.doUpdate(args.id, { pinned: true }); return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id, pinned: true, ...r }, null, 2) }] }; }
      if (name === 'unpin_memory') { const r = await memory.doUpdate(args.id, { pinned: false }); return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id, pinned: false, ...r }, null, 2) }] }; }
      if (name === 'export_memories') { const items = await backend.exportMemories(args); return { content: [{ type: 'text', text: JSON.stringify({ count: items.length, items }, null, 2) }] }; }
      if (name === 'import_memories') { const r = await backend.importMemories(args.items || []); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'reset_memories') { try { const r = backend.resetMemories(args.confirm); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; } catch (e) { return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }; } }
      if (name === 'backup_memories') {
        const items = await backend.exportMemories(args);
        const bp = util.safePath(config.CONFIG.backup_path || config.ROOT + '/backups');
        if (!bp) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, message: 'backup_path 无效或不在 ROOT 之下' }) }] };
        try { require('fs').mkdirSync(bp, { recursive: true }); } catch (e) { errC.backup++; }
        const fn = bp + '/memories_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        require('fs').writeFileSync(fn, JSON.stringify({ version: config.SERVER_VERSION, exported_at: new Date().toISOString(), count: items.length, items }, null, 2));
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, file: fn, count: items.length }, null, 2) }] };
      }
      if (name === 'get_memory_stats') {
        const d = backend.sqliteInit();
        let sql = 'SELECT mem_category, COUNT(*) as cnt FROM memories';
        const params = [];
        if (args.project) { sql += ' WHERE project=?'; params.push(args.project); }
        sql += ' GROUP BY mem_category ORDER BY cnt DESC';
        let catDist = []; try { catDist = d.prepare(sql).all(...params); } catch (e) { errC.other++; }
        let total = 0; try { const r = d.prepare('SELECT COUNT(*) as c FROM memories').get(); if (r) total = r.c; } catch (e) { errC.other++; }
        let pinned = 0; try { const r = d.prepare('SELECT COUNT(*) as c FROM memories WHERE pinned=1').get(); if (r) pinned = r.c; } catch (e) { errC.other++; }
        let expired = 0; try { const r = d.prepare('SELECT COUNT(*) as c FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').get(new Date().toISOString()); if (r) expired = r.c; } catch (e) { errC.other++; }
        return { content: [{ type: 'text', text: JSON.stringify({ memories: { total, pinned, expired, by_category: catDist } }, null, 2) }] };
      }
      if (name === 'infer_memory') {
        const facts = require('./facts');
        const r = await facts.inferMemory(args.memory_id);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'conclude_session') {
        const wm = await memory.listWorking({ session: args.session });
        let promoted = 0, summaryText = null;
        for (const w of wm) { try { await memory.promoteWorking(w.id, args); promoted++; } catch (e) { errC.other++; } }
        if (wm.length > 0 && config.CONFIG.llm_enabled && config.CONFIG.llm_url) {
          const embedMod = require('./embed');
          const contents = wm.map(w => '- ' + (w.content || '')).join('\n');
          try {
            const c = await embedMod.chatJSON({ url: config.CONFIG.llm_url, model: config.CONFIG.llm_model,
              apiKey: config.CONFIG.llm_api_key || null, messages: [{ role: 'system', content: '只返回 JSON: {"summary":"..."}' },
                { role: 'user', content: '会话要点：\n' + contents }], temperature: 0.2, jsonMode: true });
            const parsed = util.parseLooseJson(c); // chatJSON 返回字符串，需解析（修复原把字符串当对象访问 .summary 的 bug）
            if (parsed && parsed.summary) summaryText = String(parsed.summary).trim();
          } catch (e) { errC.other++; }
          if (summaryText) { await memory.doAdd({ content: summaryText, user: args.user || wm[0].user, project: args.project || wm[0].project, session: args.session, tags: ['session-summary', 'consolidated'], memory_type: 'consolidated' }); }
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, promoted, summarized: !!summaryText, summary: summaryText }, null, 2) }] };
      }
      // ---- v1.16.0 handlers ----
      if (name === 'recall_for_context') { const r = await context.recallForContext(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'resume_state') { const r = await context.resumeState(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'detect_contradictions') { const r = await maintain.detectContradictions(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'memory_health') { const r = await maintain.memoryHealth(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'prune_memories') { const r = await maintain.pruneMemories(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'merge_memories') { const r = await maintain.mergeMemories(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'export_memories_markdown') { const r = await context.exportMarkdown(args); return { content: [{ type: 'text', text: r.markdown }] }; }
      if (name === 'watch_tag') { const r = watch.watchTag(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'unwatch_tag') { const r = watch.unwatchTag(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'list_watches') { const r = watch.listWatches(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'schedule_recall') { const r = await review.scheduleRecall(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'due_recalls') { const r = await review.dueRecalls(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'digest') { const r = await context.digest(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      // ---- v1.17.0 handlers ----
      if (name === 'scheduler_status') { const last = scheduler.getLast(); const hist = args.history ? scheduler.getHistory() : null; return { content: [{ type: 'text', text: JSON.stringify({ ok: !!last, last, history: hist }, null, 2) }] }; }
      if (name === 'list_watch_dead') { const r = watch.listWatchDead(); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'retry_watch_dead') { const r = await watch.retryWatchDead(); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'archive_memories') { const r = await archive.archiveMemories(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'list_archived') { const r = archive.listArchived(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'restore_archived') { const r = await archive.restoreArchived(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'export_memory_text') { const r = await context.exportMarkdown(args); return { content: [{ type: 'text', text: r.content }] }; }
      if (name === 'create_backup') { const r = await backup.createBackup(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'list_backups') { const r = backup.listBackups(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'restore_backup') { const r = await backup.restoreBackup(args); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      if (name === 'run_verification') { const r = await verify.scanAndCreateFixes(); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'list_fix_needed') {
        const pool = require('./insight').loadAllCached() || [];
        let items = pool.filter(m => m.tags && Array.isArray(m.tags) && m.tags.includes('fix-needed'));
        if (args.project) items = items.filter(m => m.project === args.project);
        items = items.slice(0, args.limit || 50);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, count: items.length, items }, null, 2) }] };
      }
      if (name === 'resolve_fix') {
        const mem = await memory.getMemory(args.id);
        if (!mem) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not found' }) }] };
        const newTags = (mem.tags || []).filter(t => t !== 'fix-needed' && t !== 'verify-fail').concat(['fixed']);
        await memory.doUpdate(args.id, { tags: newTags });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id, status: 'fixed' }) }] };
      }
      // v1.20.0 (#3): 记忆矛盾任务管理
      if (name === 'list_conflicts') {
        const qualityAuto = require('./quality_auto');
        const items = await qualityAuto.listConflicts(args.project || null, args.limit || 50);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, count: items.length, items }, null, 2) }] };
      }
      if (name === 'resolve_conflict') {
        const mem = await memory.getMemory(args.id);
        if (!mem) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not found' }) }] };
        const newTags = (mem.tags || []).filter(t => t !== 'conflict-task' && t !== 'fix-needed').concat(['resolved']);
        await memory.doUpdate(args.id, { tags: newTags });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: args.id, status: 'resolved' }) }] };
      }
      if (name === 'run_quality_scan') {
        const qualityAuto = require('./quality_auto');
        const out = {};
        try { out.stale_facts = await qualityAuto.scanStaleFacts(); } catch (e) { out.stale_facts = { error: e.message }; }
        try { out.conflict_repair = await qualityAuto.repairContradictions(); } catch (e) { out.conflict_repair = { error: e.message }; }
        try { out.confidence_decay = await qualityAuto.decayConfidence(); } catch (e) { out.confidence_decay = { error: e.message }; }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
    } catch (e) { return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }; }
  }
  // ---- v1.16.0 (#93) MCP Resources：以 memory:// URI 暴露记忆资源，供支持 Resources 的客户端浏览/读取。
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [
      { uri: 'memory://all', name: '全部记忆（近期）', description: '近期记忆列表（JSON）', mimeType: 'application/json' },
    ];
    try {
      const all = await require('./insight').loadAllCached();
      const counts = new Map();
      for (const m of all) { const p = m.project || '(default)'; counts.set(p, (counts.get(p) || 0) + 1); }
      for (const [proj, cnt] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100)) {
        const key = proj === '(default)' ? '' : encodeURIComponent(proj);
        resources.push({ uri: 'memory://project/' + key, name: '项目：' + proj + '（' + cnt + '）', description: '项目「' + proj + '」的记忆（Markdown）', mimeType: 'text/markdown' });
      }
    } catch (e) { errC.other++; }
    return { resources };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri || '';
    try {
      if (uri === 'memory://all') {
        const r = await memory.doList({ limit: 100 });
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r.rows || [], null, 2) }] };
      }
      let m = uri.match(/^memory:\/\/project\/([^/]*)(?:\/(markdown|json))?$/);
      if (m) {
        const project = m[1] ? decodeURIComponent(m[1]) : null;
        const fmt = m[2] || 'markdown';
        if (fmt === 'json') {
          const r = await memory.doList({ project, limit: 200 });
          return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r.rows || [], null, 2) }] };
        }
        const md = await context.exportMarkdown({ project });
        return { contents: [{ uri, mimeType: 'text/markdown', text: md.markdown }] };
      }
      m = uri.match(/^memory:\/\/memory\/(.+)$/);
      if (m) {
        const mem = await memory.getMemory(decodeURIComponent(m[1]));
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(mem, null, 2) }] };
      }
    } catch (e) { return { contents: [{ uri, mimeType: 'text/plain', text: 'error: ' + e.message }] }; }
    return { contents: [{ uri, mimeType: 'text/plain', text: 'unknown resource: ' + uri }] };
  });

  // ---- v1.17.0 (#97): MCP Prompts 原语 ----
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: prompts.listPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const p = prompts.getPrompt(request.params.name, request.params.arguments || {});
    if (!p) return { prompts: [] };
    return p;
  });

  // ---- v1.17.0 (#104): 工具调用指标 + scope 注入 + 嵌入缓存增量 ----
  let _lastHits = 0, _lastMiss = 0;
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // #105 scoped key：强制 project 作用域
    if (request._scope) {
      request.params = Object.assign({}, request.params, { arguments: Object.assign({}, request.params.arguments, { project: request._scope }) });
    }
    const _t0 = Date.now();
    let _isErr = false, _res;
    try { _res = await callToolHandler(request); }
    catch (e) { _isErr = true; _res = { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }; }
    const ms = Date.now() - _t0;
    try {
      quality.recordTool(request.params.name, ms, _isErr);
      const cs = embed.cacheStats();
      quality.bumpEmbedCache(cs.hits - _lastHits, cs.misses - _lastMiss);
      _lastHits = cs.hits; _lastMiss = cs.misses;
    } catch (e) {}
    return _res;
  });

  // ---- v1.17.0 (#98): 记忆变更 → 通知已连接客户端刷新 Resources ----
  const notifyListChanged = () => { server.notification({ method: 'notifications/resources/list_changed' }).catch(() => {}); };
  bus.on('memory-changed', notifyListChanged);

  return server;
}

module.exports = { TOOLS, createServer };
