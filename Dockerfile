# ai-memory Docker 镜像
# 基于 node:18-alpine，配合 docker-compose 与 Qdrant 容器一起使用
FROM node:18-alpine

# 系统依赖：better-sqlite3 编译用
RUN apk add --no-cache python3 make g++

WORKDIR /opt/ai-memory

# 先装依赖（充分利用 Docker 缓存）
COPY package.json package-lock.json ./
RUN npm install --production

# 复制代码
COPY server.js ./
COPY lib/ ./lib/
COPY admin.html ./
COPY config.example.json ./

# 健康检查（可被 qdrant-compose.yml 的 depends_on 引用）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8765/api/health || exit 1

EXPOSE 8765

CMD ["node", "server.js"]
