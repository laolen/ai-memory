'use strict';
// =============================================================================
// ai-memory v1.8.0 薄入口（entry point）
// -----------------------------------------------------------------------------
// 历史：v1.7.0 及之前 server.js 是 ~1744 行的单体文件，所有业务逻辑（HTTP 路由、
//   MCP 工具、知识图谱、事实抽取、记忆读写、捕获、纠正、质量监控、诊断）都堆在
//   一个文件里，单处修改极易引发语法/逻辑连带错误。
// 现状：从 v1.8.0 起，业务逻辑按职责拆分到 lib/ 各功能模块（见 lib/ 目录），本文件
//   只负责「装配 + 启动」，不再承载任何实现细节，从根本上降低单文件修改出错风险。
//
// 模块分层（严格单向依赖，无循环）：
//   config(L0) → util/embed(L1) → backend/intelligence(L2) →
//   graph/projects/facts/memory/capture(L3-5) → correction/quality/diagnostics(L5) →
//   mcp/rest(L6) → server(本文件, L7 薄入口)
//
// 启动流程：
//   1. require('./lib/config') 触发配置加载 + ES client 初始化（副作用）
//   2. require('./lib/rest')   触发下游全部功能模块加载（rest 依赖整条链）
//   3. rest.startServer()     创建 HTTP/MCP(SSE) 服务并开始监听
// =============================================================================

// 1) 配置与 ES client 初始化（副作用，必须最先执行）
require('./lib/config');

// 2) 引入 REST/MCP 接入层（其内部会 require 所有功能模块）
const rest = require('./lib/rest');

// 3) 启动服务
rest.startServer();
