-- 采集运维（票 #6）：三档保留策略的归档标记 + 采集运行记录 + 采集告警记录。
--
-- 1) "Asset"."archivedAt" —— 归档标记。
--      null      = 热（在保留窗口期内，前端可见）
--      非空      = 归档（超期但高热度：保留于库、前端隐藏）
--    超期且低热度的条目由保留策略物理删除，不会落到归档态。
--
-- 2) "CollectionRun" —— 每个采集源每次运行的记录。
--    健康检查端点与「连续失败告警」都读它。
--
-- 3) "CollectionAlert" —— 采集告警记录。
--    解析器失效 / 源结构变更时落一条，未确认的告警在健康端点里暴露出来。

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "CollectionRunStatus" AS ENUM ('OK', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "CollectionAlertSeverity" AS ENUM ('WARNING', 'ERROR');

-- CreateTable
CREATE TABLE "CollectionRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" "CollectionRunStatus" NOT NULL,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "written" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CollectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionAlert" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" "CollectionAlertSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "CollectionAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_archivedAt_idx" ON "Asset"("archivedAt");

-- CreateIndex
CREATE INDEX "CollectionRun_source_startedAt_idx" ON "CollectionRun"("source", "startedAt");

-- CreateIndex
CREATE INDEX "CollectionAlert_source_createdAt_idx" ON "CollectionAlert"("source", "createdAt");

-- CreateIndex
CREATE INDEX "CollectionAlert_acknowledgedAt_idx" ON "CollectionAlert"("acknowledgedAt");
