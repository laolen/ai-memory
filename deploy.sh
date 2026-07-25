#!/usr/bin/env bash
# 部署 ai-memory 到 128 服务器（覆盖真正运行的代码：lib/ + server.js + admin.html）
#
# 前置条件：在本机（持有 128 授权 SSH 密钥的终端）运行，能 ssh / scp 到 128。
# 用法：
#   bash deploy.sh
# 若 128 地址不是 192.168.110.128：
#   REMOTE=root@另一地址 bash deploy.sh
#
# 关键说明（与 .workbuddy/memory/MEMORY.md 的部署红线一致）：
#   - /opt/ai-memory/lib/ 是唯一真正运行的代码目录（server.js 只 require ./lib/config + ./lib/rest），
#     所以 lib/ 必须随部署一起覆盖 —— 只拷 server.js 是无效部署。
#   - 绝不覆盖 config.json 与记忆数据（memories.db* / backups/）。
#   - 覆盖前先整目录 tar 备份到 /opt/ai-memory-backup-<时间戳>.tar.gz，可整体回滚。
#   - 部署后远端 node --check 全量校验 -> systemctl restart -> /api/health 核对。

set -euo pipefail

REMOTE="${REMOTE:-root@192.168.110.128}"
DIR="/opt/ai-memory"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"

echo "==> 目标：$REMOTE:$DIR"

# 0) 连通性与目录预检
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" "test -d $DIR/lib"; then
  echo "✗ 无法 SSH 到 $REMOTE，或远端目录 $DIR/lib 不存在。"
  exit 1
fi

# 1) 整目录备份（排除数据库大文件也可，但保持完整更稳妥）
echo "==> 整目录备份 -> /opt/ai-memory-backup-$TS.tar.gz"
ssh "$REMOTE" "tar czf /opt/ai-memory-backup-$TS.tar.gz -C /opt ai-memory && echo 已备份"

# 2) 拷贝代码：lib/ 全部 .js + server.js + admin.html（不碰 config.json / 数据）
echo "==> 拷贝 lib/*.js"
scp "$SCRIPT_DIR"/lib/*.js "$REMOTE:$DIR/lib/"
echo "==> 拷贝 server.js / admin.html"
scp "$SCRIPT_DIR/server.js" "$REMOTE:$DIR/server.js"
scp "$SCRIPT_DIR/admin.html" "$REMOTE:$DIR/admin.html"

# 3) 远端语法全检 + 重启
echo "==> 远端 node --check（server.js + lib/*.js）并重启 ai-memory"
ssh "$REMOTE" "cd $DIR && node --check server.js && for f in lib/*.js; do node --check \"\$f\"; done && { systemctl restart ai-memory || systemctl restart ai-memory.service; }"

# 4) 等重启
echo "==> 等待服务起来（3s）…"
sleep 3

# 5) 健康检查（核对 version / store / qdrant_connected）
HOST="${REMOTE#*@}"
echo "==> 健康检查 (http://$HOST:8765/api/health)："
curl -s --max-time 8 "http://$HOST:8765/api/health" | head -c 600 || echo "(本机无法直连 :8765 —— 请到 128 本机确认)"
echo

echo "部署完成 ✅"
echo "  管理界面：http://$HOST:8765/admin"
echo "  建议随后在本机跑端到端测试：BASE=http://$HOST:8765 node test/run.js"
echo ""
echo "  如需回滚（整目录恢复）："
echo "    ssh $REMOTE 'systemctl stop ai-memory; rm -rf $DIR; tar xzf /opt/ai-memory-backup-$TS.tar.gz -C /opt; systemctl start ai-memory'"
