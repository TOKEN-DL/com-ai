/**
 * 检索层用的 SQL 表达式。
 *
 * ⚠️ 这些表达式必须与数据库里的索引定义**逐字一致**，否则 Postgres 不会用上索引。
 *    对应的索引建在 `prisma/migrations/20261106000000_init/migration.sql` 末尾
 *    （手写 SQL，Prisma 的 schema DSL 表达不了表达式索引），
 *    「何时用 / 怎么用」是后来加进来的（票 #28），见
 *    `prisma/migrations/20261113100000_add_usage_to_fulltext_index/migration.sql`。
 *
 * #5 实现 SearchService 时直接复用这里的常量，别再另写一份。
 */

/**
 * 资产全文检索表达式：标题权重 A，简介权重 B，何时用权重 C，怎么用权重 D。
 *
 * 用 'simple' 配置：它不切分中文，中文串会被当成一个 token
 * （所以中文检索要靠 pg_trgm，见 {@link ASSET_TRGM_COLUMNS}）。
 *
 * ## 为什么「何时用 / 怎么用」在索引里（票 #28）
 *
 * 站上的核心差异就是这两个字段 —— 它们不进检索，等于**最想被搜到的那部分内容
 * 搜不到**。实测：站上 1110 条资产的「何时用」含「适用于」，而搜这个词只能
 * 命中 140 条 —— 970 条够不着。
 *
 * ⚠️ 合规：METADATA_ONLY 档的这两列由数据库触发器清空（人工撰写的除外，
 *    那是人写的、不是原文摘抄），所以索引里不会混进受版权保护的原文。
 *
 * 权重顺序即相关度顺序：标题 > 简介 > 何时用 > 怎么用。
 */
export const ASSET_FULLTEXT_EXPRESSION =
  `setweight(to_tsvector('simple', coalesce("displayName", '')), 'A') || ` +
  `setweight(to_tsvector('simple', coalesce("summaryZh", '')), 'B') || ` +
  `setweight(to_tsvector('simple', coalesce("whenToUse", '')), 'C') || ` +
  `setweight(to_tsvector('simple', coalesce("howToUse", '')), 'D')`;

/** 建了 pg_trgm 三元组索引的列，供 ILIKE / similarity() 模糊匹配使用。 */
export const ASSET_TRGM_COLUMNS = ['"displayName"', '"slug"'] as const;
