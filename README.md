# ai-memory —— 本地优先的 AI 长期记忆服务

> 一个面向 AI 助手的"长期记忆"后端：把对话、文档片段、知识要点结构化存进 Qdrant 向量库（或本地 SQLite 降级库），用**向量检索 + 关键词召回 + 知识图谱**把"过去说过什么、谁和谁什么关系"随时找回来。支持本地模型与云端模型后端解耦，提供一键自测，并且在每个外部依赖（Qdrant、嵌入模型、LLM、图谱模型）异常时都有明确的降级路径，保证**主写入流程永不被次要能力拖垮**。

---

## 一、这是什么

`ai-memory` 是一套**本地优先（Local-First）**的 AI 记忆系统。它让 AI 助手具备跨会话、跨项目的长期记忆能力，而不是每次对话都从零开始。

- **存储**：默认 Qdrant（`memories` 集合，每条记忆是一个 1024 维向量 + 结构化 payload 文档）；**当 `qdrant_url` 留空（或 `embedding_url` 未配）时自动降级为本地 SQLite 文件库 `memories.db`**（见第四节）。
- **向量化**：本地 `llama-embed`（llama.cpp，OpenAI 兼容 `/v1/embeddings` 接口，跑 `qwen3-embedding:0.6B`）。
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
- 写入时计算新内容与已有记忆的余弦相似度，`>= dedup_threshold`（默认 `0.92`）则**合并**到该记忆：内容覆盖为最新、标签取并集、向量重算、合并时间更新——而不是新增重复条目。
- `add_memory` 工具传 `merge:false` 可强制新增。
- **降级**：去重相似度计算异常时直接返回 `null`，不阻塞写入（见第五节）。

### 2.3 时序感知
- 每条记忆带 `created_at` / `updated_at`。
- 检索时按 `recency` 衰减加权（`applyRecency`）。
- `history`：记忆的演变历史可追溯。
- `lifecycle`：支持过期清理（`cleanupExpired`，按 `updated_at` 早于 cutoff 删除）与显式 `purge`。

### 2.4 自动捕获（混合：LLM 智能提取 + 启发式回退）
两种触发方式：
- **MCP 工具 `capture_memory`** / **REST `POST /api/capture`**：传入原始对话/文本。
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
- `dedupFind()`：相似度查找，失败返回 `null`。
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

- 服务启动时 `try { Database = require('better-sqlite3') } catch { Database = null }`：若 `better-sqlite3` 不可用则 `Database=null`，仍可用 ES；二者皆不可用时存储不可用（健康检查会报错，详见自测）。
- 降级为 SQLite 时，语义（kNN）检索退化为关键词/近似匹配，因为 SQLite 无原生向量索引；但这保证了**无 Qdrant 环境也能先把记忆存下来**。

---

## 五、降级与容错处理（核心设计）

> 设计原则：**主写入链路（把记忆存下来）永不被次要能力（向量化、图谱抽取）的失败打断。** 每个外部依赖都有明确兜底。

