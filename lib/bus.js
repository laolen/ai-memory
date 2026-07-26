// 轻量进程内事件总线（v1.17.0）：用于解耦「记忆变更」与「MCP Resources 实时通知」，
// 避免 memory <-> mcp 循环依赖。memory 层在增删改后 emit('memory-changed')，
// mcp 层订阅并向已连接的客户端推送 notifications/resources/list_changed。
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(100);
module.exports = bus;
