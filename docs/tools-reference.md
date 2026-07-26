# ai-memory MCP 工具参考

本服务暴露 50+ MCP 工具，涵盖记忆 CRUD、检索分析、系统管理。

## 记忆操作

| 工具名 | 功能 |
|--------|------|
| `add_memory` | 存入一条记忆 |
| `search_memories` | 搜索记忆（语义/关键词/混合） |
| `list_memories` | 列出记忆 |
| `update_memory` | 更新记忆 |
| `delete_memory` | 删除记忆 |
| `correct_memory` | 纠正记忆（含冲突调和） |

## 检索与分析

| 工具名 | 功能 |
|--------|------|
| `recall_for_context` | 上下文回忆（默认混合检索） |
| `resume_state` | 续接会话（AI 摘要+待办线索） |
| `digest` | 周期摘要（日/周/月） |
| `detect_contradictions` | 矛盾检测 |
| `memory_health` | 记忆健康度报告（重复/未打标/过期） |
| `prune_memories` | 修剪冗余记忆（默认 dry-run） |
| `merge_memories` | 合并多条记忆 |

## 导出

| 工具名 | 功能 |
|--------|------|
| `export_memory_text` | 导出为 markdown/jsonl/obsidian/cards |
| `export_memories_markdown` | 导出为 Markdown（v1.16 旧接口） |

## 系统管理

| 工具名 | 功能 |
|--------|------|
| `schedule_recall` | 间隔召回调度 |
| `due_recalls` | 列出到期需复习的记忆 |
| `watch_tag` | 标签订阅 |
| `unwatch_tag` | 取消订阅 |
| `list_watches` | 列出订阅 |
| `archive_memories` | 冷记忆归档（默认 dry-run） |
| `list_archived` | 列出已归档记忆 |
| `restore_archived` | 恢复归档记忆 |
| `list_watch_dead` | 列出死信通知 |
| `retry_watch_dead` | 重发死信 |
| `scheduler_status` | 调度器状态 |

## Prompts（开箱即用）

| Prompt | 功能 |
|--------|------|
| `summarize_project` | 总结项目关键记忆 |
| `find_contradictions` | 找出矛盾并给建议 |
| `weekly_digest` | 生成本周摘要 |
| `export_markdown` | 导出记忆为 Markdown |

## Resources

- `memory://all` — 全部记忆（JSON）
- `memory://project/{key}` — 项目记忆
- `memory://project/{key}/markdown` — 项目记忆 Markdown
- `memory://memory/{id}` — 单条记忆详情
