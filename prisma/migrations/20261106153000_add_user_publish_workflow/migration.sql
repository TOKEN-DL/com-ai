-- #11 用户发布自己的资产：审核状态机 + 二期（版本 / 依赖）预留字段
--
-- 这次迁移是**纯加法**：只加列、加枚举、建索引，不改任何已有表的行为。
-- 二期（#16 版本管理、#17 依赖声明）上线时往这些列里写值即可，
-- 不需要迁移全表（票 #11 的验收标准第 5 条）。
--
-- 枚举 PublishStatus 的三个状态（spec 决策 11）：
--   PUBLISHED —— 默认状态。新发布**直接可见**，不做全量预审队列
--                （单人运营下预审会立刻成为瓶颈）。
--   PENDING   —— 审核中。命中自动关键词过滤、或被用户举报 → 已下架，等人工抽查。
--   REJECTED  —— 已拒绝。运营判定违规，已下架，审核意见对发布者可见。

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "currentVersion" TEXT;

-- AlterTable
ALTER TABLE "UserPublishedAsset" ADD COLUMN     "status" "PublishStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "filteredReason" TEXT,
ADD COLUMN     "reportedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT,
ADD COLUMN     "latestVersion" TEXT,
ADD COLUMN     "manifestPath" TEXT,
ADD COLUMN     "manifestHash" TEXT,
ADD COLUMN     "dependencyManifest" JSONB;

-- CreateIndex
CREATE INDEX "UserPublishedAsset_status_idx" ON "UserPublishedAsset"("status");

-- CreateIndex
CREATE INDEX "UserPublishedAsset_userId_publishedAt_idx" ON "UserPublishedAsset"("userId", "publishedAt");
