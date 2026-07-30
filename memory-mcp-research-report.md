# 主流 AI 编码工具如何调用「长期记忆 MCP 服务器」— 调研报告

> 调研方式：WebSearch / WebFetch 官方文档与社区资料（Cursor、Windsurf、Cline、Roo、VS Code/Devin 官方文档、Mem0 / mcp-memory-service / agentmemory 仓库与文档、AGENTS.md 规范站点等）。
> 标注说明：**【已确认】** = 来自官方文档/可靠一手资料；**【推测】** = 基于资料合理推断，未被官方明确证实。

---

## 一、核心结论（先看这里）

1. **两条记忆路线并存，且不互斥**：
   - **纯文件式**：`CLAUDE.md` / `.cursorrules` / `.windsurfrules` / `AGENTS.md` / `GEMINI.md` / `copilot-instructions.md` 等。这是「指令/规则层」，告诉 AI 该记住什么、何时调用工具。
   - **MCP 记忆服务器**：`add_memory` / `search_memories` 等工具。这是「运行时工具层」。
   - 几乎所有主流工具 **两者都支持**（Aider 例外，见下）。

2. **没有主流工具内置「会话结束时自动调用 add_memory」的默认管道**。记忆写入几乎都是 **AI 在对话中按规则主动调用 MCP 工具** 完成的。例外：
   - **Windsurf 的「Memories」是产品内建自动生成**（但写的是 Windsurf 自己的存储，不是 MCP add_memory）。
   - **Claude Code 的 Hooks（Stop / PostToolUse / SessionStart）** 是唯一可配置「在会话边界自动触发记忆读写」的机制，但需用户写 hook 脚本（如 mem0-hook、claude-code-auto-memory 插件），非默认。
   - **Codex / Gemini CLI / Claude Code** 有产品内建的「auto memory / Memories」特性，但同样 **不是 MCP**。

3. **没有任何工具会自动把「当前工作区路径」塞进 MCP 工具的参数里**。Scope/项目隔离靠三件事：
   - (a) **配置文件位置**（项目级 `mcp.json` 让服务器只在该项目加载）；
   - (b) **AI 在参数里手填** `project` / `workspace` / `projectPath`；
   - (c) **连接级上下文**（HTTP header / auth token / 每配置 env 变量，如 `MEMORY_FILE_PATH`）。
   - MCP 协议层虽有 **roots** 能力（服务器可反查客户端文件系统边界），但各家基本未把它用于记忆隔离。

4. **配置碎片化严重**：根键不统一 —— 多数用 `mcpServers`，VS Code/Copilot 用 `servers`，Zed 用 `context_servers`，Cody 用 `cody.mcpServers`，Continue 用**数组**而非 map。传输协议以 stdio 为主，SSE 普遍，Streamable HTTP 正在普及。

---

## 二、结构化对比表（工具 × A/B/C/D/E）

图例：✅ 支持 / ❌ 不支持 / ⚠️ 部分/有条件 / 文件=纯文件式 / MCP=MCP 记忆服务器

