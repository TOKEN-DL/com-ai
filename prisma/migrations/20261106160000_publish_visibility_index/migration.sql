-- #11 补一个索引：下架过滤（NOT EXISTS 子查询）要用它。
--
-- 检索与列表都会判断「这个资产有没有非 PUBLISHED 的发布记录」：
--
--     NOT EXISTS (
--       SELECT 1 FROM "UserPublishedAsset" upa
--       WHERE upa."assetId" = "Asset"."id" AND upa."status" <> 'PUBLISHED'
--     )
--
-- 没有这个索引时，这条相关子查询要对每一条资产做一次全表扫 ——
-- 资产量到万级就会把检索拖垮。(assetId, status) 复合索引让它走索引扫描。
--
-- ⚠️ 迁移目录名的时间戳必须排在 20261106153000_add_user_publish_workflow 之后
--    —— 那个迁移才加的 "status" 列。

-- CreateIndex
CREATE INDEX "UserPublishedAsset_assetId_status_idx" ON "UserPublishedAsset"("assetId", "status");
