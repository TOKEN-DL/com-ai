# syntax=docker/dockerfile:1

# com-ai 生产镜像
#
#   runner —— Next.js 应用（standalone 输出，非 root）
#   worker —— 定时任务容器（node-cron，非 root）
#   migrate—— 一次性数据库迁移容器
#
# 数据库凭据**不写进镜像**：镜像里没有任何 DATABASE_URL 之外的凭据，
# 连接串一律在运行时由 compose / 编排平台通过环境变量注入。

# ─── base ───────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl \
 && npm install -g pnpm@10.21.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ─── deps ───────────────────────────────────────────────────────────
# 开发依赖也要装：migrate 阶段用 prisma CLI，builder 阶段用 esbuild。
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

# ─── prisma-runtime（Prisma 客户端运行时）──────────────────────────
# 采集的入库走唯一写入路径 `src/lib/asset-writer.ts`（Prisma），所以定时任务
# 容器里必须有**已生成**的 Prisma 客户端：`@prisma/client` 包 + `.prisma/client`
# （后者里面是平台对应的查询引擎 query_engine-*.so，deps 阶段 install 时
# postinstall 跑 `prisma generate` 生成的）。
#
# 只搬这两块，**不搬整份 node_modules**：deps 阶段装的是**全量**依赖
# （esbuild / typescript / vitest / prisma CLI 都在里面），整份搬进 worker
# 镜像会白白多几百 MB，而 worker 运行时真正缺的只有 Prisma 客户端。
#
# 布局说明：这里把 pnpm 的隔离布局**摊平**成普通 node_modules 布局
# （`node_modules/@prisma/client` + `node_modules/.prisma/client`），
# Prisma 客户端的解析路径（`@prisma/client` 找 `../.prisma/client`、
# 生成客户端找 `@prisma/client/runtime/library.js`）在两种布局下都成立。
FROM deps AS prisma-runtime
RUN set -eu; \
    client_pkg="$(ls -d node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client)"; \
    generated="$(ls -d node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client)"; \
    mkdir -p /out/node_modules/@prisma /out/node_modules/.prisma; \
    cp -a "$client_pkg" /out/node_modules/@prisma/client; \
    cp -a "$generated" /out/node_modules/.prisma/client; \
    rm -rf /out/node_modules/@prisma/client/node_modules

# ─── builder ───────────────────────────────────────────────────────
FROM deps AS builder
# 构建期占位连接串：next build 不会真的连库，真实值运行时注入。
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build"
COPY . .
RUN pnpm run build

# ─── runner（应用服务）─────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]

# ─── worker（定时任务容器）────────────────────────────────────────
# 采集 cron 的**唯一归属**在这里：应用容器不再采集（多副本会重复采集）。
FROM base AS worker
ENV NODE_ENV=production
ENV WORKER_PORT=3001
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 worker
WORKDIR /app
# Prisma 客户端运行时：采集的入库要用它（见 prisma-runtime 阶段）。
COPY --from=prisma-runtime --chown=worker:nodejs /out/node_modules ./node_modules
# 打包产物：定时任务容器的唯一入口（采集 cron 也从这里启动）。
COPY --from=builder --chown=worker:nodejs /app/dist/worker.mjs ./worker.mjs
# schema 随行：排查问题时能直接对照（不参与运行时）。
COPY --from=deps --chown=worker:nodejs /app/prisma ./prisma
# 采集的磁盘缓存目录：worker 以非 root 跑（uid 1001），必须能写。
RUN mkdir -p /app/.cache/collector && chown -R worker:nodejs /app/.cache
USER worker
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/healthz || exit 1
CMD ["node", "worker.mjs"]

# ─── caddy（反向代理，非 root）────────────────────────────────────
# 官方 caddy:2-alpine 没有非 root 用户（默认以 root 跑），这里补一个，
# 并把 /data、/config 交给它 —— 这两个目录是 Caddy 的 XDG 数据/配置目录。
FROM caddy:2-alpine AS caddy
RUN addgroup -g 1000 caddy \
 && adduser -D -u 1000 -G caddy caddy \
 && chown -R caddy:caddy /data /config
USER caddy
EXPOSE 8080

# ─── migrate（一次性迁移容器）─────────────────────────────────────
FROM deps AS migrate
COPY prisma ./prisma
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy"]
