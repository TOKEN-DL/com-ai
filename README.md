# com-ai

面向中文 AI 开发者的 Agent 资产市场。

方案全文见 [`docs/specs/com-ai-marketplace-spec.md`](docs/specs/com-ai-marketplace-spec.md)。

## 快速开始

前置条件：Docker Desktop（或兼容的 Docker Engine）+ Node.js 22+ + pnpm 10。

```bash
docker compose up -d --build
```

然后打开 <http://localhost:8080>（Caddy 反向代理）。首页会显示 Postgres 的连通状态。

不需要先准备 `.env`：compose 自带**开发默认值**。要改端口或口令就复制一份模板：

```bash
cp .env.example .env
```

`.env` 已被 `.gitignore` 排除 —— 任何口令 / 令牌都不要提交。

### 服务编排

| 服务 | 作用 | 宿主机端口 |
| --- | --- | --- |
| `postgres` | 开发库，具名卷持久化 | 5432 |
| `postgres-test` | 测试库，harness 用它派生每轮独立库 | 5433 |
| `migrate` | 一次性容器，跑 `prisma migrate deploy` | —— |
| `app` | Next.js 应用（standalone 镜像，非 root） | 3000 |
| `cron` | 定时任务容器（node-cron，非 root） | —— |
| `caddy` | 反向代理（非 root，容器内 8080） | 8080 |

数据库凭据一律经环境变量在运行时注入，**不写进镜像**；所有容器都以非 root 用户运行。

```bash
docker compose logs -f app        # 看应用日志
docker compose down               # 停掉（保留数据卷）
docker compose down -v            # 连数据卷一起删
```

### 数据持久化

`postgres` 与 `postgres-test` 各挂一个具名卷（`postgres-data` / `postgres-test-data`）。
`docker compose down` / 重建容器都不会丢数据，只有 `down -v` 才会。

## 本地开发（不用 Docker 起应用）

应用与测试都只需要一个 Postgres：

```bash
pnpm install
docker compose up -d postgres postgres-test
pnpm prisma:migrate      # 建表
pnpm dev                 # http://localhost:3000
```

## 测试

```bash
pnpm test
```

vitest 的 harness 跑在**真实 Postgres** 上，不用内存替身 —— 全文检索与 `pg_trgm`
的行为只有在真实 PG 上才作数（spec 的硬性要求）。

每轮测试运行：

1. 在测试库里建一个唯一命名的数据库 `test_<随机>`；
2. 把 Prisma 迁移应用到它上面；
3. 测试跑完后删掉这个库。

唯一命名让**并行 worktree 互不干扰**；每个测试前清库保证**各测试之间数据隔离**。
测试库地址由 `TEST_DATABASE_ADMIN_URL` 决定，默认指向 compose 的 `postgres-test`
（`localhost:5433`）。

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在每次 push 与 PR 上跑
`lint` + `typecheck` + `test`，全绿才算通过。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` | 构建应用与定时任务容器用的产物 |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | vitest（需要 Postgres） |
| `pnpm prisma:migrate` | 生成并应用迁移 |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm sync:versions` | 同步上游版本：有新 commit 就记版本、生成变更日志、回写内容（`--limit N` 控制一轮扫多少个，受 GitHub 配额限制） |
| `pnpm compose:up` / `compose:down` | 便捷脚本 |

## 技术栈

Next.js（App Router）+ TypeScript + Prisma + Postgres + vitest + pnpm。

检索走 Postgres 全文 + `pg_trgm`，**不用** pgvector / Redis / 外部 rerank。
检索用到的 SQL 表达式集中在 [`src/lib/search-expression.ts`](src/lib/search-expression.ts)，
必须与迁移里的索引定义逐字一致 —— 详见该文件注释。

## 依赖清单（发布者声明依赖）

发布自己的资产时可以声明「我依赖了哪些站内资产」。清单放在仓库里
（建议文件名 `com-ai.manifest.yaml`，**JSON 也行**），发布时把内容贴进表单：

```yaml
version: 1
dependencies:
  - slug: pdf-batch-processor   # 被依赖资产在平台上的 slug（必填）
    kind: SKILL                 # 被依赖资产的类型（可选，会与实际类型交叉校验）
    version: ">=1.2.0"          # 版本约束（可选，**只展示，不做版本求解**）
```

规则：

- 依赖目标用**平台 slug** 标识，且必须**已经在平台上**——否则整条发布被拒
  （先把它发布上来，再声明这依赖）。
- 清单是**完整声明**：重新发布时以新清单为准，清单里删掉的依赖就解除了；
  不带清单重新发布则保持原样。
- 格式非法会**明确报错**（哪个字段、第几行、期望什么），不会静默忽略，
  也不会写一半。解析规则见 [`src/lib/dependency-manifest.ts`](src/lib/dependency-manifest.ts)。

依赖关系会展示在资产详情页（依赖了谁 / 被谁依赖），也可以被检索：
`/search?dependsOn=pdf-batch-processor` 列出依赖了它的资产；
搜「pdf」时，依赖了 PDF 工具的资产同样会被搜出来。

## 构建说明

- **不跑依赖的 build scripts**（`pnpm.ignoredBuiltDependencies`）。Prisma 6.19 的
  客户端自带 WASM 查询编译器（`@prisma/client/runtime/query_engine_bg.postgresql.*`），
  不需要另外下载原生引擎；跳过 postinstall 也让 Docker 构建少一个联网下载点。
  客户端由 `scripts/postinstall.mjs` 里的 `prisma generate` 生成。
- **定时任务容器打的是单文件 ESM 产物**（`dist/worker.mjs`）。必须是 ESM：node-cron v4
  是 ESM 包，内部用 `import.meta.url` 定位自己的文件，打成 CJS 会直接崩。
  打包脚本见 [`scripts/build-worker.mjs`](scripts/build-worker.mjs)。

