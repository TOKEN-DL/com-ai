-- CreateEnum
CREATE TYPE "VersionOrigin" AS ENUM ('UPSTREAM', 'PLATFORM');

-- CreateEnum
CREATE TYPE "DependencyKind" AS ENUM ('SKILL', 'MCP', 'PROMPT', 'PACKAGE', 'HOST', 'OTHER');

-- CreateEnum
CREATE TYPE "PromptModality" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'MUSIC');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('VISIBLE', 'PENDING', 'HIDDEN', 'DELETED');

-- CreateEnum
CREATE TYPE "ReportTarget" AS ENUM ('ASSET', 'COMMENT');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'ILLEGAL', 'COPYRIGHT', 'INFRINGING', 'OFFENSIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN');

-- DropIndex
DROP INDEX "Asset_displayName_trgm_idx";

-- DropIndex
DROP INDEX "Asset_slug_trgm_idx";

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "contentBody" TEXT,
ADD COLUMN     "favoriteCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "LicensePolicy" (
    "spdxId" TEXT NOT NULL,
    "tier" "ContentTier" NOT NULL,
    "note" TEXT,

    CONSTRAINT "LicensePolicy_pkey" PRIMARY KEY ("spdxId")
);

-- CreateTable
CREATE TABLE "SkillDetail" (
    "assetId" TEXT NOT NULL,
    "frontmatter" JSONB,
    "whenToUse" TEXT,
    "howToUse" TEXT,
    "installCmds" JSONB,
    "hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skillPath" TEXT,
    "extraFiles" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillDetail_pkey" PRIMARY KEY ("assetId")
);

-- CreateTable
CREATE TABLE "McpDetail" (
    "assetId" TEXT NOT NULL,
    "transport" TEXT,
    "packages" JSONB,
    "remotes" JSONB,
    "tools" JSONB,
    "envVars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ports" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "configJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpDetail_pkey" PRIMARY KEY ("assetId")
);

-- CreateTable
CREATE TABLE "PromptDetail" (
    "assetId" TEXT NOT NULL,
    "modality" "PromptModality" NOT NULL DEFAULT 'TEXT',
    "act" TEXT,
    "promptBody" TEXT,
    "forDevs" TEXT,
    "contributor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptDetail_pkey" PRIMARY KEY ("assetId")
);

-- CreateTable
CREATE TABLE "AssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "origin" "VersionOrigin" NOT NULL,
    "changelog" TEXT,
    "snapshot" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetDependency" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" "DependencyKind" NOT NULL,
    "constraint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "githubLogin" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Like" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "userId" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Like_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "status" "CommentStatus" NOT NULL DEFAULT 'VISIBLE',
    "filteredReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "target" "ReportTarget" NOT NULL,
    "assetId" TEXT,
    "commentId" TEXT,
    "reporterUserId" TEXT,
    "reason" "ReportReason" NOT NULL,
    "detail" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPublishedAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "UserPublishedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInstall" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "host" TEXT,
    "version" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetVersion_assetId_origin_idx" ON "AssetVersion"("assetId", "origin");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_assetId_version_origin_key" ON "AssetVersion"("assetId", "version", "origin");

-- CreateIndex
CREATE INDEX "AssetDependency_toId_idx" ON "AssetDependency"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDependency_fromId_toId_kind_key" ON "AssetDependency"("fromId", "toId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubLogin_key" ON "User"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Favorite_userId_idx" ON "Favorite"("userId");

-- CreateIndex
CREATE INDEX "Favorite_deviceId_idx" ON "Favorite"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Favorite_assetId_actorKey_key" ON "Favorite"("assetId", "actorKey");

-- CreateIndex
CREATE INDEX "Like_userId_idx" ON "Like"("userId");

-- CreateIndex
CREATE INDEX "Like_deviceId_idx" ON "Like"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_assetId_actorKey_key" ON "Like"("assetId", "actorKey");

-- CreateIndex
CREATE INDEX "Comment_assetId_createdAt_idx" ON "Comment"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_userId_idx" ON "Comment"("userId");

-- CreateIndex
CREATE INDEX "Comment_status_idx" ON "Comment"("status");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "Report_assetId_idx" ON "Report"("assetId");

-- CreateIndex
CREATE INDEX "Report_commentId_idx" ON "Report"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPublishedAsset_userId_assetId_key" ON "UserPublishedAsset"("userId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "UserInstall_userId_assetId_key" ON "UserInstall"("userId", "assetId");

