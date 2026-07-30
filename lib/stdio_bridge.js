#!/usr/bin/env node
/**
 * ai-memory stdio ↔ SSE 桥接器（零依赖，仅需 Node ≥ 18）
 *
 * 让以 stdio 启动 MCP server 的本地工具（opencode / Claude Code 本地模式 / Cody 等）
 * 也能连接远端的 ai-memory SSE 端点。
 *
 * 用法：
 *   node lib/stdio_bridge.js --endpoint "http://192.168.110.128:8765/sse?key=my-secret-key-114514" [--project "D:\\project\\ai-memory"]
 *
 * 协议：
 *   本进程作为 stdio MCP server 暴露给本地客户端（stdout 输出 JSON-RPC，stdin 读取请求）；
 *   同时作为 SSE client 连接远端 128：
 *     - GET <endpoint> 建立 SSE 流，服务端先发 `event: endpoint` 告知 POST 目标
 *     - 本地客户端请求 → POST 到该目标 → 远端响应经 SSE 流回传 → 写 stdout
 *   --project 存在时，自动注入到每个请求的顶层 project 字段（连接级隔离兜底）。
 */
'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

function parseArgs(argv) {
  const a = { endpoint: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--endpoint') a.endpoint = argv[++i];
    else if (argv[i] === '--project') a.project = argv[++i];
  }
  return a;
}

function main() {
  const { endpoint, project } = parseArgs(process.argv.slice(2));
  if (!endpoint) {
    process.stderr.write('usage: node lib/stdio_bridge.js --endpoint <sse-url> [--project <project>]\n');
    process.exit(1);
  }
  const base = new URL(endpoint);
  const lib = base.protocol === 'https:' ? https : http;
  let messageUrl = null;

  // ---- SSE 连接：接收远端 JSON-RPC 响应/通知 → 写 stdout ----
  const req = lib.request(
    {
      hostname: base.hostname,
      port: base.port,
      path: base.pathname + base.search,
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
    },
    (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleSseEvent(raw);
        }
      });
      res.on('error', (e) => stderr('SSE stream error: ' + e.message));
    }
  );
  req.on('error', (e) => {
    stderr('SSE connect error: ' + e.message);
    process.exit(1);
  });
  req.end();

  const pending = [];
  function handleSseEvent(raw) {
    let event = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event === 'endpoint') {
      // data 形如 /message?sessionId=xxx（相对路径，不含鉴权参数）
      // SSEServerTransport 不回传原始 key，POST 时需补回以保证鉴权通过
      let url = base.origin + data;
      const baseParams = base.search.replace(/^\?/, '');
      if (baseParams) url += (url.includes('?') ? '&' : '?') + baseParams;
      messageUrl = url;
      while (pending.length) postToServer(pending.shift()); // 刷新缓冲请求
      return;
    }
    if (event === 'message' && data) {
      try {
        const json = JSON.parse(data);
        // 连接级 project 兜底：仅当请求未自带 project 时注入
        if (project && json && json.params && json.params.project === undefined) {
          json.params.project = project;
        }
        process.stdout.write(JSON.stringify(json) + '\n');
      } catch (e) {
        stderr('bad sse data: ' + e.message);
      }
    }
  }

  // ---- stdin：本地客户端请求 → POST 到远端 /message ----
  let inBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    inBuf += chunk;
    // 优先按 Content-Length 分帧，否则按行
    while (true) {
      const clMatch = /^Content-Length:\s*(\d+)\r?\n/.exec(inBuf);
      if (clMatch) {
        const len = parseInt(clMatch[1], 10);
        const headerEnd = inBuf.indexOf('\n\n');
        if (headerEnd === -1) break;
        const start = headerEnd + 2;
        if (inBuf.length - start < len) break; //  body 未收全
        const body = inBuf.slice(start, start + len);
        inBuf = inBuf.slice(start + len);
        forward(body);
      } else {
        const nl = inBuf.indexOf('\n');
        if (nl === -1) break;
        const line = inBuf.slice(0, nl).trim();
        inBuf = inBuf.slice(nl + 1);
        if (line) forward(line);
      }
    }
  });

  function forward(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (project && msg && msg.params && msg.params.project === undefined) {
      msg.params.project = project;
    }
    if (!messageUrl) {
      pending.push(msg); // SSE 未就绪，缓冲，待 endpoint 到达后刷新
      return;
    }
    postToServer(msg);
  }

  function postToServer(msg) {
    const u = new URL(messageUrl);
    const body = JSON.stringify(msg);
    const r = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      },
      () => {} // 响应经 SSE 流回传，这里忽略 POST 响应体
    );
    r.on('error', (e) => stderr('POST error: ' + e.message));
    r.write(body);
    r.end();
  }
}

function stderr(s) {
  process.stderr.write('[stdio_bridge] ' + s + '\n');
}

main();
