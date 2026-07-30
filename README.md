# ai-memory —— 本地优先的 AI 长期记忆服务

> 一个面向 AI 助手的"长期记忆"后端：把对话、文档片段、知识要点结构化存进 Qdrant 向量库（或本地 SQLite 降级库），用**向量检索 + 关键词召回 + 知识图谱**把"过去说过什么、谁和谁什么关系"随时找回来。支持本地模型与云端模型后端解耦，提供一键自测，并且在每个外部依赖异常时都有明确的降级路径。

---

## 快速开始 / 部署

### 本地开发（SQLite 降级模式，无需任何外部依赖）
```bash
npm start
# 访问 http://localhost:8765/admin
```

### Docker 全栈（Qdrant + ai-memory）
```bash
docker compose up -d
curl -X PUT http://localhost:6333/collections/memories -H 'Content-Type: application/json' \
  -d '{"vectors":{"size":1024,"distance":"Cosine","on_disk":true},"quantization_config":{"scalar":{"type":"int8"}},"hnsw_config":{"m":8}}'
# 管理界面 http://localhost:8765/admin
```

### 部署到服务器（deploy.js）
```bash
SSH2_PASSWORD=your_password node deploy.js
```
脚本行为：远端整目录 tar 备份 → 打包 `lib/*.js` + `server.js` + `admin.html` + `package.json` → SFTP 上传 → 解压 → 逐文件 `node --check` 语法全检 → 删除远端死代码 → `systemctl restart ai-memory` → `/api/health` 健康检查。

环境变量：`SSH2_PASSWORD`（密码）、`HOST`（目标 IP，默认 `192.168.110.128`）。
绝不覆盖：`config.json`、`memories.db*`、`backups/`。

### 手动 scp（有原生 ssh 时）
```bash
ssh root@192.168.110.128 'tar czf /opt/ai-memory-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C /opt ai-memory'
scp server.js admin.html lib/*.js root@192.168.110.128:/opt/ai-memory/
ssh root@192.168.110.128 'cd /opt/ai-memory && node --check server.js && for f in lib/*.js; do node --check "$f" || exit 1; done && systemctl restart ai-memory'
```

### 回滚
```bash
ssh root@192.168.110.128 'systemctl stop ai-memory && rm -rf /opt/ai-memory && tar xzf /opt/ai-memory-backup-<时间戳>.tar.gz -C /opt && systemctl start ai-memory'
```

> 服务器路径：`/opt/ai-memory/`，systemd 服务 `ai-memory.service`，监听 `:8765`。
> `lib/` 是唯一真正运行的代码目录（`server.js` 只 `require('./lib/config')` + `require('./lib/rest')`），部署必须覆盖 `lib/`。

---

## 一、这是什么

`ai-memory` 是一套**本地优先（Local-First）**的 AI 记忆系统。它让 AI 助手具备跨会话、跨项目的长期记忆能力，而不是每次对话都从零开始。

- **存储**：默认 Qdrant（`memories` 集合，每条记忆是一个 1024 维向量 + 结构化 payload 文档）；**当 `qdrant_url` 留空（或 `embedding_url` 未配）时自动降级为本地 SQLite 文件库 `memories.db`**（见第四节）。
- **向量化**：`qwen3-embedding:0.6B`（Ollama `http://192.168.110.248:11500/v1/embeddings`，1024 维）。
- **LLM 提取**：可选 deepseek-v4-pro（云端）/ minicpm5-1b（本地 128），用于实体/关系/类别抽取。
- **服务**：单个 Node 进程同时提供 MCP SSE 接口、`/admin` 管理界面、REST API。
- **部署**：systemd 服务 `ai-memory.service`，监听 `:8765`。

核心设计目标：**数据留在你自己的服务器上**；模型可以本地跑，也可以按需指向云端（DeepSeek / 硅基流动 / OpenAI 等 OpenAI 兼容端点）；并且"向量 / 捕获 LLM / 图谱抽取"三个后端**各自独立选择本地或云端**。

---

## 二、核心能力（详解）

### 2.1 向量记忆检索
每条记忆写入时做嵌入，查询时做余弦相似度召回。支持：
- `mode=keyword`：BM25 关键词召回
- `mode=semantic`：kNN 向量语义召回
- `mode=hybrid`：关键词 + 语义的应用层 RRF 融合（见第六节）
- 过滤：`user` / `project` / `session` / `tags`
- 时间窗：`from` / `to`（ISO 日期或 `YYYY-MM-DD`），按 `updated_at` 限制范围
- `recency` 时序衰减加权：近期记忆排序靠前（可在配置关闭）

### 2.2 记忆去重与合并（dedup）
- 开关 `dedup_enabled`（默认 `true`）。
- **两级判重**：① **内容哈希精确判重**（确定性）——写入时对内容做归一化（小写 + 空白折叠）SHA-1 存入 `content_hash` 字段，完全相同的内容直接命中合并（similarity=1），不受向量阈值影响；② **向量相似判重**——余弦相似度 `>= dedup_threshold`（默认 `0.92`）则**合并**到该记忆：内容覆盖为最新、标签取并集、向量重算、合并时间更新——而不是新增重复条目。
- 所有写入口（REST `POST /api/memories`、MCP `add_memory`、自动捕获 `reconcileFact`）汇聚到同一个 `backend.dedupFind`，两级判重对全部入口生效。
- `add_memory` 工具传 `merge:false` 可强制新增。
- **降级**：去重查询异常时返回 `null` 不阻塞写入，但会打 `console.error` 日志并计入 `dedup_stats.err`（可能产生重复记忆，可从 `/api/health` 的 `dedup_stats` 观测 exact/vector/err 计数）。

### 2.3 时序感知
- 每条记忆带 `created_at` / `updated_at`。
- 检索时按 `recency` 衰减加权（`applyRecency`）。
- `history`：记忆的演变历史可追溯。
- `lifecycle`：支持过期清理（`cleanupExpired`，按 `updated_at` 早于 cutoff 删除）与显式 `purge`。

### 2.4 自动捕获（混合：LLM 智能提取 + 启发式回退）
两种触发方式：
- **MCP 工具 `capture_memory`** / **REST `POST /api/capture`**：传入原始对话/文本，或传 `messages` 结构化数组（`[{role, content}]`，messages 优先）；服务端自动过滤闲聊、抽取事实、去重合并后入库。
- **文件监听 `capture_watch_*`**：监听指定文件/目录，追加内容自动入库（偏移量存 `.capture.offsets.json`，重启续传）。

提取策略（`captureText`）：
1. 若 `llm_enabled && llm_url` → 走 `llm` 模式，把文本交给 chat 模型提炼成结构化记忆项（content + tags + importance）。
2. 否则 → 走 `heuristic` 模式，按句切分、过滤短句与关键词、逐条入库。
3. **降级**：LLM 提取抛异常或 JSON 解析失败 → 自动回退 `heuristic` 模式（见第五节），保证总能捕获。
4. 所有捕获项打 `auto-captured` 标签；文件监听项额外打 `watched`。
- 单条 `doAdd` 失败 → 计 `skipped`，不影响其他条。

### 2.5 知识图谱
每条记忆抽取：
- `entities:[{type, name, canonical, aliases}]` —— 实体，`canonical` 经同义词表（`kg_synonyms`）归一，实现跨记忆消歧。
- `relations:[{from, to, type}]` —— 关系（owns / uses / responsible_for / depends_on / part_of / decided / located_in / other）。
- `source` / `entity_names` —— 来源与规范化实体名列表。

跨记忆聚合能力：
- `related_to(entity)`：返回与该实体相连的所有实体（含关系类型、出现次数）及来源记忆。
- `graph_query(entity)`：返回涉及该实体的原始实体/关系子图（用于可视化）。
- `path_between(a, b)`：BFS 在两实体间找关系路径；不相连返回 `path:null`。
- **降级**：图谱抽取失败不影响主写入，实体字段置空（见第五节）。

### 2.6 本地 / 云端双后端
嵌入、捕获 LLM、图谱抽取三个后端**各自独立**配置端点与可选 `api_key`：
- **本地**（Ollama / llama-embed）：`api_key` 留空 → 不发 `Authorization` 头。
- **云端**（DeepSeek / 硅基流动 / OpenAI 等 OpenAI 兼容）：填端点 + `api_key` → 自动注入 `Authorization: Bearer <key>`。
- **图谱独立解耦**：图谱可经独立 `kg_url` 指向云端，而捕获 LLM 留本地（留空则复用捕获 LLM 的 `llm_url` / `llm_api_key` / `llm_model`）。
- 云端 JSON 强约束：仅当 `jsonMode && apiKey` 才加 `response_format:{type:'json_object'}`；本地 Ollama 靠 prompt 约束。
- 鉴权统一封装在 `authHeaders(apiKey)` / `chatJSON(...)`，本地与云端共用同一调用链。

### 2.7 四个后端一键自测
管理界面每个区一个「测试」按钮（见第十节），填好配置**先测通再保存**。

### 2.8 智能深化（冲突 / 聚类 / 遗忘曲线）
管理界面「质量监控」页新增「智能深化」三块，只读分析现有记忆：
- **冲突 / 重复检测** `GET /api/memories/duplicates?threshold=&limit=`：向量余弦（或内容 jaccard 兜底）扫描语义相近的记忆对，辅助合并清理；`exact` 标记内容哈希完全一致的强冲突。
- **标签聚类** `GET /api/tags/cluster`：标签频率 + 共现关系，用并查集（共现 ≥2）归并出主题簇。
- **遗忘曲线** `GET /api/learning/forgetting-curve`：基于间隔重复稳定性（SM-2 风格间隔 `2^访问次数·2h`，封顶 720h）预测不复习时的记忆留存衰减（未来 30 天），并给出待复习 / 已排期分布。遗留记忆缺 `next_review_at` 时按访问次数派生稳定性，曲线仍可呈现。

### 2.9 管理界面增强（英文双语 / 深浅主题 / 响应式）
- **英文模式彻底双语**：所有 JS 动态中文串、静态 inline 标签、select option 全部走 `t()` i18n（zh+en 双词典）；切换语言时动态渲染内容（帮助页工具描述、表格、弹窗等）会重拉或重翻，保证中英文都完整。
- **深浅主题切换 + 响应式**：CSS 抽成 `:root`（深色默认）+ `[data-theme="light"]`（浅色）双调色板，右上角按钮切换并 localStorage 持久化；`@media` 响应式适配窄屏（头部换行、工具栏/行纵向堆叠、表格横向滚动）。
- **使用帮助页**：「使用帮助」Tab 实时拉取 `/api/docs`，渲染 MCP 工具清单（含参数 / 必填 / 枚举 / 中英文描述）、REST API 表（含 v1.21.0 新增的备份/标签/运维接口）、配置项说明（自动对齐服务端全部可配项）、检索模式、部署架构与注意事项，内容随服务端版本自动对齐。