| 工具 | A. 记忆机制 | B. MCP 记忆如何触发 | C. project/scope 隔离 | D. MCP 配置方式 | E. 原生/推荐 memory server |
|---|---|---|---|---|---|
| **Cursor** | 文件(.cursor/rules, .cursorrules) + MCP | AI 按 rules 主动调工具；无内建自动管道 | 项目级 `mcp.json` 限定范围；`${workspaceFolder}` 插值；tool 参数手填 | `.cursor/mcp.json`(项目) / `~/.cursor/mcp.json`(全局)；根键 `mcpServers`；stdio+SSE+Streamable HTTP | 任意；官方 `@modelcontextprotocol/server-memory`、mem0、mcp-memory-service |
| **Cline** | 文件(.clinerules) + MCP | AI 按 .clinerules 主动调；Memory Bank 需显式 `update_context` | tool 参数 `projectPath` 手填；全局配置为主 | `cline_mcp_settings.json`（全局存储路径）；`mcpServers`；stdio+SSE | Cline Memory Bank、Memstate、agentmemory |
| **Windsurf** | 文件(.windsurfrules/.windsurf/rules) + **内建 Memories(自动)** + MCP | 内建 Memories 由 Cascade **自动生成并关联工作区**；MCP 靠 AI 主动调 | 内建 Memories 自动按工作区隔离；MCP 靠参数/配置 | `~/.codeium/windsurf/mcp_config.json`；`mcpServers`；stdio + Streamable HTTP(经 mcp-remote 走 SSE) | 任意；Sequential Thinking 作模板 |
| **Aider** | **仅文件**（.aider.conf.yml, CONVENTIONS.md） | ❌ **无原生 MCP**（PR 已关闭）；靠第三方桥接(warp-agent/mcpm-aider)或 shell 脚本 | N/A（文件靠 read: 指定） | 无 MCP 配置（工具生态独立） | agentmemory 等需经 shell 变通，**MCP 非官方支持** |
| **GitHub Copilot (VS Code)** | 文件(copilot-instructions.md, AGENTS.md) + MCP | Agent 模式内 AI 主动调；云代理(Coding Agent)可自主执行工具 | `.vscode/mcp.json`(工作区) vs 用户设置(全局)；参数手填 | `.vscode/mcp.json`；**根键 `servers`**（非 mcpServers！）；stdio+SSE+Streamable HTTP | 任意；云代理预置 GitHub/Playwright MCP |
| **Roo Code** | 文件(.roo/rules, .roomodes, custom modes) + MCP | AI 按 rules 主动调；有 memory 生命周期 rules | `.roo/mcp.json`(项目)或全局 `mcp_settings.json`；tool 参数 `--workspace` 手填；`cwd` 默认首工作区 | `.roo/mcp.json` / `mcp_settings.json`；`mcpServers`；stdio+SSE+Streamable HTTP | MCP Roo Memory(Cortex)、agentmemory |
| **Continue** | 文件(config.yaml) + MCP（含 Docker MCP Memory） | 仅 Agent 模式；AI 主动调 | `.continue/config.yaml`(工作区) 或 `.continue/mcpServers/`；参数手填 | `config.yaml` 中 **`mcpServers` 是数组**；stdio+sse+streamable-http | agentmemory、Pieces LTM、Docker MCP Memory |
| **Sourcegraph Cody** | 文件(rules/.* , .mdc) + MCP(agentic context) | AI 主动调；**仅支持 MCP Tools**（无 Resources/Prompts）；需企业实例开 feature flag | `cody.mcpServers`（编辑器设置）；参数手填 | 设置中 `cody.mcpServers`（**不同键名**）；stdio 为主 | MemNexus、任意 |
| **Devin (Cognition)** | 文件(自动读取 .rules/.cursorrules/CLAUDE.md/AGENTS.md) + **Knowledge Base(手动)** + MCP | MCP 经 Marketplace/自定义；AI 主动调；KB 需手动维护 | 云端设置或 `~/.codeium/windsurf/mcp_config.json`(Devin Desktop)；参数手填 | Web UI `Settings>Connections>MCP`；传输 stdio+SSE+HTTP；Devin Desktop 用 `mcpServers` | MemNexus、Hindsight、任意 |
| **Zed** | 文件(rules) + MCP(context_servers) | AI 主动调 | `~/.config/zed/settings.json`；**`context_servers`**；basic-memory 用 `project` 设置 | `settings.json` 中 `context_servers`；stdio + HTTP | Memento、basic-memory、server-memory |
| **Claude Code** ⭐ | 文件(CLAUDE.md, AGENTS.md) + **内建 auto-memory(MEMORY.md)** + MCP | AI 主动调；**Hooks(Stop/PostToolUse/SessionStart) 可配置自动触发**；内建 auto-memory 写 MEMORY.md | `.mcp.json`(项目)/`~/.claude.json`(用户/本地)；支持 roots；参数手填 | `.mcp.json`；`mcpServers`；stdio+SSE+HTTP；`claude mcp add` | mem0、server-memory、mcp-memory-service、agentmemory |
| **OpenAI Codex CLI** | 文件(AGENTS.md, instructions.md) + **内建 Memories(自动摘要)** + MCP | AI 主动调；内建 Memories 自动 | `~/.codex/config.toml` / `.codex/config.toml`(项目) | `config.toml` 中 `mcp_servers`（下划线键）；stdio+远程 | mem0、server-memory |
| **Gemini CLI** | 文件(GEMINI.md) + **实验性 Auto Memory** + MCP | AI 主动调 | `~/.gemini/settings.json` / 项目 `settings.json` | `mcpServers`；stdio+远程 | server-memory、ai-memory |

