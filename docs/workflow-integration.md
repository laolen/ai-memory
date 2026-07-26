# ai-memory WorkFlow 集成

WorkBuddy 中通过 MCP 接入 ai-memory。本 Skill 提供两个核心场景的开箱即用 prompt。

## 场景 1: 项目上下文注入

用户 @ai-memory 时，自动做：

1. 调 `recall_for_context` 获取当前项目的高 salience 记忆
2. 调 `resume_state` 获取上次会话续接
3. 将结果注入 system prompt

## 场景 2: 定期 Digest

用户说「帮我总结本周记忆」或设置自动化：
1. 调 `digest` 生成周报
2. 用 `export_memory_text(format:'markdown')` 导出

## MCP 配置

确保 WorkBuddy 的 MCP 配置指向:
```
{
  "mcpServers": {
    "ai-memory": {
      "command": "node",
      "args": ["/path/to/ai-memory/server.js"],
      "env": {
        "PORT": "8765"
      }
    }
  }
}
```

或通过 SSE 连接：
```
url: http://192.168.110.128:8765/sse
```