-- CreateIndex
CREATE INDEX "Asset_kind_heatScore_idx" ON "Asset"("kind", "heatScore");

-- CreateIndex
CREATE INDEX "Asset_repoOwner_repoName_idx" ON "Asset"("repoOwner", "repoName");

-- AddForeignKey
ALTER TABLE "SkillDetail" ADD CONSTRAINT "SkillDetail_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpDetail" ADD CONSTRAINT "McpDetail_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptDetail" ADD CONSTRAINT "PromptDetail_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDependency" ADD CONSTRAINT "AssetDependency_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetDependency" ADD CONSTRAINT "AssetDependency_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Like" ADD CONSTRAINT "Like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPublishedAsset" ADD CONSTRAINT "UserPublishedAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPublishedAsset" ADD CONSTRAINT "UserPublishedAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInstall" ADD CONSTRAINT "UserInstall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInstall" ADD CONSTRAINT "UserInstall_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════
-- #3 追加一：许可证分层在**写入路径**上的强制执行
-- ═══════════════════════════════════════════════════════════════════════
--
-- 为什么放在数据库层：spec 约束 1 要求「绕过服务层直接调底层写入，仍得到相同结果」。
-- 约束只写在应用服务里是不够的 —— 脚本、后台任务、数据迁移都可能绕过它。
-- 这里的触发器是兜底：无论从哪条路径写进来，落库的结果都一样。
--
-- 规则只有一份定义（src/lib/license-tier.ts 是它的纯函数版本）：
--   R1  license 归一化：去首尾空白、转小写；空串视为「未声明许可证」→ NULL。
--   R2  档位推导：contentTier 由 license 唯一决定，调用方传入的值一律被覆盖。
--       命中 LicensePolicy 的允许再分发许可 → FULL；
--       其余（未知 / 缺失 / 限制性）→ METADATA_ONLY。
--   R3  METADATA_ONLY 不落「基于原文的内容」：
--       Asset.contentBody 清空；summarySource='LLM' 时 summaryZh 一并清空；
--       AssetVersion.snapshot 清空；PromptDetail.promptBody 清空；
--       SkillDetail.whenToUse / howToUse 清空（按 spec 决策 7，这两个字段由原文生成）。
--
-- ⚠️ 触发器与函数对 Prisma 不可见（Prisma 不管理函数 / 触发器）。
--    `prisma migrate dev` 若把它们当成漂移要删，用 --create-only 后把本段原样贴回。

-- ─── 许可证 → 档位映射表 ────────────────────────────────────────────
-- 只登记「允许再分发」的许可；表里查不到就是 METADATA_ONLY。
-- 这份名单与 src/lib/license-tier.ts 的 REDISTRIBUTABLE_LICENSES 必须一致，
-- 一致性由 test/asset-content-tier.test.ts 断言。
INSERT INTO "LicensePolicy" ("spdxId", "tier", "note") VALUES
  ('0bsd',          'FULL', 'BSD Zero Clause License：等同 MIT'),
  ('apache-2.0',    'FULL', 'Apache License 2.0：允许再分发，需保留许可与声明'),
  ('blueoak-1.0.0', 'FULL', 'Blue Oak Model License 1.0.0：宽松许可'),
  ('bsd-2-clause',  'FULL', 'BSD 2-Clause Simplified License'),
  ('bsd-3-clause',  'FULL', 'BSD 3-Clause New or Revised License'),
  ('cc-by-4.0',     'FULL', 'Creative Commons Attribution 4.0：允许再分发，需署名'),
  ('cc-by-sa-4.0',  'FULL', 'Creative Commons Attribution-ShareAlike 4.0：允许再分发，需署名与相同方式共享'),
  ('cc0-1.0',       'FULL', 'CC0 1.0 Universal：公共领域贡献，不要求署名'),
  ('isc',           'FULL', 'ISC License：等同 MIT'),
  ('mit',           'FULL', 'MIT License'),
  ('mit-0',         'FULL', 'MIT No Attribution'),
  ('python-2.0',    'FULL', 'Python License 2.0：BSD 风格'),
  ('unlicense',     'FULL', 'The Unlicense：公共领域贡献')
ON CONFLICT ("spdxId") DO NOTHING;