> **【推测】** Aider 未来可能合并 MCP（社区桥接活跃）；其余「无内建自动管道」均基于当前官方文档。

---

## 三、业界主流 memory MCP server 实现（E 维度展开）

| 实现 | 形态 | 特点 | 被哪些工具推荐/原生 |
|---|---|---|---|
| **`@modelcontextprotocol/server-memory`**（官方 reference） | 本地 stdio，知识图谱(JSON) | 实体-关系-观察模型，零依赖、本地文件 | 几乎所有工具文档的「memory 示例」都用它（Cursor/Windsurf/Continue/Zed/Cline 教程） |
| **mem0-mcp** | 云/自托管 HTTP | 向量语义检索，按 `user_id` 跨工具共享；暴露 `add_memory`/`search_memories` 等 11 个工具 | 官方提供 Claude Code / Cursor / Codex / OpenCode / Windsurf 插件；最被「主动推广」 |
| **mcp-memory-service** | 本地/自托管，REST+知识图谱 | Apache 2.0，混合检索(BM25+向量)，自动合并；号称兼容 Claude Code/Codex/Copilot CLI/Zed/Cody 等 | 社区项目，覆盖面宣称最广 |
| **agentmemory** | 本地(stdio/HTTP) | SQLite + 语义搜索，跨工具配置文档齐全 | 明确给出 Cursor/Cline/Roo/Windsurf/Zed/Continue/Aider/Goose/Codex/Gemini 配置 |
| **Memento / basic-memory / MCP Roo Memory(Cortex)** | 本地/容器 | 图记忆、多项目隔离 | Zed(Memento/basic-memory)、Roo(Cortex) 常见 |

**结论**：没有单一「标准」实现被所有工具原生内置；但 **官方 `server-memory` + mem0** 是出镜率最高的两个，且都通过「在 `mcp.json` 里加一段」即可接入，与工具解耦。

---

## 四、如何设计一个「能被大多数主流工具自动使用」的 memory MCP server

### 1. 传输协议：stdio 必选，Streamable HTTP 强烈建议，SSE 作兼容
- **stdio**：所有工具都支持，是「零配置本地接入」的底线。工具会按 `command`+`args`+`env` 拉起你的进程。
- **Streamable HTTP**：Cursor / VS Code Copilot / Cline / Roo / Windsurf / Devin 已支持，是「远端多租户」部署的唯一干净方式（一个公网端点服务所有用户/项目）。
- **SSE**：作为老客户端/过渡兼容保留即可（很多工具 SSE 经 `mcp-remote` 桥接）。
- 不要只做 SSE-only 或只做某云厂商私有协议。

### 2. project / scope：**默认可选，但服务端必须能从「连接上下文」推断隔离**
- **不要依赖客户端自动传 workspace 路径**——调研表明没有任何工具会替你填。若把 `project` 设成工具必填参数，AI 往往漏填或填错，跨会话一致性差。
- 推荐三层隔离策略（按优先级）：
  1. **连接级隔离（最佳）**：HTTP 模式下用 **Auth token / API Key / 自定义 header** 区分租户与项目。客户端配置里的 `headers.Authorization` 或 `env` 天然 per-project（项目级 `mcp.json` 各自带不同 key）。服务端据 token 解析出 `user_id`/`project_id`，工具调用无需再传 scope。**这是让 mem0 能「跨工具共享同一份记忆」的关键。**
  2. **配置级隔离**：stdio 模式下用 env 变量（如 `MEMORY_FILE_PATH`、`MEMORY_PROJECT`、`CORTEX_*`）在 `mcp.json` 里固定死，AI 不必关心。
  3. **工具参数隔离（兜底）**：保留可选的 `project`/`scope` 参数，给高级用户/跨项目检索用，但**默认取连接上下文的值**，缺省不报错。
- 即：**scope 应为「可选参数 + 连接上下文兜底」**，而非「必填」。这样工具侧零配合也能正确隔离。

