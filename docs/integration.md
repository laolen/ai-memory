# ai-memory 多工具接入指南

> 目标：让 ai-memory（远端记忆 MCP 服务器）能在 **Cursor / Cline / Roo / Zed / Continue / opencode / VS Code Copilot / Claude Code / Windsurf / Cody / Devin** 等主流工具里「装上即用、自动隔离」，无需修改任何工具代码。
>
> 当前运行端点（128）：`http://192.168.110.128:8765`
> 接入密钥：`my-secret-key-114514`（见 `config.json` 的 `api_keys`）
> 支持传输：`SSE`（/sse）、`Streamable HTTP`（/mcp）、`REST`（/api/*）
> 工具命名：`add_memory` / `search_memories` / `list_memories` / `delete_memory` 等

---

## 一、核心机制：记忆怎么"自动"用起来

**重要认知**：MCP 协议本身没有"自动记录"概念。记忆是否被自动使用，取决于**客户端层**。业内有三种自动驱动方式，按可靠性排序：

| 方式 | 机制 | 是否走 MCP | 覆盖工具 |
|------|------|-----------|---------|
| **规则文件驱动** | 项目里的 `AGENTS.md`/`CLAUDE.md`/`.cursorrules` 写明"遇决策就 add_memory"，AI 在对话中主动调工具 | ✅ | 几乎所有工具 |
| **产品内建** | Windsurf Memories / Claude auto-memory / Codex Memories | ❌（写自己存储） | Windsurf/Claude/Codex |
| **Hooks / Plugin / Daemon** | Claude Code Hooks、opencode plugin、后台轮询 | ✅（接我们的 MCP） | Claude Code / opencode |

**我们的策略**：以「规则文件驱动」为跨工具通用底座（第四节），以「Claude Code Hooks」为强自动增强（第五节）。服务端只需保证协议正确、隔离可靠。

---

## 二、项目隔离（scope）约定

记忆按 **project** 隔离。优先级：

1. **调用方传入**（首选）：AI 在 `add_memory` 时传 `project` = 当前工作区路径（如 `D:\project\ai-memory`）。同一文件夹无论开多少会话都归同一 project。
2. **连接级上下文**（可选兜底）：HTTP 模式下可用 header `X-Project-Path` 或连接 env 注入，服务端据此推断。不写死在服务器 `config.json`。
3. **缺省**：未提供则为全局桶（不报错）。

> 不要把 project 写死在服务器配置里。每个工具的配置文件（`.cursor/mcp.json` 等）是**客户端**配置，按项目各自带不同 key/header 即可实现隔离。

---

## 三、各工具 MCP 配置片段

### 通用 SSE 配置（大多数工具）

```json
{
  "mcpServers": {
    "ai-memory": {
      "type": "sse",
      "url": "http://192.168.110.128:8765/sse?key=my-secret-key-114514"
    }
  }
}
```

### 按工具差异速查

| 工具 | 配置文件 | 根键 | 传输 |
|------|---------|------|------|
| **Cursor** | `.cursor/mcp.json`（项目）/ `~/.cursor/mcp.json`（全局） | `mcpServers` | stdio / SSE / HTTP |
| **Cline** | `cline_mcp_settings.json` | `mcpServers` | stdio / SSE |
| **Roo Code** | `.roo/mcp.json` / `mcp_settings.json` | `mcpServers` | stdio / SSE / HTTP |
| **Zed** | `~/.config/zed/settings.json` | `context_servers` | stdio / HTTP |
| **Continue** | `~/.continue/config.yaml` 或项目 `.continue/` | `mcpServers`（**数组**） | stdio / sse / http |
| **opencode** | `~/.config/opencode/opencode.json` | `mcp.{name}` | local(stdio) / sse / http |
| **VS Code Copilot** | `.vscode/mcp.json` | **`servers`**（非 mcpServers！） | stdio / SSE / HTTP |
| **Claude Code** | `.mcp.json` / `~/.claude.json` | `mcpServers` | stdio / SSE / HTTP |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | stdio / SSE(经 mcp-remote) |
| **Cody** | 编辑器设置 | `cody.mcpServers` | stdio |
| **Devin** | Web UI `Settings>Connections>MCP` | — | stdio / SSE / HTTP |

### 示例片段

**Cursor** (`.cursor/mcp.json`)
```json
{ "mcpServers": { "ai-memory": { "type": "sse", "url": "http://192.168.110.128:8765/sse?key=my-secret-key-114514" } } }
```

**VS Code Copilot** (`.vscode/mcp.json`) — 注意根键是 `servers`
```json
{ "servers": { "ai-memory": { "type": "sse", "url": "http://192.168.110.128:8765/sse?key=my-secret-key-114514" } } }
```

**Zed** (`settings.json`)
```json
{ "context_servers": { "ai-memory": { "transport": { "type": "http", "url": "http://192.168.110.128:8765/mcp?key=my-secret-key-114514" } } } }
```

**Continue** (`config.yaml`) — 数组形式
```yaml
mcpServers:
  - name: ai-memory
    transport:
      type: sse
      url: http://192.168.110.128:8765/sse?key=my-secret-key-114514
```

**opencode** (`opencode.json`)
```json
{ "mcp": { "ai-memory": { "type": "http", "url": "http://192.168.110.128:8765/mcp?key=my-secret-key-114514" } } }
```

**Claude Code**
```bash
claude mcp add ai-memory --transport http http://192.168.110.128:8765/mcp?key=my-secret-key-114514
```

### stdio-only 工具（opencode / Claude Code 本地模式）

ai-memory 已提供**零依赖**的官方 stdio 桥接器（`lib/stdio_bridge.js`，仅需 Node ≥ 18），推荐优先使用：

```json
{
  "mcpServers": {
    "ai-memory": {
      "command": "node",
      "args": [
        "/path/to/ai-memory/lib/stdio_bridge.js",
        "--endpoint", "http://192.168.110.128:8765/sse?key=my-secret-key-114514",
        "--project", "你的工作区路径"
      ]
    }
  }
}
```

- `--endpoint`：远端 SSE 地址（含 key）
- `--project`（可选）：连接级 project 兜底，自动注入每个请求的 `project` 字段，实现隔离；不传则由调用方（AI）按约定传入当前工作区路径

> 备选：若不便运行桥接器，也可用 `npx -y mcp-remote http://192.168.110.128:8765/sse?key=my-secret-key-114514` 桥接。

---

## 四、跨工具通用底座：AGENTS.md 记忆纪律

把下面这段放进项目根的 `AGENTS.md`（或 `CLAUDE.md` / `.cursorrules`）。**所有支持 MCP 的工具都会自动加载它，从而驱动 AI 主动调用记忆工具**——这是最通用、跨工具一致的"自动"手段。

```markdown
# 长期记忆 (ai-memory)

本项目接入 ai-memory 长期记忆服务。请遵循以下纪律：

## 会话开始
- 先调用 `search_memories` 检索与当前任务相关的历史记忆。
  project 由客户端自动注入为当前工作区路径，无需手动传。

## 记录什么（遇以下情况使用 add_memory）
- 架构决策 / 技术选型与理由
- 项目约定 / 用户偏好 / 红线
- 调试结论 / 踩坑根因
- 关键命令 / 部署拓扑 / 环境事实
- content 用中文，tags 标注类别（如 convention / decision / pitfall）。

## 会话结束
- 结束前再 search + add 补齐本次重要结论。
- 也可用 `capture_memory` 做自动抽取：把本次结论的中文摘要 / 原始片段作为 `text` 传入，服务端自动过滤闲聊、去重合并后入库（详见第六节）。
```

---

## 五、Claude Code 强自动增强：Hooks

Claude Code 支持 Hooks，可在会话边界**不依赖 AI 自觉**地触发记忆读写。在 `~/.claude/settings.json` 或项目 `.claude/settings.json` 加入：

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": ".", "hooks": [ { "type": "command", "command": "curl -s -X POST -H 'Authorization: Bearer my-secret-key-114514' -H 'X-Requested-With: ai-memory' 'http://192.168.110.128:8765/api/memories/session-start?project=$PWD'" } ] }
    ],
    "Stop": [
      { "matcher": ".", "hooks": [ { "type": "command", "command": "curl -s -X POST -H 'Authorization: Bearer my-secret-key-114514' -H 'X-Requested-With: ai-memory' -H 'Content-Type: application/json' -d '{\"project\":\"'\"$PWD\"'\"}' 'http://192.168.110.128:8765/api/memories/session-end'" } ] }
    ]
  }
}
```

> 说明：`session-start` 端点返回该项目的历史记忆摘要，可由 hook 注入上下文；`session-end` 触发归档/摘要生成。完整自动摘要需 LLM 参与，可后续结合定时任务实现。

---

## 六、自动抽取纪律（capture_memory / /api/capture）

**前情**：服务端 `capture.js` 早已具备 mem0 式自动抽取管线（`captureText`）：重要性过滤 → 语义事实抽取（v2 类别）→ `reconcileFact` 去重合并 → 入库。入口有两个：
- MCP 工具 `capture_memory`（入参 `text` / `user` / `project` / `tags` / `source` / `memory_type` 等）
- REST `POST /api/capture`（body 必填 `text`，可选 `user` / `project` / `tags` / `source` 等，整包透传为 scope）

**关键纪律**：记忆要“自动用起来”，**客户端必须主动调用** `capture_memory` / `/api/capture`。MCP 协议与 capture 管线都不会在 AI 不调用时自动落库（之前就是“路通了没人走”）。各客户端的规则文件 / Hook 必须明确：在有意义对话的自然断点（决策落地、踩坑根因、用户偏好确认、部署拓扑变更）主动把近期内容喂给 `capture_memory`。

### AGENTS.md 追加模板

在第四节的 `AGENTS.md` 末尾追加：

```markdown
## 自动抽取（capture_memory）
- 本服务支持 mem0 式自动抽取：把近期对话 / 笔记原文喂给 capture_memory（或 REST POST /api/capture 的 text 字段），服务端自动过滤闲聊、抽取结构化事实、去重合并后入库。
- 触发时机：每次完成一个有结论的环节（架构决策、技术选型、踩坑根因、用户偏好、环境 / 部署事实）后，主动调用一次 capture_memory，text 给一段中文摘要或原始对话片段，project 由客户端自动注入当前工作区路径。
- 优先用 capture_memory 而非手动 add_memory：前者自动去重 / 过滤，更接近“按重要性自动存”的体验。
- REST 兜底（无 MCP 的工具）：curl -X POST -H 'Authorization: Bearer <key>' -H 'X-Requested-With: ai-memory' -H 'Content-Type: application/json' -d '{"text":"<内容>","project":"<工作区路径>"}' http://<host>:8765/api/capture
```

### Claude Code Hooks 兜底（Stop 时）

在第五节 Stop hook 的 command 中串联一次 capture（仅能拿到 `$PWD` 等壳层变量、拿不到对话文本，用作心跳兜底；真正高质量的抽取仍靠 AI 主动调用 capture_memory）：

```bash
printf '{"text":"auto-capture at %s","project":"%s"}' "$PWD" "$PWD" > /tmp/cap.json && \
curl -s -X POST -H 'Authorization: Bearer my-secret-key-114514' -H 'X-Requested-With: ai-memory' -H 'Content-Type: application/json' -d @/tmp/cap.json 'http://192.168.110.128:8765/api/capture' >/dev/null 2>&1 || true
```

> 说明：`capture_memory` 的 `text` 由 AI 在对话中提供质量最高；Hook 仅保证“有心跳、不会完全漏记”。

---

## 七、兼容性自检清单

- [x] SSE 端点 `/sse?key=...` 可被 Cursor/Cline/Roo/Windsurf 列出工具
- [x] Streamable HTTP 端点 `/mcp?key=...` 可被 Zed/VS Code/Claude Code 列出工具
- [x] 工具命名 `add_memory` / `search_memories` 符合业界习惯
- [x] project 可选 + AI 自动传路径，不强制写死
- [x] stdio 官方桥接器 `lib/stdio_bridge.js`（零依赖，已验证 initialize + tools/list）
- [x] 连接级 project 兜底（stdio 桥接器 `--project` 注入，REST 由调用方传入）

---

## 八、WorkBuddy 客户端接入（当前环境）

WorkBuddy 本身即本仓库的日常使用环境，也是「记忆怎么自动用起来」最易落地的客户端。WorkBuddy 会加载项目 `AGENTS.md` 与项目 / 系统指令，因此**第四节的通用纪律模板 + 第六节的自动抽取纪律直接生效**——只要把纪律写进项目 `AGENTS.md` 或 WorkBuddy 的项目指令，AI 就会在收尾时主动调用 `capture_memory`（或 REST `/api/capture`）。

### 指令模板（放进 WorkBuddy 项目指令 / AGENTS.md）

```markdown
# 长期记忆 (ai-memory) —— WorkBuddy 客户端纪律

- 会话开始：先 `search_memories` 检索与当前任务相关的历史记忆（project 由客户端自动注入当前工作区路径）。
- 记录什么（add_memory）：架构决策 / 技术选型与理由 / 项目约定 / 用户偏好 / 踩坑根因 / 关键命令 / 部署拓扑。content 用中文，tags 标注类别。
- 自动抽取（capture_memory / /api/capture）：每次完成一个有结论的环节，把近期对话 / 笔记原文（或结构化 `messages:[{role,content}]`）喂给 capture_memory；服务端自动过滤闲聊、抽取事实、去重合并后入库。project 自动注入。
- REST 兜底（无 MCP 上下文时）：curl -X POST -H 'Authorization: Bearer <key>' -H 'X-Requested-With: ai-memory' -H 'Content-Type: application/json' -d '{"text":"<内容>","project":"<工作区路径>"}' http://<host>:8765/api/capture
```

### 定时自动化兜底（心跳 / 轻量归档）

WorkBuddy 的「自动化」是**按 rrule 定时触发**，不是会话边界钩子；因此它适合做「周期性心跳 + 轻量归档」，真正高质量的抽取仍靠 AI 在对话中主动调用 `capture_memory`。示例自动化（每天 23:55 心跳归档工作区记忆）：

- **prompt（自动化提示词，自然语言）**：「调用 `POST http://192.168.110.128:8765/api/capture`，body 为 `{"text":"daily heartbeat archive","project":"<工作区路径>"}`，带鉴权头 `Authorization: Bearer <key>` 与 `X-Requested-With: ai-memory`，无需回显结果。」
- **等价 shell 动作**（若用命令型自动化）：

```bash
printf '{"text":"daily heartbeat archive","project":"%s"}' "$PWD" > /tmp/cap.json && \
curl -s -X POST -H 'Authorization: Bearer my-secret-key-114514' -H 'X-Requested-With: ai-memory' -H 'Content-Type: application/json' -d @/tmp/cap.json 'http://192.168.110.128:8765/api/capture' >/dev/null 2>&1 || true
```

> 说明：与 Claude Code Hook 不同，WorkBuddy 自动化无法在「会话结束」那一刻拿到对话文本，故仅作心跳兜底；把抽取纪律写进项目指令、让 AI 在对话中主动 capture，才是高质量路径。