| # | 降级点 | 触发条件 | 降级行为 | 是否阻塞主流程 |
|---|--------|----------|----------|----------------|
| 1 | **数据库** | `qdrant_url` 空 / 无嵌入 / Qdrant 不可用 | 自动改用本地 SQLite `memories.db`；二者皆无则存储报错（健康检查可见） | 否（有降级库）/ 是（全无） |
| 2 | **配置加载** | `config.json` 缺失/损坏 | `try/catch` 静默忽略，回落到内置默认值 + 环境变量 fallback | 否 |
| 3 | **嵌入失败** | 嵌入端点不可达 / 超时 / 返回 0 维 | `catch` 后 `doc.embedding` 不赋值，记忆**仍写入**，只是该条不参与语义检索（退化为仅关键词） | 否 |
| 4 | **去重查找失败** | `dedupFind` 异常 | 返回 `null` → 视作无相似记忆 → 直接新增，不合并 | 否 |
| 5 | **知识图谱抽取（开关）** | `kg_enabled=false` 或没有可用 url | `extractGraph` 直接返回 `{entities:[],relations:[],entity_names:[]}` | 否 |
| 6 | **知识图谱抽取（调用）** | LLM 调用失败 / 网络错 / JSON 解析失败 | `catch` 返回空；外层 `attachGraph` 再 `catch` → 实体字段置 `[]` | 否 |
| 7 | **图谱 JSON 包裹** | 模型返回 ` ```json ... ``` ` 围栏 | 先 `strip` 围栏再 `JSON.parse`，兼容不严格输出 | 否 |
| 8 | **自动捕获模式选择** | `llm_enabled && llm_url` | 否则自动走 `heuristic` 启发式 | 否 |
| 9 | **自动捕获 LLM 失败** | `llmExtract` 抛异常或返回非 JSON | `candidates=[]; mode='heuristic'` → 回退按句切分入库 | 否 |
| 10 | **自动捕获单条失败** | 某条 `doAdd` 抛异常 | `skipped++`，其余继续 | 否 |
| 11 | **混合检索许可证** | ES 为 basic 许可证，不支持服务端 RRF | 改用**应用层 RRF**（客户端融合，K=60） | 否 |
| 12 | **检索失败** | ES 查询异常 | 返回 `[]`，不会让上层崩溃 | 否 |
| 13 | **生命周期清理失败** | `cleanupExpired` / `deleteByQuery` 异常 | `catch` 返回 `0`，不影响主请求 | 否 |
| 14 | **MCP 工具异常** | 工具执行出错 | 返回 `{isError:true, content:[{text:'error: ...'}]}` | 否（向上报告） |
| 15 | **文件监听 offset** | `.capture.offsets.json` 读取失败 | 忽略，从头监听（可能重复捕获已处理内容，但会被 dedup 合并） | 否 |
| 16 | **API Key 安全** | `/api/config` GET | `api_key` 掩码为 `******`；POST 仅当值 `!== '******'` 才更新（避免把掩码当真值写回） | 否 |

**关键结论**：在 ES 正常的前提下，即使嵌入服务宕机、LLM 不可用、图谱模型报错，**记忆写入与关键词检索始终可用**。这是系统可用性的底线。

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
| `server.js` | 后端主程序（MCP SSE + Admin + REST，含 `/api/test-backend`、四个测试助手、本地/云端鉴权、全部降级逻辑） |
| `admin.html` | 管理界面（服务启动时读入内存，**改完必须重启服务才生效**） |
| `config.json` | 运行配置（ES 地址、嵌入端点、各 `api_key` 等；部署脚本**不覆盖**此文件） |
| `deploy.sh` | 一键部署脚本（连通性预检 → 备份 → scp → `node --check` → 重启 → 健康检查），`REMOTE` 变量可覆盖目标主机 |
| `LICENSE.md` | MIT 许可证（中文） |
| `memories.db` | （运行时生成）ES 不可用时的本地 SQLite 降级库 |
| `.capture.offsets.json` | （运行时生成）文件监听偏移量，重启续传 |
| `server.js.bak-<时间戳>` / `admin.html.bak-<时间戳>` | 每次部署自动备份，用于回滚 |

> 服务器上路径：`/opt/ai-memory/`，systemd 服务名 `ai-memory.service`。

---

## 八、部署

### 方式一：一键脚本
在 `ai-memory-cloud/` 目录执行（需持有目标主机登录凭证）：
```bash
bash deploy.sh
```
脚本行为：连通性预检 → 备份远端原文件到 `.bak-<时间戳>` → 上传 `server.js` / `admin.html` → 远端 `node --check` → `systemctl restart ai-memory` → 健康检查。只覆盖这两个文件，不动 `config.json`。目标主机由 `deploy.sh` 内的 `REMOTE` 变量决定（默认 `root@192.168.110.128`）。

### 方式二：手动
```bash
scp server.js admin.html root@192.168.110.128:/opt/ai-memory/
ssh root@192.168.110.128 'cd /opt/ai-memory && node --check server.js && systemctl restart ai-memory'
```

### 回滚
```bash
ssh root@192.168.110.128 'cd /opt/ai-memory && \
  cp -f server.js.bak-<时间戳> server.js && \
  cp -f admin.html.bak-<时间戳> admin.html && \
  systemctl restart ai-memory'
```

