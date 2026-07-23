#!/usr/bin/env bash
# 部署 ai-memory（本地/云端双支持 + 后端自测 + 事实抽取 + 实体兜底）到 128 服务器
#
# 前置条件：在本机（持有 128 授权 SSH 密钥的终端，如你的常用终端）运行，
#           且能 ssh / scp 到 128。本脚本不依赖 WorkBuddy 会话里的密钥。
# 用法：
#   bash deploy.sh
# 若 128 地址不是 192.168.110.128，可改下方 REMOTE，或：
#   REMOTE=laolen@另一地址 bash deploy.sh
#
# 说明：
#   - 只覆盖 server.js 与 admin.html，不动 config.json（你的 ES / 嵌入等现有配置全部保留）。
#   - 覆盖前会备份远端原文件到 .bak-<时间戳>，便于一键回滚。
#   - 部署后自动重启 ai-memory 并做健康检查。
#   - 新服务启动后，配置里的三处 API Key 默认是空（本地模式）；在 /admin 界面填云端 Key 即可。

set -euo pipefail

REMOTE="${REMOTE:-laolen@192.168.110.128}"
DIR="/opt/ai-memory"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"

echo "==> 目标：$REMOTE:$DIR"

# 0) 连通性与目录预检
if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" "test -d $DIR"; then
  echo "✗ 无法 SSH 到 $REMOTE，或远端目录 $DIR 不存在。"
  echo "  请确认：本机持有 128 的授权 SSH 密钥，且网络可直达 128。"
  exit 1
fi

# 1) 备份远端原文件（便于回滚）
echo "==> 备份远端原文件 -> .bak-$TS"
ssh "$REMOTE" "cd $DIR && cp -f server.js server.js.bak-$TS && cp -f admin.html admin.html.bak-$TS && echo 已备份"

# 2) 拷贝新文件
echo "==> 拷贝 server.js / admin.html"
scp "$SCRIPT_DIR/server.js" "$REMOTE:$DIR/server.js"
scp "$SCRIPT_DIR/admin.html" "$REMOTE:$DIR/admin.html"

# 3) 语法检查 + 重启
echo "==> 远端 node --check 并重启 ai-memory"
ssh "$REMOTE" "cd $DIR && node --check server.js && { systemctl restart ai-memory || systemctl restart ai-memory.service; }"

# 4) 等重启
echo "==> 等待服务起来（3s）…"
sleep 3

# 5) 健康检查
HOST="${REMOTE#*@}"
echo "==> 健康检查 (http://$HOST:8765/api/health)："
curl -s --max-time 8 "http://$HOST:8765/api/health" | head -c 600 || echo "(本机无法直连 :8765 —— 请到 128 本机或同网段浏览器打开 /admin 确认)"
echo

# 6) 提示
echo "部署完成 ✅"
echo "  管理界面：http://$HOST:8765/admin"
echo "  你应在「嵌入 / 自动捕获 / 知识图谱」三处看到 API Key 输入框，均标注「云端才填，本地留空」。"
echo "  在界面填好云端 Key 后点保存，服务会自动重启使配置生效（无需手动改 config.json）。"
echo ""
echo "  如需回滚："
echo "    ssh $REMOTE 'cd $DIR && cp -f server.js.bak-$TS server.js && cp -f admin.html.bak-$TS admin.html && systemctl restart ai-memory'"
