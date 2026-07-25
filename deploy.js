#!/usr/bin/env node
// deploy.js — sshtool 自动部署脚本（沙箱友好，代替 deploy.sh）
// 用法：node deploy.js
// 环境变量：SSH2_PASSWORD（默认 laolen123456），HOST（默认 192.168.110.128）
// 流程：备份→打包→put→解压→check→restart→health→（可选的远程测试）
//
// 前置：sshtool.js 在 WORKBUDDY_NODE 的 workspace 下，ssh2 需安装在 NODE_PATH。

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const SSHPASS = process.env.SSH2_PASSWORD || 'laolen123456';
const HOST = process.env.HOST || '192.168.110.128';
const NODEEXE = process.env.NODEEXE || 'C:/Users/laolen/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const SSHPATH = process.env.SSHPATH || 'C:/Users/laolen/.workbuddy/binaries/node/workspace/sshtool.js';
const NPATH = process.env.NODEPATH || 'C:/Users/laolen/node_modules';
const PROJ = path.resolve(__dirname);
const TS = new Date().toISOString().replace(/[:.]/g, '-');

function run(cmd) {
  console.log('>>> ' + cmd.slice(0, 200));
  const out = execSync(cmd, { cwd: PROJ, encoding: 'utf8', env: { ...process.env, SSH2_PASSWORD: SSHPASS, NODE_PATH: NPATH } });
  console.log(out);
  return out;
}

// 本机路径转 Unix 格式供 Git Bash tar 用
function unixPath(p) { return '/' + p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, '$1/'); }

async function main() {
  console.log('=== ai-memory 部署到 ' + HOST + ' ===');

  // 1) 远端备份
  console.log('--- 1/7 远端整目录备份 ---');
  run(`"${NODEEXE}" "${SSHPATH}" run "tar czf /opt/ai-memory-backup-${TS}.tar.gz -C /opt ai-memory && echo BACKUP_DONE"`);

  // 2) 本地打包
  console.log('--- 2/7 本地打包 ---');
  const pkg = path.join(PROJ, `.deploy-${TS}.tar.gz`);
  const upkg = unixPath(pkg);
  run(`tar czf "${upkg}" -C "${unixPath(PROJ)}" lib/*.js server.js admin.html package.json`);

  // 3) 上传
  console.log('--- 3/7 上传 ---');
  run(`"${NODEEXE}" "${SSHPATH}" put "${pkg}" "/tmp/ai-memory-deploy-${TS}.tar.gz"`);

  // 4) 远端解压 + 语法全检 + 删死代码
  console.log('--- 4/7 解压 + 语法检查 ---');
  // 注意：JS 模板字面量中 $FILES 和 $f 无 { 则不触发插值，是纯字面量
  run(`"${NODEEXE}" "${SSHPATH}" run "cd /opt/ai-memory && tar xzf /tmp/ai-memory-deploy-${TS}.tar.gz && rm -f /tmp/ai-memory-deploy-${TS}.tar.gz && node --check server.js && for f in lib/*.js; do node --check \"$f\" || exit 1; done && rm -f verify_v113.js test_full.js test_deep.js && echo DEPLOY_OK"`);

  // 5) 重启
  console.log('--- 5/7 重启服务 ---');
  run(`"${NODEEXE}" "${SSHPATH}" run "systemctl restart ai-memory && sleep 3 && echo RESTART_DONE"`);

  // 6) 健康检查
  console.log('--- 6/7 健康检查 ---');
  const health = run(`"${NODEEXE}" "${SSHPATH}" run "curl -s --max-time 8 http://127.0.0.1:8765/api/health"`);
  if (health.includes('qdrant_connected') && health.includes('dedup_stats')) {
    console.log('✅ 部署成功：新版代码确认运行');
  } else {
    console.log('⚠️  健康检查异常，请检查服务器状态');
    console.log('原始输出:', health);
  }

  // 7) 清理本地临时包
  console.log('--- 7/7 清理 ---');
  try { fs.unlinkSync(pkg); } catch (e) {}

  console.log('=== 部署完成 ===');
  console.log('如需远程全量测试：');
  console.log(`  SSH2_PASSWORD=${SSHPASS} NODE_PATH="${NPATH}" "${NODEEXE}" "${SSHPATH}" run "cd /opt/ai-memory && curl -s -X POST http://127.0.0.1:8765/api/reindex"`);
  console.log(`  NODE_PATH="${PROJ}/node_modules" BASE=http://${HOST}:8765 "${NODEEXE}" test/run.js`);
}

main().catch(e => { console.error('部署失败:', e.message); process.exit(1); });