---

## 九、配置项详解（`config.json`）

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

> `api_key` 在 `/api/config` 返回中被掩码为 `******`；保存时仅当值不为 `******` 才更新（掩码不会覆盖真值）。

---

## 十、管理界面与四个自测按钮

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

## 十一、MCP 工具清单

| 工具 | 说明 |
|------|------|
| `add_memory` | 存入一条记忆；`dedup_enabled` 开启且能算向量时，相似内容合并（`merge:false` 强制新增） |
| `search_memories` | 检索；`mode`=keyword/semantic/hybrid；`from`/`to` 时间窗；`recency` 加权 |
| `list_memories` | 列出记忆（支持过滤） |
| `get_memory` / `update_memory` / `delete_memory` | 单条读取/编辑/删除（编辑会重算向量与图谱） |
| `capture_memory` | 自动捕获：有 LLM 则智能提取，否则启发式按句切分 |
| `related_to` | 知识图谱：某实体的相连实体（含关系类型、次数）+ 来源记忆 |
| `graph_query` | 知识图谱：涉及某实体的原始实体/关系子图 |
| `path_between` | 知识图谱：两实体间关系路径（BFS），不相连返回 `path:null` |

---

## 十二、版本

- **v1.9.0**：存储后端由 Elasticsearch 切换为 **Qdrant**（向量 + 结构化 payload，过滤/语义检索一体）；ES 已停止，仅在 `qdrant_url` 未配置或无嵌入时降级本地 SQLite。新增 `lib/qdrant.js` 适配器；`backend.qdrantFilter`/`memory.expiredFilter` 规避 Qdrant 1.18.3 的 `should`/`min_should` 非标准结构（改用 `must_not` + 双 `must` 过滤）。修复溯源缺口：每次捕获（`reconcileFact`/`captureText`）统一盖 `source.trigger='capture'` + `captured_at`，`normalizeSource` 空输入不再返回 null。端到端验证见 `verify_qdrant_regression.py`。
- **v1.8.0**：按功能拆分 `lib/` 模块（config/util/embed/backend/intelligence/projects/graph/facts/memory/capture/correction/quality/diagnostics/rest/mcp），server.js 由单体改为薄入口；新增 B1 用户纠正学习（`correct_memory` 工具 + `POST /api/correct`）与质量监控（`quality.js` + `/api/metrics` + admin 质量监控 Tab）。
- **v1.7.0**：项目隔离 + 跨项目借鉴 + 溯源。① 项目间强弱关联（`project_links` 表 + `manage_project_link` 工具 + `/api/project-links` 接口），检索/列出时按 `relationDecay(strength)=0.2+0.6*s` 衰减借用关联项目记忆；`include_related` 可逐请求关闭。② 记忆溯源：`normalizeSource` 统一打 `captured_at`/`trigger`，支持 `conversation_id/message_id/url/file/line`；`/admin` 新增「溯源」列与弹窗。修复 `doList` 误用 `hitsToRows([h])` 导致 500、跨项目 `include_related` 覆盖在 ES 路径不生效。
  - **v1.7.0 追加修复（功能互查）**：③ `doList` 跨项目记忆此前只对主项目记忆赋基准分、关联记忆未乘 `relationDecay` 且因走 `bool.filter` 查询 `_score` 恒为 0 导致衰减成空操作——现已统一主=1/关联=decay 基准分，列表视图关联记忆稳定排在后面。④ 生命周期清理（`cleanupExpired`/`purgeMemories`）原只按 `updated_at` 删，过期 session/TTL 记忆被隐藏却永不删除（索引膨胀、且被合并更新的过期记忆逃过清理）——改为同时按 `expires_at<now` 删除。⑤ 跨项目借鉴的 `bumpAccess` 耦合：原 `doSearch` 对所有返回记忆（含借来的）做访问强化，导致在 A 项目检索会刷新 B 项目记忆的 `last_accessed_at`、使其常驻新鲜——现只强化主项目记忆（`!r.related_project`）。端到端验证见 `verify_qdrant_regression.py`
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