---

## 三、系统架构

```
                         ┌──────────────────────────────────────┐
                         │         ai-memory (Node :8765)         │
                         │                                        │
   MCP 客户端 ─────────▶ │  ┌──────────┐  ┌──────────┐ ┌────────┐ │
   (Claude/Code 等)      │  │ MCP SSE  │  │  /admin   │ │ REST   │ │
                         │  │ (tools)  │  │ (UI)     │ │/api/* │ │
                         │  └──────────┘  └──────────┘ └────────┘ │
                         │        │            │           │       │
                         │        └────────────┼───────────┘       │
                         │                     ▼                   │
                         │        ┌─────────────────────────┐      │
                         │        │ 核心逻辑                │      │
                         │        │ · 嵌入/去重/时序        │      │
                         │        │ · 自动捕获(LLM/启发式)  │      │
                         │        │ · 知识图谱抽取与查询    │      │
                         │        │ · authHeaders/chatJSON  │      │
                         │        │ · 降级/容错(fallback)   │      │
                         │        └───────────┬─────────────┘      │
                         └────────────────────┼────────────────────┘
                                              │
              ┌───────────────────────────────┼────────────────────────────┐
              ▼                               ▼                            ▼
      ┌──────────────┐              ┌──────────────┐              ┌──────────────┐
      │   Qdrant    │  (降级)       │  llama-embed  │              │ 可选云端模型  │
      │  :6333      │ ───────────▶ │  (本地嵌入)   │              │ (DeepSeek等) │
      │  memories   │   SQLite     │              │              │              │
      └──────────────┘  memories.db └──────────────┘              └──────────────┘
```

**模块职责**
- `embed()`：调用嵌入端点，失败返回 `{ok:false}`，调用方据此降级（记忆仍写入，仅无向量）。
- `dedupFind()`：两级判重（content_hash 精确 → 向量相似），失败记日志 + `dedup_stats.err` 后返回 `null`。
- `llmExtract()` / `captureText()`：自动捕获，LLM 失败回退启发式。
- `extractGraph()` / `normalizeGraph()` / `canon()`：图谱抽取与实体归一。
- `searchMemories()`：三种检索模式 + 应用层 RRF。
- `testEmbedding` / `testChat` / `testKG` / `testDatabase`：自测助手（均 try/catch 返回友好错误）。

---

## 四、存储后端：Qdrant 与本地 SQLite 降级

| 场景 | 存储 | 说明 |
|------|------|------|
| `qdrant_url` 已配置（且 `embedding_url` 已配） | Qdrant（`memories` 集合） | 主用；向量 kNN + payload 结构化过滤 + 应用层 RRF 混合检索 |
| `qdrant_url` 留空 / 无嵌入 | 本地 SQLite（`better-sqlite3` → `memories.db`） | **自动降级**，无需额外部署即可运行 |

- 服务启动时 `try { Database = require('better-sqlite3') } catch { Database = null }`：若 `better-sqlite3` 不可用则 `Database=null`，本地 SQLite 降级库不可用，但 Qdrant 主存储仍可用；Qdrant 与 SQLite 二者皆不可用时存储不可用（健康检查会报错，详见自测）。
- 降级为 SQLite 时，语义（kNN）检索退化为关键词/近似匹配，因为 SQLite 无原生向量索引；但这保证了**无 Qdrant 环境也能先把记忆存下来**。

### 审计历史层（v1.9.1）
- **为什么**：Qdrant 是 upsert 全量覆盖（无部分更新端点），普通更新直接盖掉旧 payload，**不留变更痕迹**。为补齐「可审计、可回放」能力（对齐 Mem0 的 SQLite 历史层），新增**独立变更账本** `memory_changelog` 表（复用同一个 `memories.db`），**不被 Qdrant upsert 覆盖**。
- **记什么**：每次写操作成功后各记一条 `{memory_id, op, ts, user, project, before, after, source_trigger}`——`op ∈ {ADD, UPDATE, CORRECT, DELETE, PIN, UNPIN, CLEANUP}`；`before/after` 只存关键字段快照（控制体积）。`CLEANUP`（生命周期清理）记 `{deleted_count, deleted_ids}`。
- **怎么查**：单条记忆时间线 `GET /api/memories/:id/history`；**全局审计流 `GET /api/audit`**（支持 `op`/`user`/`project`/`trigger` 过滤 + `limit`/`offset` 分页，返回 `{rows,total}`），记忆删除后历史仍保留（账本独立）。admin「操作审计」Tab 实时可视化（按操作类型/项目过滤、展示 before 快照摘要）。`audit_enabled=false` 可关闭写入。
- **版本乐观锁（防并发丢失）**：每条记忆 payload 带 `version`（doAdd=1，每次更新 +1）。Qdrant 路径写前**重读最新 prev+version 再递增写回**（乐观重试，默认 3 次），避免两个并发写互相覆盖；SQLite 路径串行递增。

---

## 五、降级与容错处理（核心设计）

> 设计原则：**主写入链路（把记忆存下来）永不被次要能力（向量化、图谱抽取）的失败打断。** 每个外部依赖都有明确兜底。

| # | 降级点 | 触发条件 | 降级行为 | 是否阻塞主流程 |
|---|--------|----------|----------|----------------|
| 1 | **数据库** | `qdrant_url` 空 / 无嵌入 / Qdrant 启动期或运行期不可达 | 自动改用本地 SQLite `memories.db`；二者皆无则存储报错（健康检查可见）。**v1.22.0 新增运行期可达性探测**：`qdrant_url` 已配置但实测 `/collections/{coll}` 不可达时，状态缓存置 `false`，`memory.Q()` 据此实时降级到 SQLite —— 此前「配置了 Qdrant 但挂了」只会静态信任配置、不会真正回退 | 否（有降级库）/ 是（全无） |
| 2 | **配置加载** | `config.json` 缺失/损坏 | `try/catch` 静默忽略，回落到内置默认值 + 环境变量 fallback | 否 |
| 3 | **嵌入失败** | 嵌入端点不可达 / 超时 / 返回 0 维 | `catch` 后 `doc.embedding` 不赋值，记忆**仍写入**，只是该条不参与语义检索（退化为仅关键词） | 否 |
| 4 | **去重查找失败** | `dedupFind` 异常 | 打 `console.error` + `dedup_stats.err`++，返回 `null` → 视作无相似记忆 → 直接新增，不合并（可能重复，可观测） | 否 |
| 5 | **知识图谱抽取（开关）** | `kg_enabled=false` 或没有可用 url | `extractGraph` 直接返回 `{entities:[],relations:[],entity_names:[]}` | 否 |
| 6 | **知识图谱抽取（调用）** | LLM 调用失败 / 网络错 / JSON 解析失败 | `catch` 返回空；外层 `attachGraph` 再 `catch` → 实体字段置 `[]` | 否 |
| 7 | **图谱 JSON 包裹** | 模型返回 ` ```json ... ``` ` 围栏 | 先 `strip` 围栏再 `JSON.parse`，兼容不严格输出 | 否 |
| 8 | **自动捕获模式选择** | `llm_enabled && llm_url` | 否则自动走 `heuristic` 启发式 | 否 |
| 9 | **自动捕获 LLM 失败** | `llmExtract` 抛异常或返回非 JSON | `candidates=[]; mode='heuristic'` → 回退按句切分入库 | 否 |
| 10 | **自动捕获单条失败** | 某条 `doAdd` 抛异常 | `skipped++`，其余继续 | 否 |
| 11 | **混合检索** | Qdrant 无原生 RRF | 改用**应用层 RRF**（Node 端融合，K=60）| 否 |
| 12 | **检索失败** | Qdrant 查询异常 | 返回 `[]`，不会让上层崩溃 | 否 |
| 13 | **生命周期清理失败** | `cleanupExpired` / `deleteByQuery` 异常 | `catch` 返回 `0`，不影响主请求 | 否 |
| 14 | **MCP 工具异常** | 工具执行出错 | 返回 `{isError:true, content:[{text:'error: ...'}]}` | 否（向上报告） |
| 15 | **文件监听 offset** | `.capture.offsets.json` 读取失败 | 忽略，从头监听（可能重复捕获已处理内容，但会被 dedup 合并） | 否 |
| 16 | **API Key 安全** | `/api/config` GET | `api_key` 掩码为 `******`；POST 仅当值 `!== '******'` 才更新（避免把掩码当真值写回） | 否 |

**关键结论**：在 Qdrant 正常的前提下，即使嵌入服务宕机、LLM 不可用、图谱模型报错，**记忆写入与关键词检索始终可用**。这是系统可用性的底线。

---

## 六、检索模式与 RRF 降级

`search_memories` 的 `mode` 参数：

| mode | 实现 | 依赖 |
|------|------|------|
| `keyword` | 语义候选 + content/tags 子串命中（Qdrant 无原生 BM25） | Qdrant + 嵌入端点 |
| `semantic` | Qdrant `query` (dense_vector, Cosine) | Qdrant + 嵌入端点 |
| `hybrid` | **应用层 RRF** 融合 keyword + semantic 两份排名 | Qdrant + 嵌入端点 |

**为什么是应用层 RRF**：Qdrant **无原生 BM25、服务端也不支持 RRF 融合**，所以系统**不依赖服务端 RRF**，而是在 Node 侧用 Reciprocal Rank Fusion（`score = 1/(K+i+1)`，K=60）对两份命中列表融合排序。好处：
- 不挑存储后端，Qdrant/SQLite 都能用混合检索；
- 即使 semantic 侧因嵌入失败为空，keyword 侧结果仍正常返回（RRF 自然降级为单路）。

所有模式最终都过 `applyRecency` 做时序衰减加权（可在配置关闭）。

---

## 七、目录与文件

| 文件 | 作用 |
|------|------|
| `server.js` | 薄入口：加载 config → 启动 Fastify HTTP 服务（MCP SSE + Admin + REST）|
| `lib/rest.js` | **Fastify v5** 应用：40+ 路由、鉴权中间件、JSON Schema 校验、错误处理、请求日志。自动生成 OpenAPI 文档（`/api/docs`）|
| `admin.html` | 管理界面（服务启动时读入内存，**改完必须重启服务才生效**） |
| `config.json` | 运行配置（Qdrant 地址、嵌入端点、各 `api_key` 等；部署脚本**不覆盖**此文件） |
| `deploy.js` | **推荐**部署脚本（sshtool/ssh2��沙箱友好）。完整流程：远端整目录备份→本地打包→SFTP 上传→远端解压+语法全检→重启→健康检查 |
| `Dockerfile` + `docker-compose.yml` | Docker 全栈部署（Qdrant + ai-memory 容器）|
| `LICENSE.md` | MIT 许可证（中文） |
| `memories.db` | （运行时生成）Qdrant 不可用时的本地 SQLite 降级库 |
| `lib/memory_lifecycle.js` | 清理/巩固/批量操作（从 memory.js 拆分）|
| `lib/memory_work.js` | 短时工作记忆操作（从 memory.js 拆分）|
| `lib/capture.js` | 自动捕获（文件监听 + API 触发）|
| `lib/webhook.js` | 事件推送与告警通知 |
| `lib/qdrant.js` | Qdrant 客户端封装 |
| `lib/config.js` | 配置管理（config.json + 环境变量覆盖）|

