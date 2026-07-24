// MCP 接入层：工具 schema(TOOLS) + createServer（每 SSE 连接一个实例）。
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const config = require('./config');
const backend = require('./backend');
const memory = require('./memory');
const correction = require('./correction');
const projects = require('./projects');
const graph = require('./graph');
const capture = require('./capture');
const webhook = require('./webhook');

// ---- MCP tool schema ----
const TOOLS = [
  { name: 'add_memory', description: 'Store a memory (text) into the AI memory store. When dedup_enabled is on (default) and a vector embedding is available, an incoming memory whose content is highly similar to an existing one (cosine >= dedup_threshold, default 0.92) is merged into that memory instead of creating a duplicate. Pass merge:false to force a new entry.',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' },
      session: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      category: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], description: '记忆分类：semantic=持久事实/偏好，episodic=特定情境下的事件/决定，procedural=操作流程/沟通风格。默认 semantic。v1.5.0 新增。' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '记忆类型（v1.6.0 新增）：user=关于用户本人的持久事实/偏好（用户画像类），agent=Agent 自身的运行记忆/习得，session=仅当前会话相关、会话结束后价值衰减的临时记忆。默认 user。' },
      merge: { type: 'boolean', description: 'Allow merging with a highly similar existing memory. Default: follows global dedup_enabled config. Set false to always create a new entry.' },
      mem_category: { type: 'string', enum: ['fact', 'preference', 'opinion', 'event', 'procedure', 'skill'], description: 'v1.11.0 Mem0 式高层语义类别：fact=客观事实/数据/配置, preference=用户偏好/喜好/习惯, opinion=观点/主观评价, event=具体事件, procedure=操作步骤/SOP, skill=某人会做某事的能力。' },
      tier: { type: 'string', enum: ['long', 'working'], description: 'v1.11.0 记忆分层：long=长期(默认), working=短时工作记忆缓冲(独立存储、不污染长期库、按 working_ttl_hours 过期、可 promote)。' },
      org: { type: 'string', description: 'v1.11.0 组织作用域（可选，用于组织级共享知识池隔离）。' },
      extract_version: { type: 'string', enum: ['v1', 'v2'], description: 'v1.11.0 抽取模型版本：v2(默认)会产出 mem_category 高层语义类别。' },
      extract_instructions: { type: 'string', description: 'v1.11.0 per-call 抽取引导：自然语言指令，控制「记什么/不记什么」（如"只记技术栈相关的事实"）。' },
      source: { type: 'object', description: 'Optional provenance / 溯源, 例如 {type:"doc", ref:"docs/order.md", conversation_id:"...", message_id:"...", url:"https://...", file:"src/a.ts", line:42}。type 可填 human/agent/tool/system 以参与来源信任加权;系统会自动补 captured_at(捕获时间)与 trigger(add/capture)。在 admin 界面可点击「溯源」查看完整来源与内容演变。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：行为主体标识（人/系统/角色）。可选，用于按 actor 过滤检索与隔离。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：产生该记忆的 Agent 标识。可选。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 多主体归属：产生该记忆的运行/会话实例标识。可选。' },
      custom_categories: { type: 'array', items: { type: 'string' }, description: 'v1.12.0 (gap①) 自定义类别体系（string[]），覆盖/补充默认 mem_category 枚举；项目级持久配置优先，逐调用次之。' } },
      required: ['content', 'user'] } },
  { name: 'search_memories', description: 'Search memories. mode: keyword (BM25), semantic (kNN), hybrid (RRF). Results are recency-decay weighted (recent first) when recency_enabled — decay basis is each memory\'s last access/reinforcement time (last_accessed_at), falling back to updated_at, so frequently-recalled memories stay fresh and long-unused ones decay (human-memory model). Also modulated by a salience score (importance + access reinforcement) when salience_enabled. Use from/to (ISO date/time or YYYY-MM-DD) to limit to a time window by updated_at. memory_type filters by user/agent/session.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], default: 'keyword' }, top_k: { type: 'number', default: 5 },
      from: { type: 'string', description: 'Lower bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      to: { type: 'string', description: 'Upper bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      category: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], description: '按记忆分类过滤（v1.5.0 新增）。' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '按记忆类型过滤（v1.6.0 新增）。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 按行为主体 actor 过滤。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 按产生记忆的 Agent 过滤。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 按运行/会话实例过滤。' },
      criteria: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, weight: { type: 'number' } }, description: 'v1.12.0 (gap③) 准则加权检索：[{text,weight}]，按每条准则的语义相似度对候选加权融合重排（weight 越大越优先）。未显式传时回退项目级配置默认 criteria。' } } },
      required: ['query'] } },
  { name: 'list_memories', description: 'List recent memories, recency-weighted when recency_enabled. from/to limit to a time window by updated_at.',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' }, limit: { type: 'number', default: 20 },
      from: { type: 'string', description: 'Lower bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      to: { type: 'string', description: 'Upper bound (ISO date/time or YYYY-MM-DD) on updated_at.' },
      memory_type: { type: 'string', enum: ['user', 'agent', 'session'], description: '按记忆类型过滤（v1.6.0 新增）。' },
      actor_id: { type: 'string', description: 'v1.12.0 (gap②) 按行为主体 actor 过滤。' },
      agent_id: { type: 'string', description: 'v1.12.0 (gap②) 按产生记忆的 Agent 过滤。' },
      run_id: { type: 'string', description: 'v1.12.0 (gap②) 按运行/会话实例过滤。' } } } },
  { name: 'delete_memory', description: 'Delete a memory by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'purge_memories', description: 'Lifecycle cleanup: delete memories older than N days (by updated_at) within an optional user/project/session scope. If expired_only is true, uses configured expiry_days; otherwise the days argument is used. Nothing happens if neither is set.',
    inputSchema: { type: 'object', properties: {
      user: { type: 'string' }, project: { type: 'string' }, session: { type: 'string' },
      days: { type: 'number', description: 'Delete memories older than this many days.' },
      expired_only: { type: 'boolean', description: 'If true, use configured expiry_days instead of the days argument.' } },
      required: [] } },
  { name: 'capture_memory', description: 'Auto-capture memories from raw conversation text or notes. If an LLM (llm_url) is configured, the text is intelligently extracted into structured memory items (content+tags+importance) before storage; otherwise a heuristic fallback splits into sentences and stores novel chunks with dedup applied. All captured items are tagged auto-captured.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Raw conversation text, notes, or transcript to capture from.' },
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
  { name: 'related_to', description: 'Knowledge-graph: given an entity (person/project/system/...), return the entities connected to it via relations (with relation type and occurrence count) across all memories, plus the source memories. Use type to filter by relation (e.g. responsible_for). Requires kg_enabled + extracted graph data.',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string', description: 'Entity name (alias accepted, normalized via kg_synonyms).' },
      type: { type: 'string', description: 'Optional relation type filter, e.g. responsible_for / uses / depends_on.' },
      limit: { type: 'number', default: 20 } },
      required: ['entity'] } },
  { name: 'graph_query', description: 'Knowledge-graph: return the raw entities and relations of all memories mentioning the given entity. Use it to build/visualize a subgraph. Requires kg_enabled.',
    inputSchema: { type: 'object', properties: {
      entity: { type: 'string' }, limit: { type: 'number', default: 50 } },
      required: ['entity'] } },
  { name: 'path_between', description: 'Knowledge-graph: find a relation path between two entities across memories (BFS over extracted relations). Returns null path if not connected. Requires kg_enabled.',
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
];