### 3. 是否支持从请求上下文（header / auth scope / 连接参数）自动推断工作区：**应该支持，且这是「自动可用」的核心**
- 主流工具的 MCP 配置都允许写 `headers` 和 `env`（Cursor 插值 `${env:...}`、Roo `${env:...}`、VS Code `inputs` 引用密钥）。因此「每个项目一份带不同 token 的配置」是用户已熟悉的模式。
- 服务端据此推断工作区，比让 AI 在每次 `add_memory` 时手填 `project="xxx"` 可靠得多，也避免了「AI 忘记传 scope 导致记忆串项目」。

### 4. 工具侧需要的最低限度配合
要让「自动记忆」真正发生，仅靠服务器不够，还需一层「指令/钩子」：
- **规则文件（AGENTS.md / CLAUDE.md / .cursorrules）里写清记忆纪律**，例如：
  > 「会话开始时先 `search_memories` 取相关上下文；遇到架构决策/约定/调试结论就 `add_memory`；结束前再存一次。」

  所有支持 MCP 的工具都会加载这些文件，从而「自动」驱动工具调用。**这是当前最通用、跨工具一致的自动化手段。**
- **Claude Code Hooks**（Stop/SessionStart）是唯一能「不依赖 AI 自觉」在会话边界自动读写的机制——若你的目标包含 Claude Code，提供一套 `Stop` hook 脚本（注入记忆/生成摘要）会大幅提升「自动感」。
- **工具命名**：用 `add_memory` / `search_memories` / `get_memories` 这类直观名，降低 AI 调用门槛；避免需要复杂前置参数的工具。

### 5. 兼容性 checklist（发布前自测）
- [ ] stdio 启动：`npx your-server` 或 `uvx` 可直接跑，读 env 配置。
- [ ] Streamable HTTP：`url` + `headers` 可连，返回标准 MCP 端点。
- [ ] 工具集在 Cursor / VS Code / Claude Code / Cline / Roo / Windsurf / Zed / Continue 的 `mcp.json` 样例均能列出（根键差异已处理：多数 `mcpServers`，VS Code `servers`，Zed `context_servers`——这是**客户端**的事，你只需保证服务器协议正确，配置由用户按工具写）。
- [ ] 隔离靠 token/env，而非强制 tool 参数。
- [ ] 提供一份 AGENTS.md / CLAUDE.md 片段，说明如何「自动」使用你的工具。

---

## 五、一句话建议

> **把 scope 从「AI 手填的必填参数」改成「由连接(token/header/env)推断的可选维度」，同时支持 stdio + Streamable HTTP，并在 AGENTS.md 模板里写清记忆纪律——这样你的 memory MCP server 就能在几乎所有制式（Cursor/Cline/Roo/Windsurf/Zed/Continue/Cody/Devin/Claude Code/Codex/Gemini）里「装上即用、自动隔离」，而无需任何工具修改代码。真正的「自动写入」目前只有两条路：产品内建（Windsurf/Claude/Codex 各自的 auto-memory，非 MCP）或 Claude Code Hooks（可接你的 MCP）。**

---

### 附：关键事实来源
- Cursor MCP 文档（cursor.com/cn/docs/context/mcp）：三种传输、变量插值、`.cursor/mcp.json`。
- Windsurf 文档（docs.windsurf.com）：Cascade 自动生成 Memories 且按工作区隔离；`mcp_config.json`。
- VS Code/Copilot MCP（anonymize.dev、learn.microsoft.com、claw.aguidetocloud.com）：`servers` 根键、Agent 模式、Streamable HTTP。
- Roo Code 文档（docs.roocode.com）：`.roo/mcp.json`、`mcpServers`、三传输。
- Claude Code Hooks（claude.com/blog/how-to-configure-hooks）：Stop/PostToolUse/SessionStart 可触发的自动管道。
- Mem0 / mcp-memory-service / agentmemory 仓库与文档：跨工具接入与 auto-memory hook 模式。
- AGENTS.md 规范（agents.md、qcode.cc）：跨厂商标准，OpenAI/Google/Cursor/Factory 等联合发布，现归 Linux Foundation Agentic AI Foundation。
