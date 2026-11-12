-- 场景卡片：新增一类资产 + 一张场景卡片扩展表（票 #12）。
--
-- 两件事：
--   1. `AssetKind` 加一个 `SCENARIO` 值 —— 场景卡片是**独立的资产行**，
--      这样它天然能被统一检索（#5）命中、能挂评论（#10）、能统计。
--   2. 新增 `ScenarioDetail` —— 记「这张卡片是从哪个资产的哪个场景派生出来的」，
--      并用唯一约束把「同一资产 + 同一场景只出现一次」钉在数据库上。
--
-- ⚠️ `ALTER TYPE ... ADD VALUE` 在 Postgres 12+ 允许在事务里执行，
--    但**新增的枚举值不能在同一个事务里被使用**。
--    所以这里只加枚举值，建表 / 建索引 / 建外键都不碰它 —— 符合这条限制。

-- ─── 1. 资产类型新增「场景卡片」──────────────────────────────────────
ALTER TYPE "AssetKind" ADD VALUE 'SCENARIO';

-- ─── 2. 场景卡片扩展表 ──────────────────────────────────────────────
CREATE TABLE "ScenarioDetail" (
    "assetId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "sourceAssetSlug" TEXT NOT NULL,
    "scenarioText" TEXT NOT NULL,
    "scenarioKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioDetail_pkey" PRIMARY KEY ("assetId")
);

-- 去重规则：同一资产 + 同一场景，只允许一张卡片。
CREATE UNIQUE INDEX "ScenarioDetail_sourceAssetId_scenarioKey_key"
    ON "ScenarioDetail"("sourceAssetId", "scenarioKey");
CREATE INDEX "ScenarioDetail_sourceAssetId_idx" ON "ScenarioDetail"("sourceAssetId");
CREATE INDEX "ScenarioDetail_sourceAssetSlug_idx" ON "ScenarioDetail"("sourceAssetSlug");

-- 卡片被删 → 扩展行跟着没（卡片是「附属品」）。
-- 源资产被删 → 扩展行也跟着没；卡片本身变成孤儿，由派生服务清理
-- （见 src/lib/scenario-service.ts 的 pruneOrphanScenarioCards）。
ALTER TABLE "ScenarioDetail" ADD CONSTRAINT "ScenarioDetail_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScenarioDetail" ADD CONSTRAINT "ScenarioDetail_sourceAssetId_fkey"
    FOREIGN KEY ("sourceAssetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