function createServer() {
  const server = new Server({ name: 'ai-memory', version: config.SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
      if (name === 'import_memories') { const r = backend.importMemories(args.items || []); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; }
      if (name === 'reset_memories') { try { const r = backend.resetMemories(args.confirm); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }; } catch (e) { return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }; } }
      if (name === 'backup_memories') {
        const items = await backend.exportMemories(args);
        const bp = config.CONFIG.backup_path || config.ROOT + '/backups';
        try { require('fs').mkdirSync(bp, { recursive: true }); } catch (e) {}
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
        let catDist = []; try { catDist = d.prepare(sql).all(...params); } catch (e) {}
        let total = 0; try { const r = d.prepare('SELECT COUNT(*) as c FROM memories').get(); if (r) total = r.c; } catch (e) {}
        let pinned = 0; try { const r = d.prepare('SELECT COUNT(*) as c FROM memories WHERE pinned=1').get(); if (r) pinned = r.c; } catch (e) {}
        let expired = 0; try { const r = d.prepare('SELECT COUNT(*) as c FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').get(new Date().toISOString()); if (r) expired = r.c; } catch (e) {}
        return { content: [{ type: 'text', text: JSON.stringify({ memories: { total, pinned, expired, by_category: catDist } }, null, 2) }] };
      }
      return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
    } catch (e) { return { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true }; }
  });
  return server;
}

module.exports = { TOOLS, createServer };
