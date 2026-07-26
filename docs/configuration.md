# ai-memory 配置指南

## 配置文件

`config.json` 位于服务根目录（与 `server.js` 同级）。未配置的字段使用默认值。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `qdrant_url` | string | `''` | Qdrant 地址（留空自动降级 SQLite） |
| `embedding_url` | string | `''` | Embedding 模型 OpenAI 兼容端点 |
| `embedding_model` | string | `'qwen3-embedding:0.6b'` | 嵌入模型名 |
| `embedding_max_concurrent` | number | `1` | Embedding 并发数（单 GPU=1，多 GPU=N） |
| `llm_url` | string | `''` | LLM OpenAI 兼容端点 |
| `llm_model` | string | `'minicpm5-1b'` | LLM 模型名 |
| `llm_max_concurrent` | number | `1` | LLM 并发数 |
| `api_keys` | string[] | `[]` | Bearer token 数组（空=不启用鉴权） |
| `mcp_allowed_origins` | string[] | `['*']` | MCP 同源白名单 |
| `archive_enabled` | boolean | `false` | 启用冷记忆自动归档 |
| `archive_idle_days` | number | `90` | 记忆空闲多少天后视为冷记忆 |
| `scheduler_interval_min` | number | `30` | 后台扫描间隔（分钟，0=关闭） |

## 环境变量覆盖

部分配置可通过环境变量覆盖（用于 Docker 部署）：

- `PORT` — 监听端口（默认 8765）
- `API_KEYS` — 逗号分隔的密钥列表
- `LLM_MODEL` / `EMBEDDING_MODEL` — 模型名
- `BACKUP_PATH` — 备份目录
- `MCP_ALLOWED_ORIGINS` — 逗号分隔的允许来源

## 部署

```bash
# 部署到 192.168.110.128
node deploy.js
```