-- ─── R1 + R2 + R3：Asset 主表 ───────────────────────────────────────
CREATE OR REPLACE FUNCTION "comai_apply_content_tier"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tier "ContentTier";
BEGIN
  -- R1：license 归一化为小写 SPDX id；空串视为未声明。
  NEW."license" := NULLIF(lower(btrim(COALESCE(NEW."license", ''))), '');

  -- R2：档位由 license 唯一推导，调用方传入的 contentTier 不作数。
  v_tier := COALESCE(
    (SELECT "tier" FROM "LicensePolicy" WHERE "spdxId" = NEW."license"),
    'METADATA_ONLY'::"ContentTier"
  );
  NEW."contentTier" := v_tier;

  -- R3：METADATA_ONLY 档位不落基于原文的内容。
  IF v_tier = 'METADATA_ONLY'::"ContentTier" THEN
    NEW."contentBody" := NULL;
    -- LLM 生成的简介必然基于原文；人工 / 模板撰写的描述保留。
    IF NEW."summarySource" = 'LLM'::"SummarySource" THEN
      NEW."summaryZh" := NULL;
      NEW."summarySource" := NULL;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Asset_content_tier_guard" ON "Asset";
CREATE TRIGGER "Asset_content_tier_guard"
  BEFORE INSERT OR UPDATE ON "Asset"
  FOR EACH ROW EXECUTE FUNCTION "comai_apply_content_tier"();

-- ─── R3：版本快照 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "comai_guard_asset_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tier "ContentTier";
BEGIN
  SELECT "contentTier" INTO v_tier FROM "Asset" WHERE "id" = NEW."assetId";
  IF v_tier = 'METADATA_ONLY'::"ContentTier" THEN
    NEW."snapshot" := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "AssetVersion_snapshot_guard" ON "AssetVersion";
CREATE TRIGGER "AssetVersion_snapshot_guard"
  BEFORE INSERT OR UPDATE ON "AssetVersion"
  FOR EACH ROW EXECUTE FUNCTION "comai_guard_asset_version"();

-- ─── R3：Prompt 正文 ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "comai_guard_prompt_detail"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tier "ContentTier";
BEGIN
  SELECT "contentTier" INTO v_tier FROM "Asset" WHERE "id" = NEW."assetId";
  IF v_tier = 'METADATA_ONLY'::"ContentTier" THEN
    NEW."promptBody" := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "PromptDetail_body_guard" ON "PromptDetail";
CREATE TRIGGER "PromptDetail_body_guard"
  BEFORE INSERT OR UPDATE ON "PromptDetail"
  FOR EACH ROW EXECUTE FUNCTION "comai_guard_prompt_detail"();

-- ─── R3：Skill 的「何时用 / 怎么用」（按 spec 决策 7 由原文生成）──────
CREATE OR REPLACE FUNCTION "comai_guard_skill_detail"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tier "ContentTier";
BEGIN
  SELECT "contentTier" INTO v_tier FROM "Asset" WHERE "id" = NEW."assetId";
  IF v_tier = 'METADATA_ONLY'::"ContentTier" THEN
    NEW."whenToUse" := NULL;
    NEW."howToUse" := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SkillDetail_summary_guard" ON "SkillDetail";
CREATE TRIGGER "SkillDetail_summary_guard"
  BEFORE INSERT OR UPDATE ON "SkillDetail"
  FOR EACH ROW EXECUTE FUNCTION "comai_guard_skill_detail"();

-- ─── 举报对象：资产或评论，二选一 ───────────────────────────────────
-- Prisma 的 schema DSL 表达不了 CHECK 约束；与检索索引一样属于手写 SQL。
DO $$
BEGIN
  ALTER TABLE "Report" ADD CONSTRAINT "Report_single_target_check"
    CHECK (
      ("target" = 'ASSET'   AND "assetId"   IS NOT NULL AND "commentId" IS NULL)
      OR
      ("target" = 'COMMENT' AND "commentId" IS NOT NULL AND "assetId"   IS NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- #3 追加二：把 #2 建在 init 迁移里的检索索引补回来
-- ═══════════════════════════════════════════════════════════════════════
-- Prisma 的 diff 看不到表达式索引与 gin_trgm_ops 操作符类，
-- 会把它们当成漂移删掉（上面的 DROP INDEX 两行）——这里原样补回。
-- 表达式常量见 src/lib/search-expression.ts（#5 的 SearchService 直接复用）。

CREATE INDEX IF NOT EXISTS "Asset_displayName_trgm_idx" ON "Asset" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Asset_slug_trgm_idx" ON "Asset" USING GIN ("slug" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Asset_fulltext_idx" ON "Asset" USING GIN (
    (setweight(to_tsvector('simple', coalesce("displayName", '')), 'A') ||
     setweight(to_tsvector('simple', coalesce("summaryZh", '')), 'B'))
);