> 服务器上路径：`/opt/ai-memory/`，systemd 服务名 `ai-memory.service`。

---

## 八、部署

`/opt/ai-memory/lib/` 是唯一真正运行的代码目录（`server.js` 只 `require('./lib/config')` + `require('./lib/rest')`），所以部署**必须覆盖 `lib/`**，只拷 `server.js` 无效。

### 方式一：deploy.js（推荐，沙箱友好）
```bash
SSH2_PASSWORD=your_password node deploy.js
```
脚本行为：
1. 远端整目录 tar 备份到 `/opt/ai-memory-backup-<时间戳>.tar.gz`
2. 本地打包 `lib/*.js` + `server.js` + `admin.html`
3. SFTP 上传到 `/tmp` → 远端解压覆盖
4. 逐文件 `node --check` 语法全检（server.js + 全部 lib/*.js）
5. 删除远端遗留死代码（`verify_v113.js` 等）
6. `systemctl restart ai-memory`
7. `/api/health` 检查（核对 `version`/`store`/`qdrant_connected`/`err_stats`）

环境变量：`SSH2_PASSWORD`（密码）、`HOST`（目标 IP，默认 `192.168.110.128`）。
绝不覆盖：`config.json`、`memories.db*`、`backups/`。

### 方式二：手动 scp（有原生 ssh 时）
```bash
# 先备份
ssh root@192.168.110.128 'tar czf /opt/ai-memory-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C /opt ai-memory'
# 拷贝全部代码文件（必须含 lib/）
scp server.js admin.html lib/*.js root@192.168.110.128:/opt/ai-memory/
# 语法检查 + 重启
ssh root@192.168.110.128 'cd /opt/ai-memory && node --check server.js && for f in lib/*.js; do node --check "$f" || exit 1; done && systemctl restart ai-memory'
```

### 回滚
```bash
ssh root@192.168.110.128 'systemctl stop ai-memory && rm -rf /opt/ai-memory && tar xzf /opt/ai-memory-backup-<时间戳>.tar.gz -C /opt && systemctl start ai-memory'
```

### 方式三：Docker Compose
```bash
docker compose up -d
```
启动后 Qdrant 监听 `:6333`，ai-memory 监听 `:8765`（管理界面 `http://localhost:8765/admin`）。
需先建 Qdrant collection：
```bash
curl -X PUT http://localhost:6333/collections/memories -H 'Content-Type: application/json' -d '{"vectors":{"size":1024,"distance":"Cosine","on_disk":true},"quantization_config":{"scalar":{"type":"int8"}},"hnsw_config":{"m":8}}'
```
嵌入和 LLM 端点通过环境变量配置（默认指向 `host.docker.internal` 的 Ollama/嵌入服务）。
单构建 ai-memory 镜像：`docker build -t ai-memory .`。

### 端到端测试（test/run.js）

按功能拆分的端到端套件（`test/` 下 `health/memory_ops/io/stats/auth/config/lifecycle/correction/metrics/qdrant_regression/dedup/cleanup.js` + `unit.js` 纯函数单测 + `_common.js` 共享助手），由 `test/run.js` 顺序聚合。除 `unit.js`（毫秒级、不依赖 BASE）外，需在**完整部署环境**（Qdrant + 嵌入 + 捕获 LLM 在线）上跑。

```bash
# 对线上服务器（192.168.110.128:8765）跑全套端到端验证（含鉴权）
API_KEY=my-secret-key-114514 BASE=http://192.168.110.128:8765 node test/run.js
```

- `BASE`：被测服务地址；`API_KEY`：服务端 `config.json` 中 `api_keys` 之一（测试助手自动附带 `Authorization: Bearer` 与 `X-Requested-With: ai-memory` 头）。
- 长捕获管线：LLM/嵌入推理期间对客户端「无数据下发」，整段空闲可达 20~40s，故依赖服务侧 socket 超时已调高（≥120s），否则客户端会报 "other side closed"。
- 期望输出：`===== OVERALL ok=N fail=0 =====`（N 随套件增减，v1.21.0 基线 82 项全过）。任一 `fail>0` 即阻断。

### 本地快速验证子集（test/ci.js）

`test/ci.js` 是本地快速运行器，仅跑**纯 SQLite 降级模式**可验证的用例（不依赖外部 Qdrant/嵌入/LLM）：`unit / health / memory_ops / config / config_drift / rate_limit / fallback / backup_restore`。本地等价于：

```bash
# 本地：先以降级模式起服务，再跑子集
QDRANT_URL='' EMBEDDING_URL='' PORT=8765 node server.js &
BASE=http://127.0.0.1:8765 node test/ci.js
```

> 注：`test/` 目录整体在 `.gitignore`（测试文件不入库，仅本地验证用）。`test/ci.js` 作为本地子集运行器保留；CI 工作流暂未纳入仓库（按约定测试文件不入库，若要做 CI 需放宽该约定并重建 `.github/workflows/test.yml`）。

### 多客户端配置漂移检测（scripts/config-drift.js）

统一校验「运行中的服务 / 本地 config.json / 各 MCP 客户端定义」是否指向同一套后端（Qdrant / 嵌入 / LLM / KG 地址、是否启用鉴权、限流、自动备份等连接契约）：

```bash
# 比对线上服务 vs 本地模板（预期有漂移，因 example 是占位）
node scripts/config-drift.js server:http://192.168.110.128:8765 file:config.example.json
# 比对线上服务 vs 本地真实 config.json（预期仅版本/自动备份等细微差异）
node scripts/config-drift.js server:http://192.168.110.128:8765 file:config.json
# 比对线上服务 vs 某客户端 MCP 定义（mcpServers 形态）
node scripts/config-drift.js server:http://192.168.110.128:8765 file:~/.workbuddy/mcp.json
```

发现任一项漂移即非零退出（CI 可据此阻断），输出每个漂移键在各源的取值。

---

## 八、配置项详解（`config.json`）

| 字段 | 默认 | 说明 |
|------|------|------|
| `qdrant_url` | 空 | Qdrant 地址（如 `http://192.168.110.248:6333`）；**留空即降级为本地 SQLite** |
| `qdrant_collection` | `memories` | Qdrant 集合名 |
| `embedding_url` | 空 | 嵌入端点（本地 llama-embed / 云端）；留空则记忆无向量（仅关键词检索） |
| `embedding_model` | 空 | 嵌入模型名 |
| `embedding_api_key` | 空 | 云端嵌入的 Bearer Token；本地留空 |
| `llm_enabled` | `false` | 自动捕获的 LLM 智能提取开关 |
| `llm_url` / `llm_model` | 空 | 捕获 LLM 端点/模型；留空则启发式按句切分 |
| `llm_api_key` | 空 | 云端 chat 的 Bearer；本地留空 |
| `kg_enabled` | `false` | 知识图谱抽取开关（需有 LLM/图谱端点，否则静默不抽取） |
| `kg_url` | 空 | 图谱独立端点（留空=复用 `llm_url`）；实现"图谱走云、捕获留本地" |
| `kg_model` / `kg_api_key` | 空 | 图谱模型/Key（留空复用 LLM 配置） |
| `kg_synonyms` | `{}` | 实体同义词归一表（`{"李工":"小李"}`），跨记忆消歧 |
| `dedup_enabled` | `true` | 写入相似度合并开关 |
| `dedup_threshold` | `0.92` | 合并阈值（0.7~1.0） |
| `recency_enabled` | `true` | 检索时序衰减加权 |
| `capture_watch_enabled` | `false` | 文件监听自动捕获 |
| `capture_watch_path` | 空 | 监听文件/目录 |
| `capture_min_chars` | `20` | 启发式单句最小长度 |
| `capture_keywords` | 空 | 关键词过滤（空=不过滤） |
| `capture_max_per_call` | `20` | 单次捕获最大条数 |
| `verify_enabled` | `true` | 虚假完成检测开关（v1.19.0） |
| `verify_base_url` | 空 | endpoint 验证基址前缀（v1.19.0，如 `http://192.168.110.128:8765`） |
| `ssrf_protection` | `true` | SSRF 防护开关：拦截 webhook/reranker 出站到内网 IP（v1.20.0） |
| `ssrf_allowlist` | `["127.0.0.1","localhost"]` | SSRF 白名单 IP/域名（v1.20.0） |
| `quality_auto_enabled` | `true` | 记忆质量自动化开关：过期检测+矛盾修复+置信度衰减（v1.20.0） |
| `stale_fact_days` | `180` | 事实过期天数阈值（v1.20.0） |
| `confidence_decay_days` | `90` | 置信度衰减起始天数（v1.20.0） |
| `confidence_decay_rate` | `0.05` | 置信度衰减速率（v1.20.0） |
| `search_cache_enabled` | `true` | 搜索结果 LRU 缓存开关（v1.20.0） |
| `search_cache_ttl_ms` | `60000` | 搜索缓存 TTL 毫秒（v1.20.0） |
| `search_cache_max` | `200` | 搜索缓存最大条目数（v1.20.0） |
| `suggest_related` | `true` | 记忆关联推荐开关：add_memory 返回 related_suggestions（v1.20.0） |
| `suggest_related_limit` | `5` | 关联推荐返回条数（v1.20.0） |
| `llm_proxy_enabled` | `false` | LLM 代理旁路总开关（v1.23.0）：开启后 `/llm/v1/chat/completions` 转发真实 LLM 并自动捕获整段对话 |
| `llm_proxy_url` | 空 | 代理上游 LLM 地址（留空=复用 `llm_url`；支持以 `/v1` 结尾，自动补 `/chat/completions`） |
| `llm_proxy_model` | 空 | 代理默认模型（请求带 `model` 时以其为准） |
| `llm_proxy_api_key` | 空 | 代理上游 API Key（留空=复用 `llm_api_key`） |
| `llm_proxy_auto_capture` | `true` | 代理响应后是否自动把整段对话入库（v1.23.0） |
| `llm_proxy_capture_project` | 空 | 自动捕获归属的项目（缺省经 `X-Project-Path` 头 / `?project=` 覆盖；scoped key 作用域优先） |
| `llm_proxy_user` | `assistant` | 自动捕获时记忆的归属来源（v1.23.0） |

> `api_key` 在 `/api/config` 返回中被掩码为 `******`；保存时仅当值不为 `******` 才更新（掩码不会覆盖真值）。

---

## 九、管理界面与自测按钮

打开 `http://<服务器IP>:8765/admin`：

### 1. 数据库（Qdrant）
- **「测试 Qdrant 连接」**：`GET /collections/{collection}` 连通 → `count` 报点数。集合不存在时返回错误详情便于核对。连不上返回错误详情。

### 2. 嵌入 / 向量模型
- **「测试嵌入模型」**：发探针文本，验证端点连通并回报**向量维度**（如 `✅ 连通，向量维度 1024`）。

### 3. 自动捕获（LLM）
- **「测试捕获 LLM」**：发一句请求，验证模型有响应。

### 4. 知识图谱抽取
- **「测试图谱抽取」**：发抽取 prompt，验证返回是否合法 JSON；非严格 JSON（本地小模型常见）会提示换更强模型（如 `qwen3.5:9b`）。

**先测后存**：测试时直接用表单当前填的端点 / 模型名 / key，没填才回退已保存配置。key 框显示 `******`（已保存）时不参与测试，自动用服务端已存的 key，不会把 `******` 当真 key 发出去。

**本地 vs 云端**：嵌入 / 捕获 / 图谱三处 API Key 框均标注「云端才填，本地留空」。本地（Ollama / llama-embed）留空即无鉴权；云端填 key 自动带 `Bearer`。图谱另有独立 `kg_url` 框（留空＝复用捕获 LLM 端点）。

---

## 十、MCP 工具清单

| 工具 | 说明 |
|------|------|
| `add_memory` | 存入一条记忆；`dedup_enabled` 开启且能算向量时，相似内容合并（`merge:false` 强制新增） |
| `search_memories` | 检索；`mode`=keyword/semantic/hybrid；`from`/`to` 时间窗；`recency` 加权 |
| `list_memories` | 列出记忆（支持过滤） |
| `get_memory` / `update_memory` / `delete_memory` | 单条读取/编辑/删除（编辑会重算向量与图谱） |
| `capture_memory` | 自动捕获：有 LLM 则智能提取，否则启发式按句切分；支持 `text` 或 `messages:[{role,content}]` 两种入参 |
| `related_to` | 知识图谱：某实体的相连实体（含关系类型、次数）+ 来源记忆 |
| `graph_query` | 知识图谱：涉及某实体的原始实体/关系子图 |
| `path_between` | 知识图谱：两实体间关系路径（BFS），不相连返回 `path:null` |
| `conclude_session` | 结束会话：工作记忆 promote 到长期库，并用 LLM 总结后存入（修复原会话摘要丢失 bug） |

### v1.16.0 新增工具（记忆"更好用"增强，共 13 个）

| 工具 | 说明 |
|------|------|
| `recall_for_context` | **#87 上下文回忆**：从消息数组提炼查询并检索，给 LLM 当前上下文喂相关记忆（语义/关键词回退） |
| `resume_state` | **#88 会话续接**：拉近期记忆，LLM 生成 `{summary, threads}` 续接状态（无 LLM 回退近期清单） |
| `detect_contradictions` | **#89 矛盾检测**：向量余弦（无向量则 jaccard）找相近记忆，LLM 判定矛盾；`check_contradictions` 可在写入时 opt-in 阻断冲突 |
| `memory_health` | **#90 健康度**：重复/未打标/到期/低置信综合打分 + 改进建议（复用 insight 层） |
| `prune_memories` | **#91 修剪**：默认 dry-run 列出重复/低价值候选；`confirm=true` 才删除 |
| `merge_memories` | **#91 合并**：取多条记忆 LLM 综合内容、标签并集，主项保留、其余删除 |
| `export_memories_markdown` | **#92 Markdown 导出**：按 project/tag/category/date 分组导出为 Markdown（MCP 资源同款） |
| `watch_tag` / `unwatch_tag` / `list_watches` | **#94 标签订阅**：订阅 tag 命中时向 Webhook URL 推送（落 kv_store，幂等） |
| `schedule_recall` / `due_recalls` | **#95 间隔召回**：安排"N 天/小时后复习"（支持负区间=立即到期），到期批量取出 |
| `digest` | **#96 周期摘要**：按 day/week/month 拉记忆，LLM 生成 `{summary, highlights, themes}` |

> v1.16.0 同时引入 **MCP Resources**（能力 `resources:{}`）：`memory://all`（近期 JSON）、`memory://project/<encoded>`（项目记忆，支持 `/markdown`、`/json`）、`memory://memory/<id>`（单条 JSON），供支持 Resources 的客户端浏览/读取。
>
> 多模态记忆（原规划的 ⑦⑧）本期**未做**，留待后续独立批次。

### v1.17.0 新增工具（记忆"更好用"++ 增强，共 11 个）

| 工具 | 说明 |
|------|------|
| `scheduler_status` | 查看后台扫描调度器状态（最后运行时间/历史） |
| `list_watch_dead` / `retry_watch_dead` | 列出/重发标签订阅死信队列中的失败通知 |
| `list_archived` / `archive_memories` / `restore_archived` | 冷记忆二级存储：列出/归档（默认 dry-run）/恢复 |
| `export_memory_text` | 多格式导出：markdown/jsonl/obsidian/cards |
| `scheduler_status` | 调度器状态查询（v1.17 新增后台扫描） |

> v1.17.0 同时引入 **MCP Prompts**（能力 `prompts:{}`）：`summarize_project`、`find_contradictions`、`weekly_digest`、`export_markdown`。传输层升级至 **Streamable HTTP**（SDK v1.29.0 内置），单端点 `/mcp` 支持 POST/GET/DELETE + 同源防护。

### v1.18.0 新增工具（系统增强，共 3 个）

| 工具 | 说明 |
|------|------|
| `create_backup` | 创建整目录备份（tar.gz 到 backup_path），可加标签 |
| `list_backups` | 列出已创建的备份记录 |
| `restore_backup` | 从备份文件恢复整目录（危险操作） |

> v1.18.0 同时引入 **并发请求队列**（`lib/queue.js`，可配置单 GPU 串行/多 GPU 并行）、**分析面板**（admin.html Dashboard tab）、**文档站点**（`docs/` 目录）。

### v1.19.0 新增工具（虚假完成检测闭环，共 3 个）

| 工具 | 说明 |
|------|------|
| `run_verification` | 手动触发一次虚假完成全量检测：扫描带 `promise`/`impl-done`/`completed` 标签的记忆，验证 `file:`/`commit:`/`endpoint:` 证据，失败的自动创建 `fix-needed` 修复任务，已修复的标记 `verified` |
| `list_fix_needed` | 列出所有待修复的虚假完成（`fix-needed` 标签），支持 `project` 过滤和 `limit` |
| `resolve_fix` | AI 修复后调用，将记忆标签从 `fix-needed` 改为 `fixed`，下次验证通过则自动标记 `verified` |

> v1.19.0 引入 **虚假完成自动检测闭环**（`lib/verify.js`）：调度器周期性扫描"声称已完成"的记忆 → 验证证据（文件存在性 / git commit / HTTP 端点 404）→ 失败则自动创建 `fix-needed` 修复任务 → AI 轮询发现 → `resolve_fix` 标记 → 下次扫描自动重验。这是记忆系统从"被动存储"走向"主动质量保证"的关键能力——当 AI 声称完成但实际没做时，系统自动检测、派发修复任务、修复后自动重验。

### v1.20.0 新增工具（记忆质量+安全+性能+关联推荐，共 3 个）

| 工具 | 说明 |
|------|------|
| `list_conflicts` | 列出所有待修复的记忆矛盾任务（`conflict-task` 标签），供 AI 轮询发现并处理 |
| `resolve_conflict` | AI 处理完矛盾后调用，标记为已解决（移除 `conflict-task`/`fix-needed` 标签、加 `resolved`） |
| `run_quality_scan` | 手动触发一次记忆质量扫描（过期事实检测 + 矛盾主动修复 + 置信度衰减） |

> v1.20.0 同时引入 4 大增强（无新依赖）：**② SSRF 防护**（`lib/util.js` 新增 `isPrivateIP`/`safeFetch`/`checkSSRF`，webhook 与 reranker 出站 URL 拦截内网 IP，`ssrf_allowlist` 白名单）；**③ 记忆质量自动化**（`lib/quality_auto.js` 新模块——过期事实检测 + 矛盾主动修复 + 置信度自然衰减，由 scheduler 周期性驱动）；**④ 性能优化**（批量嵌入 `embedBatch` + 搜索结果 LRU 缓存 + Qdrant payload 索引 12 字段）；**⑥ 记忆关联推荐**（`add_memory` 写入成功后返回 `related_suggestions` 字段，基于向量邻近 + 实体共现 + 标签交集综合排序）。

---

## 多工具 / 多客户端接入（快速接入指南）

> 完整客户端配置片段、Hook 模板、stdio 桥接器用法见 **[`docs/integration.md`](./docs/integration.md)**。本节是速览。

### 传输与端点

| 传输 | 端点 | 用途 |
|------|------|------|
| **MCP · SSE** | `http://<host>:8765/sse?key=<api_key>` | Cursor / Cline / Roo / Windsurf 等大多数工具 |
| **MCP · Streamable HTTP** | `http://<host>:8765/mcp?key=<api_key>` | Zed / VS Code Copilot / Claude Code |
| **MCP · stdio** | `node lib/stdio_bridge.js --endpoint <sse-url> --project <工作区路径>` | opencode / Claude Code 本地模式（零依赖，自动注入 project） |
| **REST** | `http://<host>:8765/api/*` | 脚本 / 无 MCP 的工具（心跳、批处理） |

- 工具命名：`add_memory` / `search_memories` / `list_memories` / `delete_memory` / `capture_memory` / `related_to` 等。
- **项目隔离（scope）**：调用方传 `project` = 当前工作区路径（如 `D:\project\ai-memory`），同一文件夹跨会话归同一 project；stdio 桥接器可用 `--project` 连接级兜底。

### capture_memory 的两种入参

- `text`（字符串）：原始对话 / 笔记 / 转录原文。
- `messages`（数组，**优先**）：结构化对话，每项 `{ role: 'user'|'assistant'|'system', content: '...' }`。服务端自动拼接为带角色标签的转写文本（如 `USER: ...\nASSISTANT: ...`）后送入抽取管线，LLM 抽取质量更高。
- REST 等价：`POST /api/capture` 的 body 同样接受 `text` 或 `messages`，整包透传为 scope。

### LLM 代理旁路（无感自动记忆，推荐）

把 ai-memory 当作 OpenAI 兼容的 LLM **前置代理**，宿主客户端无需任何指令、无需改代码，对话即被自动高质量入库——这正是"用户提问 + 智能体回答被智能分析、高质量存储，且用户与 agent 都无感"的终态。

- **怎么做**：客户端把 LLM `base_url` 从真实 LLM 改为 `http://<host>:8765/llm/v1`（API key 仍为 ai-memory 的 `api_key`）。
- **发生了什么**：`POST /llm/v1/chat/completions` 透明转发到真实 LLM（`llm_proxy_url` 或复用 `llm_url`），非流式返 JSON、流式(`stream:true`) 透传 SSE；**响应结束后**，服务端把整段对话 `[...请求messages, {role:'assistant',content:回复}]` 作为 `messages` 数组自动交给 `capture` 抽取管线入库——用户提问 + 助手回答一起被语义提炼、去重合并。
- **项目归属**：默认用配置 `llm_proxy_capture_project`；也可在每次请求带 `X-Project-Path: <工作区路径>` 头（或 `?project=`）按工作区隔离；使用 scoped key 时强制落到该 key 的 project。
- **开关与配置**（详见「配置项详解」与 `config.example.json`）：`llm_proxy_enabled`(总开关) / `llm_proxy_url` / `llm_proxy_model` / `llm_proxy_api_key` / `llm_proxy_auto_capture`(默认开) / `llm_proxy_capture_project` / `llm_proxy_user`。
- **优雅降级**：上游 LLM 不可达时透传错误状态码与正文，不伪造回复；本代理只做转发 + 旁路捕获，不合成回答。
- **适用场景**：WorkBuddy / opencode / 任意 OpenAI SDK 客户端——只要能把 `base_url` 指向 ai-memory，就立刻获得「无感自动记忆」，且宿主零改动、AI 不显式触发。

### 让记忆"自动用起来"的驱动方式

**首选：LLM 代理旁路（见上节）**——把 `base_url` 指向 `/llm/v1` 即无感自动，宿主零改动、AI 不显式触发，用户与 agent 都无感。它绕开了"需要 AI 主动调用 capture 才能落库"的根本假设：对话本身即触发。

若客户端无法改 LLM `base_url`（如部分仅支持 MCP、且不能换 LLM 端点的工具），则用以下三种客户端驱动作为替代：

1. **规则文件驱动（跨工具通用底座）**：项目根 `AGENTS.md` / `CLAUDE.md` / `.cursorrules` 写明"遇决策就 add/capture_memory"，AI 在对话中主动调用——几乎所有支持 MCP 的工具都会加载它。
2. **Claude Code Hooks**：`SessionStart` / `Stop` 钩子在会话边界触发 `curl` 调 `capture_memory` / `/api/capture`（详见 integration.md 第五节；hook 拿不到对话文本，仅做心跳兜底）。
3. **WorkBuddy 客户端**：WorkBuddy 加载项目 `AGENTS.md` / 系统指令即可驱动 AI 在收尾时主动调用 `capture_memory`（指令模板见 integration.md 第八节）；也可用「自动化（定时）」做轻量归档 / 心跳兜底（注意自动化是定时触发、非会话边界）。

> 关键：**除 LLM 代理旁路这种"对话即触发"的路径外**，MCP / REST 协议与 capture 管线本身不会在 AI 不调用时自动落库——其余场景记忆要"自动用起来"，仍需客户端（规则文件 / Hook / 自动化）主动调用 `capture_memory` 或 `/api/capture`。

## 十一、版本

- **v1.23.0**：新增 **LLM 代理旁路（无感自动记忆）**。**核心**：ai-memory 暴露 OpenAI 兼容的 `POST /llm/v1/chat/completions`（+ `GET /llm/v1/models`），客户端把 LLM `base_url` 指向 `/llm/v1` 即自动开启——代理透明转发真实 LLM（非流式返 JSON、流式透传 SSE），**响应结束后把整段对话 `[...请求messages, {role:'assistant',content:回复}]` 自动交给 `capture` 抽取管线入库**，用户提问+助手回答被一起语义提炼、去重合并。宿主零代码改动、AI 不显式触发，真正实现"无感自动记忆"。支持 project 推断（`X-Project-Path` 头 > `?project=` > 配置默认 > scoped key 作用域）、上游故障优雅降级（透传错误、不伪造回复）、`llm_proxy_*` 七大配置项。补 `lib/llm_proxy.js`，接入 `lib/rest.js` 路由与 `/api/config` 白名单/掩码、`/api/docs`、Prometheus 指标；README 与 `config.example.json` 同步。

- **v1.22.3**：多工具接入增强（#2/#4/#150，零新依赖）。**① `capture_memory` 支持 `messages` 数组入参**：每项 `{role, content}`，与 `text` 二选一或并存（messages 优先），服务端统一在 `captureText` 内拼接为带角色标签的转写文本后送入既有抽取管线；REST `POST /api/capture` 透传 body 同步获得该能力，`text` 不再强制必填。**② WorkBuddy 客户端接入模板**（`docs/integration.md` 第八节）：给出「系统指令模板（驱动 AI 收尾时主动 capture）+ 定时自动化心跳兜底」两种落地方式。**③ 新增「多工具 / 多客户端接入」README 章节**：速览 MCP(SSE/HTTP/stdio) / REST / stdio_bridge / Claude Code & WorkBuddy Hook / `messages` 入参等全部接入路径，与 `docs/integration.md` 详参互补。

- **v1.22.2**：修复 project 含反斜杠时 Qdrant 过滤失效。**根因**：Qdrant keyword `match.value` 无法匹配含反斜杠字符串，Windows 工作区路径（如 `D:\project\ai-memory`）作 project 过滤值整体失配，导致 `doList`/`doSearch` 的 `count` 与 `rows` 不一致。**修复**：新增 `backend.normalizeProject`，在写入（doAdd/doUpdate/importMemories/capture）与查询（qdrantFilter/dedupFind/listWorkingMemory/exportMemories/rest 直查）两侧统一将反斜杠归一为正斜杠；`qdrant.count` 改 `exact:true` 返回真实过滤总数。**迁移**：`scripts/migrate_project_slashes.js` 一次性归一化 Qdrant 与本地 SQLite 镜像存量数据（128 已执行：Qdrant 6 点 + SQLite 25 行）。

- **v1.22.1**（历史热修复版本）：Embedding 冷启动 + 去重 + 过期清理 + 真实计数。**① Embedding 重试与冷启动预热**（`lib/embed.js` `_embedRemote`）：新增指数退避重试（首次失败自动重试 2 次，超时 60s→90s→120s 渐进），`warmupEmbedding()` 服务启动时 fire-and-forget 预热 embedding 模型。`embedding_timeout_ms` 默认值从 30s 提升至 60s。**② Exact-content 前置去重**（`lib/memory.js` `doAdd`）：在向量去重之前，先基于 `content_hash` 查 SQLite 精确匹配（不依赖 embedding），嵌入失败导致的重复写入被彻底阻断（确认 128 上 24 组共 69 条重复已清理）。**③ Scheduler 自动过期清理**（`lib/scheduler.js` `scanOnce`）：接入 `lifecycle.cleanupExpired()`，新增 `auto_cleanup_enabled` 配置（默认 true），每次 scheduler 轮巡自动清理过期记忆。**④ List 接口真实总数**（`lib/memory.js` `doList` + `lib/rest.js` 响应）：`GET /api/memories` 的 `count` 字段从「分页行数」修复为 Qdrant `count`/SQLite `COUNT(*)` 真实匹配总数。**⑤ 128 运维配置**：远程启用 `auto_backup_interval_hours=24` 定时备份 + `auto_cleanup_enabled=true` 自动清理。**⑥ 数据清洗**：128 上 98 条已过期记忆已清理 + 24 组 69 条重复冗余已删。回归 82/82 fail=0。

- **v1.22.0**：操作审计 + Qdrant 运行时降级双批次（无新依赖）。**审计侧 ① 全局审计路由**：新增 `GET /api/audit`，支持 `op`/`user`/`project`/`trigger` 过滤 + `limit`/`offset` 分页，返回 `{rows,total}`，补齐「谁、何时、对哪条记忆做了什么」的全局可追溯视图（此前仅有单条记忆 history 与 CORRECT 查询，无全局审计流）。**② admin 操作审计 Tab**：新增「操作审计」页（按操作类型 ADD/UPDATE/DELETE/PIN/UNPIN/CORRECT + 项目过滤），展示时间、记忆 ID、用户、来源与变更摘要（DELETE 显示删除前内容、PIN/UNPIN 标记固定动作）。**③ PIN/UNPIN 专属记录**：`doUpdate` 在 patch 仅含 `pinned` 时记 `PIN`/`UNPIN` op（此前混为 `UPDATE`），语义清晰可检索。**④ audit_enabled 开关**：`lib/config.js` 新增 `audit_enabled`（默认 true），关闭后 `recordChangelog` 静默跳过，满足合规关停需求。**降级侧 ⑤ Qdrant 运行时可达性探测**：此前「`qdrant_url` 已配置但运行期挂了」只会静态信任配置、写入仍走 Qdrant 路径导致失败，降级名存实亡。`lib/qdrant.js` 新增 `isReachable()` 状态缓存（由 `health()` 更新），`lib/memory.js` 的 `Q()` 改为「配置存在 **且** 运行期可达」才走 Qdrant；`/api/health` 的 `store` 字段据实填 `qdrant`/`sqlite`、`qdrant_connected` 据实填 `true`/`false`（此前仅看配置）；`startServer()` 起每 30s 探针刷新可达性。**⑥ 全局请求限流（P1-3）**：新增零依赖内存固定窗口限流（`lib/rest.js` 全局 `onRequest` 钩子，按客户端 IP 计数），默认 `rate_limit_max=300`/分钟/`rate_limit_window_ms=60000`——宽松到不影响正常多智能体并发，但能挡住失控洪水；`0`/负即关闭。故意绕过早期 `@fastify/rate-limit` 全局化时的 ECONNRESET 回归路径（受保护路由的 `@fastify/rate-limit` 60/min 仍保留为第二层）。`/api/health`、`/metrics`、`/api/docs`、`/docs`、`/admin` 自动豁免（运维探针不被自身限流）。超限返回 `429` + `Retry-After` 头。admin「⚙️ 高级与安全」新增「🆕 全局请求限流」控件（限额/窗口），`POST /api/config` 白名单与 `/api/docs` 配置字段同步补齐。配置项新增 2 个：`rate_limit_max`、`rate_limit_window_ms`（加在 `audit_enabled` 之后，共 3 个新配置项）。**⑦ 备份恢复端到端测试（P1-4）**：新增 `test/backup_restore.js`——写入一批记忆 → `POST /api/backup` 落盘 → `DELETE /api/memories/filter` 清空 → `POST /api/backups/restore` 恢复 → 断言数据完整回来（计数复原）。自包含（SQLite 模式 + 临时 backup 目录），本地与 128 均可独立跑；补齐此前仅 `io.js` 覆盖 `/api/backup`/`/api/import`、缺「删除后恢复」闭环验证的缺口。端到端验证：`node test/run.js`（新增 `test/audit.js` 11/11、`test/fallback.js` 9/9、`test/rate_limit.js` 6/6、`test/backup_restore.js` 11/11；backup_restore 确认备份→删除→恢复计数 3→0→3）。注：`audit_enabled`/`rate_limit_*` 为生产代码改动（经 deploy.js 上 128 验证）；`backup_restore.js` 仅新增测试，验证的是 v1.21.0 既有备份/恢复接口。

  **P2 批次（检索质量 + 多客户端漂移）**：**⑧ 检索质量评估集（P2-5）**：新增 `test/retrieval_quality.js`——定义「golden query + 期望命中记忆 + 干扰项」评估集（数据库持久性 / TCP 握手 / 前端虚拟 DOM 三个主题，各 1 目标 + 5 干扰），Qdrant 下用转述问句做混合检索、断言目标排名严格优于全部干扰项且进 top-3（相关性排序质量门），SQLite 下降级为关键词召回断言；评估记忆写入独立项目、结束全量清理，避免污染共享 Qdrant。**⑨ 多客户端配置漂移检测（P2-6）**：新增 `GET /api/config/public` 公开连接契约端点（仅含非密连接信息与「密钥是否存在」布尔标志，绝不回传任何密钥明文/掩码——专供多客户端互操作性校验），配套 `scripts/config-drift.js` CLI（对比 `server:<url>` / `file:<path>` 多源，支持 config.json 与 MCP server 定义 `mcpServers` 两种形态，输出漂移矩阵、发现漂移非零退出，CI 友好），新增 `test/config_drift.js` 守护「公开契约零密钥泄漏」红线。**⑩ CI + 覆盖率（P2-7，本次暂缓）**：CI 工作流（`.github/workflows/test.yml`）与 `c8` 覆盖率依赖按用户决策**暂不纳入本版本**（已删除 test.yml、回退 `package.json` 的 `c8` devDep 与 `coverage`/`test:ci` script，`version` 保留 1.22.0）。本地快速验证子集 `test/ci.js` 仍保留为 gitignored 本地工具（仅跑 SQLite 降级可验证用例）；日后若启用 CI，需放宽「测试不入库」约定并重建 `test.yml` 与所需 `test/` 用例。

- **v1.21.0**：配置管理+运维增强批次（P0-P5，6 项改进，无新依赖）。**P0 webhook_secret 签名**：`lib/webhook.js` 终于消费 `webhook_secret` 配置（之前是空功能），出站 POST 做 HMAC-SHA256 签名，带 `X-Signature: sha256=...` header。**P1 config_fields 文档补全**：`/api/docs` 配置表从 ~46 项补全至与真实 CONFIG 对齐（补齐 `capture_min_chars`、`kg_max_entities`、`source_trust_weights`、`reconcile_enabled` 等 25+ 项），修复 `reranker_enabled` 不存在键的错误。**P2 salience 权重可配置**：`salience_w_imp/w_acc/access_k/score_w` 4 个评分常量从硬编码改为 config.json 可调（admin 高级页面 UI + loadConfig/saveConfig + POST 白名单 + `intelligence.js` 消费处同步更新）。**P3 定时备份和管理面板**：SQLite `backups` 记录表 + `GET /api/backups`/`POST /api/backups/restore`/`GET /api/backups/download/:name` 管理接口 + admin 数据页备份面板（一键备份/列表/下载/恢复）+ scheduler 定时备份（`auto_backup_interval_hours` 配置，默认 0=关）。**P4 标签管理器**：`GET /api/tags`（频率列表）+ `POST /api/tags/rename`（重命名）+ `POST /api/tags/delete`（删除），跨所有记忆同步操作。**P5 运维监控面板**：配置页新增「📊 运维」子标签——搜索缓存命中率/未命中/条数 + scheduler 最近 15 次执行历史（时间、状态、健康、到期、矛盾、自动备份）。配置项新增 9 个：`salience_w_imp`/`salience_w_acc`/`salience_access_k`/`salience_score_w`/`auto_backup_interval_hours`。回归 82/82 fail=0。

- **v1.20.0**：记忆质量+安全+性能+关联推荐批次（4 大增强，无新依赖）。**② SSRF 防护**：`lib/util.js` 新增 `isPrivateIP`（IPv4/IPv6 内网地址段检测）、`safeFetch`（异步版，DNS 解析后拦截）、`checkSSRF`（同步版，用于 webhook `http.request` 模式）；webhook（`lib/webhook.js`）与 reranker（`lib/memory.js` `_rerank`）出站 URL 统一检查，拒绝内网 IP；管理员配置的内部服务（embedding/llm/qdrant）不走检查。`ssrf_allowlist` 白名单（默认 `['127.0.0.1', 'localhost']`）。**③ 记忆质量自动化**：新模块 `lib/quality_auto.js`——`scanStaleFacts`（扫描 fact/preference/decision 标签记忆，LLM 判定或启发式判断是否过时，打 `stale` 标签）、`repairContradictions`（复用 `maintain.detectContradictions` 检测矛盾，发现后创建 `conflict-task` 修复任务记忆）、`decayConfidence`（长期未访问记忆 confidence 递减，`confidence -= decay_rate * (days_idle / decay_days)`）；由 `lib/scheduler.js` `scanOnce()` 周期性驱动，失败静默不影响主流程。MCP 新增 3 个工具（`list_conflicts`/`resolve_conflict`/`run_quality_scan`）。**④ 性能优化**：(a) 批量嵌入——`lib/embed.js` 新增 `embedBatch(texts)`，先查缓存再批量请求远端，`lib/memory_lifecycle.js` `batchAdd` 改为先批量嵌入再逐条写入（通过 `_embedding` 属性传入 `doAdd`）；(b) 搜索结果 LRU 缓存——`lib/memory.js` `_searchCache` Map，TTL 60s，`bus.on('memory-changed')` 触发全量失效；(c) Qdrant payload 索引——`lib/qdrant.js` `ensureIndexes()` 为 12 个高频过滤字段（user/project/session/tags/type/memory_type/mem_category/content_hash/pinned/expires_at/updated_at/next_review_at）建 keyword/datetime/bool 索引，启动时幂等调用。**⑥ 记忆关联推荐**：`lib/memory.js` `doAdd` 写入成功后，如果 `suggest_related !== false` 且有有效嵌入，调用 `_suggestRelated` 基于向量邻近（Qdrant query 或 SQLite cosine）+ 实体共现 + 标签交集综合排序，返回 `related_suggestions: [{id, content, score, reason}]`。配置项新增 11 个：`ssrf_protection`/`ssrf_allowlist`/`quality_auto_enabled`/`stale_fact_days`/`confidence_decay_days`/`confidence_decay_rate`/`search_cache_enabled`/`search_cache_ttl_ms`/`search_cache_max`/`suggest_related`/`suggest_related_limit`。

- **v1.19.0**：虚假完成自动检测闭环。新增 `lib/verify.js` 模块——调度器周期性扫描带 `promise`/`impl-done`/`completed` 标签的记忆，逐一验证证据（`file:`→`fs.existsSync`、`commit:`→`git log --oneline`、`endpoint:`→HEAD 请求检查 404）；验证失败的记忆自动打 `fix-needed` 标签并创建修复任务（内容记录失败原因与缺失证据）；AI 轮询 `list_fix_needed` 发现待修复项 → 修复后调 `resolve_fix` 标记为 `fixed` → 下次扫描自动重验，通过则标记 `verified`。MCP 新增 3 个工具（`run_verification`/`list_fix_needed`/`resolve_fix`）。`lib/scheduler.js` `scanOnce()` 中集成 `verify.scanAndCreateFixes()` 调用。配置项新增 `verify_enabled`（默认 true）、`verify_base_url`（用于 endpoint 验证的基址前缀）。核心价值：当 AI 声称完成但实际没做时，系统自动检测、派发修复任务、修复后自动重验——记忆系统从被动存储走向主动质量保证。回归 80/80 fail=0。

- **v1.18.0**：系统增强批次（6 项）。**④ 并发队列**：`lib/queue.js` 泛化 `RequestQueue`（FIFO + 可配置信号量），embed/LLM 两独立实例，单 GPU 串行、多 GPU 并行，由 `embedding_max_concurrent`/`llm_max_concurrent`/`queue_max_size` 控制。**⑤ 分析面板**：admin.html 新增「分析面板」tab（Chart.js：记忆量趋势线图 + 标签分布甜甜圈图 + 健康度百分比）。**⑥ 文档站点**：`docs/` 目录（配置指南 + MCP 工具参考 + WorkBuddy 集成指南）。**⑦ MCP 全特性**：声明 `logging` 能力（SDK 自动处理 `SetLevel` + `sendLoggingMessage`）。**⑧ 备份工具**：`lib/backup.js`（`createBackup`/`listBackups`/`restoreBackup`），注册 3 个 MCP 工具。**② WorkBuddy Workflow**：`docs/workflow-integration.md` 开箱用例。回归 80/80 fail=0。

- **v1.17.0**：记忆"更好用"++ 批次（11 项升级）。新增 5 模块：`lib/bus.js`（进程内事件总线，解耦 memory ↔ MCP Resources 实时通知）、`lib/prompts.js`（MCP Prompts 原语——`summarize_project`/`find_contradictions`/`weekly_digest`/`export_markdown`）、`lib/scheduler.js`（后台异步扫描调度器，周期性归档/矛盾检测/健康度）、`lib/archive.js`（冷记忆二级存储，按访问时间/次数判冷，kv 归档/恢复）、`lib/watch.js` 增强（推送重试指数退避 + 死信暂存）。改进：`lib/rest.js` SDK v1.29.0 `StreamableHTTPServerTransport` 替换手搓传输，单端点 `/mcp` + 同源防护 + scoped key；`lib/mcp.js` 工具 44→50+，新增 Prompts/Resources listChanged/事件总线；`lib/embed.js` 嵌入缓存 + `cacheStats()`；`lib/context.js` 混合检索默认 hybrid + 多格式导出；`lib/quality.js` 缓存命中/工具指标。关键修复：`server.notification()` Promise rejection 未 catch 导致进程 crash。回归 82/82 fail=0。多模态记忆（原 ⑦⑧）留待后续批次。

- **v1.16.0**：记忆"更好用"增强批次（10 项非多模态功能，MCP 工具由 31 增至 44）。新增 4 个后端模块：`lib/context.js`（#87 上下文回忆、#88 会话续接、#92 Markdown 导出、#96 周期摘要）、`lib/review.js`（#95 间隔召回）、`lib/maintain.js`（#89 矛盾检测、#90 健康度、#91 修剪/合并）、`lib/watch.js`（#94 标签订阅）。配套：① `lib/memory.js` `doUpdate`/`doAdd` 打通 `next_review_at`（间隔重复调度），`doAdd` 新增 `check_contradictions`/`block_on_conflict` opt-in 矛盾阻断钩子与 `watch` 推送钩子；② `lib/backend.js` 补齐 SQLite 降级路径长期遗漏的 `next_review_at` 列（迁移 + `sqliteAdd` + `rowToDoc` + `payloadToRow` + `sqliteUpdate`），修复 `insight.loadAll` 在降级模式因缺列崩溃；③ 修复 `sqliteSearch` 关键词/混合模式下 LIKE 占位符错配（"Too few parameter values"）的预存 bug；④ 修复 `conclude_session` 把 `chatJSON` 字符串当对象导致会话摘要永不保存的 bug；⑤ `lib/mcp.js` 新增 13 个工具 schema+handler，并新增 **MCP Resources**（`memory://all`、`memory://project/<encoded>`、`memory://memory/<id>`）能力。所有新功能为增量 MCP 工具/钩子，不改 `doAdd`/`doSearch` 核心契约；删除类操作默认 dry-run。多模态记忆（原 ⑦⑧）留待后续批次。

- **v1.15.3**：修复 4 个被早期崩溃掩盖的预存服务端缺陷（端到端测试 `test/run.js` 全过 81 项后暴露）：① **捕获管线偶发断连**——`_httpServer.timeout` 由 30s 调高至 120s，避免 LLM/嵌入推理期间（整段「无数据下发」可达 20~40s）socket 被提前销毁（客户端表现 "other side closed"）；② **`POST /api/correct/:id` 调用不存在的 `correction.correctMemory`**——改为 `correction.doCorrect({target_id, feedback, ...})`；③ **`/api/project-links` 路由调用不存在的 `projects.linkProjects/unlinkProjects`**——改为 `upsertProjectLink/removeProjectLink`，并兼容 `from/to` 与 `from_project/to_project` 两种命名；④ **`util.relEnabled` 把字符串 `'false'` 当作真值**——`include_related=false` 仍会借用跨项目记忆，现已正确归一化。另将端到端验证命令 `API_KEY=my-secret-key-114514 BASE=http://192.168.110.128:8765 node test/run.js` 写入 README 部署章。

- **v1.15.2**：修复「使用帮助」在中文环境下无法加载。根因为帮助容器 `#docs` 自身误挂 `data-i18n="el-93"`，而 `el-93` 仅英文词典有；`MutationObserver` 触发的 `applyLang` 在中文下把刚写入的帮助内容回写为初始占位。移除该 `data-i18n` 后修复（用 jsdom 真机复现确认）。

- **v1.15.1**：修复管理界面整页未上色——`:root` 与 `[data-theme="light"]` 原为 `--x:var(--x)` 自引用占位、无真实颜色值，导致主题切换无效、帮助文字不可见；填入深浅双调色板并将帮助渲染硬编码色改为 CSS 变量；`/api/docs` 的 `config_fields` 由 3 条补全至 28 条，对齐 `POST /api/config` 实际可配项。

- **v1.15.0**：三大增强（Batch D）。① **英文双语**（T7）：全站 i18n；② **主题切换 + 响应式**（T8）：深浅双调色板 + `@media`；③ **智能深化**（T9）：新增 `lib/insight.js`（重复检测 / 标签聚类 / 遗忘曲线）+ 三个只读端点 `GET /api/memories/duplicates`、`GET /api/tags/cluster`、`GET /api/learning/forgetting-curve`，质量监控页加可视化卡片。

- **v1.14.0**：代码清理 + 全面错误可观测 + 性能优化。
  - **② 错误全覆盖**：`errStats` 从 `backend.js` 移至 `config.js`（全模块共享），剩余 54 处 `catch(e){}` 全部接入计数，`/api/health` 的 `err_stats` 含 11 个分类（embed/fts/kg/webhook/bump/changelog/cleanup/capture/backup/config/other）。
  - **① 遗留文件清理**：删除 `test_full.js`、`test_deep.js`、`eval/` 目录、`deploy.sh`、`DEPLOY_REPORT_*.md`、`FEATURE_INTERACTION_REVIEW.md`。
  - **③ 版本号升为 1.14.0**，admin 标题动态显示版本。
  - **⑤ `refreshEntityVocab` 启动懒加载**：启动时不 scrollAll（`rest.js` 不再调 `refreshEntityVocab()`），首次 `queryEntities` 时才全量拉取，平时由 `addEntityVocab` 增量维护。
  - **⑦ Webhook 投递可视化**：admin 质量监控面板新增 "Webhook 投递状态" 卡片，展示最近 10 条投递记录。
  - **⑧ test/README.md** 已同步说明 `unit.js` 不依赖 BASE、其余测试需在 128 完整环境跑。
  - **⑩ README 架构描述同步更新**，`deploy.js` 标注为首选部署工具。端到端验证：`node test/run.js`。

- **v1.13.0**（原版本）：补齐与 Mem0 的**剩余全部差距（10 项，零新依赖）**：
  - **① MMR 多样性重排**：`mmr_enabled`+`mmr_lambda`，`applyMMR` 函数（Jaccard 近似）。末次排序前插入，λ 控制语义 vs 多样性平衡。
  - **② 可插拔 reranker 管线**：`reranker_url` 配置外部 cross-encoder，search/list 走 HTTP 回调精排（失败静默退化）。
  - **③ 记忆固定（pin）**：`pinned` 字段免除过期/衰减/清理。`POST /api/memories/pin`、`POST /api/memories/unpin`，MCP `pin_memory`/`unpin_memory` 工具。
  - **④ 自动压缩引擎**：`auto_compress` 开启后，`captureText` 返回前自动触发非阻塞 `consolidate`（作用于该项目）。
  - **⑤ API 认证**：`api_keys` 数组配置 Bearer token；admin/docs/health/MCP SSE 豁免。
  - **⑥ 导出/导入**：`GET /api/export`（JSON，Qdrant scroll + SQLite 双路径）、`POST /api/import`。MCP `export_memories`/`import_memories` 工具。
  - **⑦ 重置**：`POST /api/reset`（需 `confirm:true` 防误操作）。
  - **⑧ 备份**：`POST /api/backup` 写出 JSON 文件到服务端，路径由 `backup_path` 配置。
  - **⑨ 游标分页**：search/list 响应新增 `next_cursor` 字段（id 定位），便于服务端分页遍历。
  - **⑩ 统计面板**：`GET /api/stats` 返回记忆总量/固定数/过期数/按类别分布（Qdrant count API + SQLite fallback）。
  - **MCP 工具新增**：`pin_memory`、`unpin_memory`、`export_memories`、`import_memories`、`reset_memories`、`backup_memories`、`get_memory_stats`（共 7 个）。
  - **v1.13.0 追加修复（去重可靠性专项）**：(a) 修复 Qdrant `is_empty` 过滤语法错误......端到端验证：`node test/run.js`（新增 `test/dedup.js` 确定性去重用例与 `test/cleanup.js` is_empty 清理分支用例）。
  - **v1.13.0 再追加（全面提优，用户要求除 SSRF 外全做）**：(a) 存量内容哈希回填——`POST /api/reindex` 新增 `content_hash_backfilled` 字段，对全量旧记忆（Qdrant+SQLite 双路径）补算归一化 SHA-1，使精确判重对所有历史数据生效（回填后 `dedup_stats.exact` 计数）。已在 128 执行回填 17 条。(b) `cleanupExpired` 节流——改为每 10 分钟最多执行一次（`_lastCleanupAt` 缓存），避免每次写入都触发 Qdrant count 请求。(c) 全局错误计数 `errStats`——`catch(e){}` 关键处（fts/kg/bump/changelog/cleanup 等）不再静默，改为 `errStats.xxx++` + 可选 `console.error`，`/api/health` 暴露 `err_stats` 对象。(d) `bumpAccess` 限频+分批——60 秒内同一 id 只 bump 一次（`_bumpCache`），Qdrant 路径按 batch=5 并发，避免 N 次独立 HTTP。(e) 纯函数单测——`test/unit.js`（毫秒级，不依赖 BASE），覆盖 `hashContent/cosine/clamp01/sourceTypeOf/normalizeSource/relationDecay/safePath` 共 23 例。(f) 优雅关闭——`process.on('SIGTERM'/'SIGINT')` → `rest.shutdown()`（关闭 HTTP server + 清 `fs.watch`）。(g) `backup_path` 路径校验——`util.safePath()` 确保目标在 ROOT 之下（REST 和 MCP 两处备份入口已绑定）。(h) `deploy.js`——sshtool 自动部署脚本（沙箱友好，统一 tar 打包→put→解压→语法全检→重启→health 确认）。`admin.html` 状态栏新增 `dedup_stats`/`err_stats` 实时显示。(i) 文档已同步（changelog、deploy 说明）。端到端验证：`node test/run.js`（82/82 通过，含新增 `unit.js`）。
  - **配置字段新增**：`mmr_enabled`、`mmr_lambda`、`reranker_url`、`reranker_model`、`reranker_api_key`、`api_keys`、`auto_compress`、`backup_path`。
  - **端到端验证**：见 `node test/run.js`（按功能拆分套件，本地 SQLite 降级模式 `OVERALL ok=25 fail=0`；`correction`/`qdrant_regression` 在完整部署上全过）。
- **v1.12.0**：补齐与 Mem0 的 **4 项差距（零新依赖）**：
  - **① 项目级持久配置**：`project_config` 表 + `projectConfigGet/Set/Delete/List`，支持 `custom_categories`（自定义类别体系）、`extract_instructions`（持久抽取指令）、`criteria`（检索加权准则）、`webhook_urls`（项目级推送端点）。`captureText` 自动注入。REST `GET/PUT/DELETE /api/projects/:project/config`。
  - **② 多主体归属**：`actor_id`/`agent_id`/`run_id` 三维度贯穿 add/capture/search/list/Qdrant 过滤全路径。MCP 全工具 schema 添加。
  - **③ criteria 加权检索**：`applyCriteriaQdrant`/`applyCriteriaSqlite`（进程内嵌入缓存 LRU 100）。`search` 未传 criteria 时自动回退项目级默认。REST `GET /api/memories?criteria=`。
  - **④ Webhooks 事件推送**：`lib/webhook.js`（NEW，零依赖）。Fire-and-forget POST + 失败重试 1 次。事件：`memory.added/updated/deleted/promoted/consolidated`。目标 = 全局 `webhook_urls` + 项目级 `webhook_urls` 合并去重。环形缓冲 50 条投递记录。`GET /api/webhooks/recent` + `get_webhook_recent` MCP 工具。
  - **端到端验证**：见 `node test/run.js`（14/14 通过）。
- **v1.11.0**：一次性补齐与 Mem0 (2026) 的 **8 项能力差距**（零新增 npm 依赖，延续 SQLite 镜像层 + Qdrant 主存储的解耦模式）：
  - **① 记忆分层（working / long + org 作用域）**：新增 `working_memories` 独立缓冲表（不污染 Qdrant/FTS/图谱/审计），`tier='working'` 走独立读写与 TTL（`working_ttl_hours`，默认 24h）；`add_working_memory` / `promote_working_memory` 工具与 `POST /api/working`、`GET /api/working`、`DELETE /api/working/:id`、`POST /api/working/:id/promote`。记忆全表新增 `org` 组织作用域列。
  - **② 结构化类别 + ⑧ 版本化抽取模型**：`extract_version`（`v1`/`v2`）配置；v2 提示词额外抽取 `mem_category ∈ {fact, preference, opinion, event, procedure, skill}`（Mem0 风格），随记忆持久化。
  - **③ KV 精确通道**：`kv_store` 表 + `kv_get`/`kv_set`/`kv_delete` 工具 + `GET/POST/PUT/DELETE /api/kv`，用于「确定性、无需语义检索」的键值事实。
  - **④ 嵌套过滤 DSL + token 用量上报**：`backend.matchFilters`/`_matchLeaf` 客户端谓词，统一覆盖 Qdrant+SQLite 双路径，支持 `{all:[...]}`/`{any:[...]}`/`{not:cond}` 与叶子 `{key,op,value}`（op ∈ eq,ne,gt,gte,lt,lte,contains,in,exists,between），规避 Qdrant 1.18.3 的 `should`/`min_should` 非标准结构；检索/列表响应新增 `usage.tokens` 估算。
  - **⑤ 批量 / 运维操作**：`batch_add_memories`、`delete_memories_by_filter`、`reextract_memory` 工具 + `POST /api/memories/batch`、`DELETE /api/memories/filter`、`POST /api/memories/:id/reextract`。
  - **⑥ 逐调用抽取引导**：`extract_instructions` 贯穿 `capture_memory`/`add_memory` → `captureText` → `extractFacts`/`llmExtract`，可按调用定制抽取重点。
  - **⑦ 评测基准**：`eval/bench_v111.js`（类别准确率 + 嵌套过滤精度 + 去重精度 + KV 往返 + working 提升，输出综合 `score`）。
  - **本版修复的 4 个缺陷**：(a) `ftsRankedCandidates` 在 FTS 未命中时返回 `[]` 导致 `searchProject` 调用 `ftsMap.has(...)` 抛「is not a function」，且使中文关键词检索失效（FTS5 unicode61 无法切分嵌在中文里的拉丁词）——改为返回 `null` 回退子串匹配；(b) `matchFilters` 未识别裸叶子 `{key,op,value}`（被误当普通对象逐 key eq），导致 `delete_by_filter` 传单叶子过滤器时 `deleted:0`——增加叶子识别分支；(c) 事实抽取管线丢弃调用方 `tags`（只留 `auto-captured`），与旧 `doAdd` 路径不一致且致按 tags 过滤落空——改为合并调用方 tags；(d) 评测基准原用 `POST /api/memories`（直存不抽取）测类别，改走 `/api/capture` 并轮询回捞。端到端验证见 `node test/run.js`（14/14 通过），基准 `eval/bench_v111.js`（综合分 ~0.92）。
- **v1.10.0**：补齐与 Mem0 的四项能力差距（零新增 npm 依赖，全部落在 SQLite 镜像层，与主存储 Qdrant 解耦）：① **FTS5 全文索引**（`memory_fts` 虚拟表，`bm25()` 评分）——补齐 Qdrant 无原生 BM25 的短板；`searchProject` 在 `keyword` 模式硬过滤 FTS 命中、`hybrid` 模式对语义候选追加 BM25 boost（`score + fs*0.5`），并回补 FTS 命中的语义候选。② **持久化知识图谱**（`kg_entities`/`kg_relations` 表，聚合跨记忆的实体/关系共现，独立于 Qdrant payload）——新增 `GET /api/kg`（导出）、`GET /api/kg/neighbors`、`POST /api/reindex`（FTS+图谱重建）；admin 新增「聚合图谱 + 全文索引」卡片，力导向可视化。③ **记忆巩固 / 自动压缩**（`memory.consolidate`）——按 `entity_names[0]||tags[0]` 聚类低显著性（confidence<0.7 或 access_count<3）碎片记忆，LLM 归纳为一条 `consolidated` 记忆，原记忆标记 SUPERSEDED（过期）+ `SUPERSEDE` 变更日志；`POST /api/consolidate` 触发。④ **P3 技术债清理**：去重 `dedupFind` 改为显式项目作用域（杜绝跨项目误合并）；实体词表改为增量 `addEntityVocab`（不再每次写入全量 `scrollAll` O(n)）；`doList` 终排改为分数优先（`updated_at` 兜底）。另新增 `POST /api/memories`（此前 REST 层缺写入端点，仅 MCP `add_memory` 存在）。端到端验证见 `node test/run.js`。
- **v1.9.0**：存储后端由 Elasticsearch 切换为 **Qdrant**（向量 + 结构化 payload，过滤/语义检索一体）；ES 已停止，仅在 `qdrant_url` 未配置或无嵌入时降级本地 SQLite。新增 `lib/qdrant.js` 适配器；`backend.qdrantFilter`/`memory.expiredFilter` 规避 Qdrant 1.18.3 的 `should`/`min_should` 非标准结构（改用 `must_not` + 双 `must` 过滤）。修复溯源缺口：每次捕获（`reconcileFact`/`captureText`）统一盖 `source.trigger='capture'` + `captured_at`，`normalizeSource` 空输入不再返回 null。端到端验证见 `node test/run.js`（Qdrant 主存储回归由 `qdrant_regression.js` 覆盖）。
- **v1.8.0**：按功能拆分 `lib/` 模块（config/util/embed/backend/intelligence/projects/graph/facts/memory/capture/correction/quality/diagnostics/rest/mcp），server.js 由单体改为薄入口；新增 B1 用户纠正学习（`correct_memory` 工具 + `POST /api/correct`）与质量监控（`quality.js` + `/api/metrics` + admin 质量监控 Tab）。
- **v1.7.0**：项目隔离 + 跨项目借鉴 + 溯源。① 项目间强弱关联（`project_links` 表 + `manage_project_link` 工具 + `/api/project-links` 接口），检索/列出时按 `relationDecay(strength)=0.2+0.6*s` 衰减借用关联项目记忆；`include_related` 可逐请求关闭。② 记忆溯源：`normalizeSource` 统一打 `captured_at`/`trigger`，支持 `conversation_id/message_id/url/file/line`；`/admin` 新增「溯源」列与弹窗。修复 `doList` 误用 `hitsToRows([h])` 导致 500、跨项目 `include_related` 覆盖在 ES 路径不生效。
  - **v1.7.0 追加修复（功能互查）**：③ `doList` 跨项目记忆此前只对主项目记忆赋基准分、关联记忆未乘 `relationDecay` 且因走 `bool.filter` 查询 `_score` 恒为 0 导致衰减成空操作——现已统一主=1/关联=decay 基准分，列表视图关联记忆稳定排在后面。④ 生命周期清理（`cleanupExpired`/`purgeMemories`）原只按 `updated_at` 删，过期 session/TTL 记忆被隐藏却永不删除（索引膨胀、且被合并更新的过期记忆逃过清理）——改为同时按 `expires_at<now` 删除。⑤ 跨项目借鉴的 `bumpAccess` 耦合：原 `doSearch` 对所有返回记忆（含借来的）做访问强化，导致在 A 项目检索会刷新 B 项目记忆的 `last_accessed_at`、使其常驻新鲜——现只强化主项目记忆（`!r.related_project`）。端到端验证见 `node test/run.js`（Qdrant 主存储回归由 `qdrant_regression.js` 覆盖）
- **v1.6.0**：记忆分类 `memory_type`（user/agent/session，与 `scope`/`category` 正交）+ `salience` 强化评分（`0.5*重要性 + 0.5*访问强化`，搜索命中回写 `access_count`/`last_accessed_at`）；时间衰减基准改为 `last_accessed_at`（越回想越巩固）；修复 ES `bool.should` 过滤失效与 `GET /api/memories` 漏解析 `memory_type`
- **v1.5.3**：把 `fact_entities` 兜底扩展到 `doUpdate` 全路径（supplement / contradict 覆盖 / dedup-merge 分支），云端模型在更新与新建场景均不再丢实体（与 doAdd 一致）
- **v1.5.2**：修复云端模型（deepseek v4-flash/pro）`entities` 恒空——强化 `extractFacts` 提示词（entities 标 REQUIRED + 中文 few-shot）+ `reconcileFact` 透传 `fact_entities` + `doAdd` 加事实阶段实体兜底
- **v1.5.1**：`llm_model` 可切更强模型（如 qwen3.5:9b / deepseek v4-pro）；修复 `source` 字符串 vs ES object mapping 冲突致库清空（`normalizeSource`）；中文关系枚举兼容
- **v1.5.0**：补齐与 Mem0 的差距——实体链接加权检索、记忆分类（semantic/episodic/procedural）、Session 自动过期、来源信任治理 + Agent 事实、时序 ADD-only（`preserve_on_conflict`）、评测脚本 `eval/evaluate.js`
- **v1.4.0**：事实抽取管线（`shouldCapture`→`extractFacts`→`judgeRelation`→`reconcileFact`），记忆新增 `type/confidence/access_count/last_accessed_at/expires_at`；修复出站 fetch 无超时卡死 + ES 读路径漏字段
- **v1.3.3**：新增数据库（ES）自测；四个后端均可在 `/admin` 一键测试
- **v1.3.2**：新增嵌入 / 捕获 LLM / 图谱三个后端自测（`POST /api/test-backend` + `testEmbedding/testChat/testKG`）
- **v1.3.1**：本地 / 云端双支持（三个后端各自可选端点 + `api_key`，`authHeaders`/`chatJSON` 统一鉴权）
- **v1.3.0**：知识图谱完整版（实体 / 关系 / 同义词归一 / 跨记忆聚合 / 多跳路径）
- 更早：向量检索 + 去重合并 + 时序感知 + 自动捕获（混合 LLM/启发式）

---

## 许可证

本项目以 **MIT 许可证** 发布，详见 [LICENSE.md](./LICENSE.md)。
