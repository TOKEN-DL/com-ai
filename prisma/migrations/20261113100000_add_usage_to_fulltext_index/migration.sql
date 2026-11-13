-- 重建全文索引：把「何时用 / 怎么用」纳入检索范围（票 #28）。
--
-- 站上的核心差异就是这两个字段 —— 它们不进检索，等于最想被搜到的那部分内容
-- 搜不到。实测：站上 1110 条资产的「何时用」含「适用于」，搜这个词只命中 140 条，
-- 970 条够不着。
--
-- ⚠️ 表达式索引**改不了定义**，只能 DROP + CREATE。
--
-- ⚠️ 这段表达式必须与 `src/lib/search-expression.ts` 的
--    `ASSET_FULLTEXT_EXPRESSION` **逐字一致** —— 不一致 Postgres 就不会用上索引
--    （那 140 条的教训）。`test/search-fulltext-index.test.ts` 盯着这件事。
--
-- 权重顺序即相关度顺序：标题 A > 简介 B > 何时用 C > 怎么用 D。
--
-- 合规：METADATA_ONLY 档的这两列由数据库触发器清空（人工撰写的除外 ——
-- 那是人写的，不是原文摘抄），所以索引里不会混进受版权保护的原文。

DROP INDEX IF EXISTS "Asset_fulltext_idx";

CREATE INDEX "Asset_fulltext_idx" ON "Asset" USING GIN (
    (setweight(to_tsvector('simple', coalesce("displayName", '')), 'A') ||
     setweight(to_tsvector('simple', coalesce("summaryZh", '')), 'B') ||
     setweight(to_tsvector('simple', coalesce("whenToUse", '')), 'C') ||
     setweight(to_tsvector('simple', coalesce("howToUse", '')), 'D'))
);
