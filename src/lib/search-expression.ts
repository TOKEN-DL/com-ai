/**
 * 检索层用的 SQL 表达式。
 *
 * ⚠️ 这些表达式必须与数据库里的索引定义**逐字一致**，否则 Postgres 不会用上索引。
 *    对应的索引建在 `prisma/migrations/20261106000000_init/migration.sql` 末尾
 *    （手写 SQL，Prisma 的 schema DSL 表达不了表达式索引）。
 *
 * #5 实现 SearchService 时直接复用这里的常量，别再另写一份。
 */

/**
 * 资产全文检索表达式：标题权重 A，简介权重 B。
 *
 * 用 'simple' 配置：它不切分中文，中文串会被当成一个 token
 * （所以中文检索要靠 pg_trgm，见 {@link ASSET_TRGM_COLUMNS}）。
 */
export const ASSET_FULLTEXT_EXPRESSION =
  `setweight(to_tsvector('simple', coalesce("displayName", '')), 'A') || ` +
  `setweight(to_tsvector('simple', coalesce("summaryZh", '')), 'B')`;

/** 建了 pg_trgm 三元组索引的列，供 ILIKE / similarity() 模糊匹配使用。 */
export const ASSET_TRGM_COLUMNS = ['"displayName"', '"slug"'] as const;
