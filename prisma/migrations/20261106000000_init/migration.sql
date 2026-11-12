-- com-ai 初始迁移：Asset 主表 + contentTier 枚举位 + 检索地基
--
-- #2 只落「地基」。其余表（SkillDetail / McpDetail / PromptDetail / AssetVersion /
-- AssetDependency / Favorite / Like / Comment / User / Session ...）由 #3 补齐。
--
-- ⚠️ 下面「检索索引」一段是手写 SQL：Prisma 的 schema DSL 表达不了
--    表达式索引与 gin_trgm_ops 操作符类。`prisma migrate dev` 可能会把它们
--    当成漂移要删掉 —— 遇到时用 `prisma migrate dev --create-only`，
--    然后把这段原样贴回去。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('SKILL', 'MCP', 'PROMPT');

-- CreateEnum
CREATE TYPE "ContentTier" AS ENUM ('FULL', 'METADATA_ONLY');

-- CreateEnum
CREATE TYPE "SummarySource" AS ENUM ('LLM', 'HUMAN', 'TEMPLATE');

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "summaryZh" TEXT,
    "summarySource" "SummarySource",
    "repoOwner" TEXT,
    "repoName" TEXT,
    "repoUrl" TEXT,
    "license" TEXT,
    "contentTier" "ContentTier" NOT NULL DEFAULT 'METADATA_ONLY',
    "upstreamUrl" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "installs" INTEGER NOT NULL DEFAULT 0,
    "heatScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sourceId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_slug_key" ON "Asset"("slug");

-- CreateIndex
CREATE INDEX "Asset_kind_idx" ON "Asset"("kind");

-- CreateIndex
CREATE INDEX "Asset_contentTier_idx" ON "Asset"("contentTier");

-- CreateIndex
CREATE INDEX "Asset_heatScore_idx" ON "Asset"("heatScore");

-- CreateIndex
CREATE INDEX "Asset_sourceId_idx" ON "Asset"("sourceId");

-- ─── 检索索引（手写）──────────────────────────────────────────────
-- 检索走 Postgres 全文 + pg_trgm（spec 约束 4：一期不用 pgvector / Redis）。
-- 查询时必须用与索引完全相同的表达式，索引才会被用上；
-- 表达式常量见 src/lib/search-expression.ts（#5 的 SearchService 直接复用）。
--
-- 注意：表达式索引里的 || 必须再套一层括号 —— CREATE INDEX 的语法里
-- 表达式后面还跟着 opclass / COLLATE 子句，单层括号会被解析成
-- "syntax error at or near ||"。

-- 标题与 slug 的三元组索引：支撑 similarity() / ILIKE 的模糊匹配。
CREATE INDEX "Asset_displayName_trgm_idx" ON "Asset" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX "Asset_slug_trgm_idx" ON "Asset" USING GIN ("slug" gin_trgm_ops);

-- 全文索引：标题权重高于简介。
CREATE INDEX "Asset_fulltext_idx" ON "Asset" USING GIN (
    (setweight(to_tsvector('simple', coalesce("displayName", '')), 'A') ||
     setweight(to_tsvector('simple', coalesce("summaryZh", '')), 'B'))
);
