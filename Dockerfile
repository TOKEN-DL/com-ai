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
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1
CMD ["node", "server.js"]

# ─── worker（定时任务容器）────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production
ENV WORKER_PORT=3001
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 worker
WORKDIR /app
COPY --from=builder --chown=worker:nodejs /app/dist/worker.cjs ./worker.cjs
USER worker
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/healthz || exit 1
CMD ["node", "worker.cjs"]

# ─── migrate（一次性迁移容器）─────────────────────────────────────
FROM deps AS migrate
COPY prisma ./prisma
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy"]
