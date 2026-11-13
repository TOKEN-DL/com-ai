/**
 * SearchService 的 Postgres 实现（票 #5）。
 *
 * 一期实现（spec 决策 8「检索层」）：**全文检索 + pg_trgm 模糊匹配 + 标签矩阵过滤**，
 * 三者加权融合。不引入 pgvector / Redis / 外部 rerank（一期明确不用）。
 *
 * ## 三路证据与权重
 *
 * 三路证据的量纲不一样，直接相加没有意义，所以各自归一化后再加权：
 *
 * | 通道 | 取值 | 权重 | 作用 |
 * | --- | --- | --- | --- |
 * | 全文（标题 A + 简介 B） | `ts_rank_cd(..., 32)` ∈ [0,1] | 1.0 | 主排序依据 |
 * | 全文（正文 C，仅 FULL 档） | `ts_rank_cd(..., 32)` ∈ [0,1] | 0.6 | 正文命中补充 |
 * | pg_trgm 模糊 | `similarity()` ∈ [0,1] | 0.5 | 拼写接近 / 词序不同 |
 * | ILIKE 包含命中 | 0 / 1 | 0.4 | 中文短查询兜底 |
 * | 依赖目标的文本（票 #17） | 0 / 1 | 0.5 | 「依赖了具备某种能力的资产」 |
 *
 * `ts_rank_cd` 的第 3 个参数 32 表示归一化（`rank / (rank + 1)`），取值 ∈ [0,1]，
 * 这样各通道的量纲才对得上。
 *
 * ## 中文短查询降级（硬要求）
 *
 * Postgres 的 `simple` 配置**不切分中文**：一整串中文是一个 token，
 * 所以「简介」匹配不上「中文简介生成技能」。实测 2 个中文字符的 `similarity()`
 * 恒为 0（pg_trgm 至少要 3 个字符）。
 *
 * 因此：
 *   - 查询串短于 3 个字符 → **只走 ILIKE 包含匹配**（标题 / slug / 简介 / 正文）；
 *   - 查询串 ≥ 3 个字符 → 全文 + trigram + ILIKE 三路都走，trigram 参与打分。
 *
 * ILIKE 用 `ILIKE ANY(ARRAY['%xxx%']::text[])` 的**字面量**形式：绑定参数形式
 * （`ILIKE $1`）Postgres 只能顺序扫描，字面量数组才能走 `Asset_displayName_trgm_idx`
 * / `Asset_slug_trgm_idx` 的 GIN 索引。字面量里的用户输入用 E'' 转义字符串
 * + LIKE 元字符转义处理（见 {@link sqlLiteral}）。
 *
 * ## 全文表达式必须与索引逐字一致
 *
 * {@link ASSET_FULLTEXT_EXPRESSION} 直接从 `src/lib/search-expression.ts` 引入，
 * 不在这里另写一份 —— 表达式与 `Asset_fulltext_idx` 的定义不一致，Postgres
 * 就不会用上索引。
 */
import { AssetKind, Prisma, PromptModality, type ContentTier } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ASSET_FULLTEXT_EXPRESSION } from "@/lib/search-expression";
import type {
  NormalizedQuery,
  SearchFacetBucket,
  SearchHit,
  SearchQuery,
  SearchResult,
  SearchService,
  SearchSort,
} from "@/lib/search-service";
import { defaultSortFor, SEARCH_SORTS } from "@/lib/search-service";

/** 标题 + 简介的全文表达式。必须与 `Asset_fulltext_idx` 的定义逐字一致。 */
const FTS_TITLE_SUMMARY = Prisma.raw(`(${ASSET_FULLTEXT_EXPRESSION})`);

/** 正文的全文表达式。只有 FULL 档的资产才有正文。 */
const FTS_BODY = Prisma.raw(`setweight(to_tsvector('simple', coalesce("contentBody", '')), 'C')`);

/**
 * trigram 相似度阈值。写进 SQL 字面量（不是绑定参数），Postgres 才能当常量用。
 *
 * 取 0.3 —— 与 pg_trgm 自己的 `similarity_threshold` 默认值一致。
 * 实测：无关条目与「批量处理 PDF」的相似度约 0.21（放进来就是误召回），
 * 而真正的近似命中（PostgreSQL ↔ postgres）能到 0.5。
 */
const TRGM_SIMILARITY_THRESHOLD = 0.3;

/** word_similarity 阈值。 */
const TRGM_WORD_SIMILARITY_THRESHOLD = 0.5;

/** 短查询阈值：比它短的查询串不指望 trigram（实测 2 字中文相似度恒为 0）。 */
const TRGM_MIN_QUERY_LENGTH = 3;

/** 查询词长度上限，防止超长输入拖垮检索。 */
const MAX_QUERY_LENGTH = 200;

/** 默认每页条数 / 每页条数上限。 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** 各通道的权重（同样是 SQL 字面量）。 */
const WEIGHT_FULLTEXT = Prisma.raw("1.0");
const WEIGHT_FULLTEXT_BODY = Prisma.raw("0.6");
const WEIGHT_TRGM = Prisma.raw("0.5");
const WEIGHT_LIKE = Prisma.raw("0.4");
/** 依赖目标的文本命中（票 #17）。 */
const WEIGHT_DEPENDENCY = Prisma.raw("0.5");

/** 取数用的列。 */
const SELECT_COLUMNS = Prisma.raw(
  `"id", "slug", "kind", "displayName", "summaryZh", "whenToUse", "howToUse", ` +
    `"license", "contentTier", "isOfficial", "heatScore", "installs", "trendScore", "stars", ` +
    `"favoriteCount", "likeCount", "repoOwner", "repoName", "repoUrl", "updatedAt"`,
);

/** 取数行。 */
type AssetRow = {
  id: string;
  slug: string;
  kind: AssetKind;
  displayName: string;
  summaryZh: string | null;
  whenToUse: string | null;
  howToUse: string | null;
  license: string | null;
  contentTier: ContentTier;
  isOfficial: boolean;
  heatScore: number;
  installs: number;
  trendScore: number;
  stars: number;
  favoriteCount: number;
  likeCount: number;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  updatedAt: Date;
  score: number;
};

/** 分面计数的行。 */
type FacetRow = {
  value: string | null;
  count: number;
};

/** 过滤维度（分面矩阵的各条轴）。 */
type FilterDimension = "kind" | "license" | "official" | "modality" | "tool";

/**
 * LIKE 模式里的字面量转义：把 \ % _ 变成「只匹配自身」的写法。
 *
 * 不转义的话，用户输入的 `%` 会变成通配符，把「精确包含」变成「模糊匹配」。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * 把用户输入安全地嵌进 SQL 字面量。
 *
 * 用 E'' 转义字符串：反斜杠翻倍、单引号翻倍，两种写法都不会被当成语法，
 * 用户输入里的引号也就无法逃逸出字面量。
 */
function sqlLiteral(value: string): string {
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** 标题 / slug / 简介 / 正文上的「包含」匹配。 */
function buildLikeClause(q: string): Prisma.Sql {
  const pattern = Prisma.raw(sqlLiteral(`%${escapeLikePattern(q)}%`));

  return Prisma.sql`"displayName" ILIKE ANY(ARRAY[${pattern}]::text[])
    OR "slug" ILIKE ANY(ARRAY[${pattern}]::text[])
    OR "summaryZh" ILIKE ANY(ARRAY[${pattern}]::text[])
    OR ("contentTier" = 'FULL' AND "contentBody" ILIKE ANY(ARRAY[${pattern}]::text[]))`;
}

/**
 * 「依赖目标的文本」命中条件（票 #17）。
 *
 * 票里的检索需求是「**依赖了 PDF 处理能力的资产**」——
 * 这句话的主语是**依赖方**，但关键词「PDF 处理」落在**被依赖方**身上。
 * 所以这里把依赖目标的名称 / slug / 简介也算进命中判定：
 * 依赖了 PDF 工具的资产，搜「pdf」时同样会被搜出来。
 *
 * ⚠️ 已归档的依赖目标不参与命中：归档条目前端不可见，
 *    拿它当命中依据等于把用户引向一个看不到的资产。
 */
function buildDependencyTextClause(q: string): Prisma.Sql {
  const pattern = Prisma.raw(sqlLiteral(`%${escapeLikePattern(q)}%`));

  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "AssetDependency" d
    JOIN "Asset" t ON t."id" = d."toId"
    WHERE d."fromId" = "Asset"."id"
      AND t."archivedAt" IS NULL
      AND (t."displayName" ILIKE ANY(ARRAY[${pattern}]::text[])
        OR t."slug" ILIKE ANY(ARRAY[${pattern}]::text[])
        OR t."summaryZh" ILIKE ANY(ARRAY[${pattern}]::text[]))
  )`;
}

/**
 * 「依赖了这些资产」的筛选条件（票 #17）。
 *
 * 值是**被依赖资产的 slug**。
 */
function buildDependsOnClause(slugs: string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "AssetDependency" d
    JOIN "Asset" t ON t."id" = d."toId"
    WHERE d."fromId" = "Asset"."id"
      AND t."slug" IN (${Prisma.join(slugs)})
  )`;
}

/**
 * pg_trgm 模糊匹配。只在查询串够长时启用。
 *
 * 两边都套 `lower()`：`similarity()` 默认**区分大小写**，而全文检索与 ILIKE
 * 都不区分 —— 不统一的话，「批量处理 PDF」里的 "PDF" 就匹配不上「pdf」。
 */
function buildTrgmClause(q: string): Prisma.Sql {
  const threshold = Prisma.raw(String(TRGM_SIMILARITY_THRESHOLD));
  const wordThreshold = Prisma.raw(String(TRGM_WORD_SIMILARITY_THRESHOLD));

  return Prisma.sql`(similarity(lower("displayName"), lower(${q})) >= ${threshold}
    OR similarity(lower("slug"), lower(${q})) >= ${threshold}
    OR word_similarity(lower("displayName"), lower(${q})) >= ${wordThreshold})`;
}

/**
 * 关键词命中条件：全文 / trigram / 包含匹配 / 依赖目标文本 四路的并集。
 *
 * 查询词为空 = 纯浏览，不按关键词过滤。
 */
function buildMatchClause(q: string): Prisma.Sql {
  if (q.length === 0) {
    return Prisma.sql`TRUE`;
  }

  const tsquery = Prisma.sql`plainto_tsquery('simple', ${q})`;
  const fulltextTitleSummary = Prisma.sql`${FTS_TITLE_SUMMARY} @@ ${tsquery}`;
  const fulltextBody = Prisma.sql`${FTS_BODY} @@ ${tsquery}`;
  const like = buildLikeClause(q);
  const trgm =
    q.length >= TRGM_MIN_QUERY_LENGTH ? buildTrgmClause(q) : Prisma.sql`FALSE`;
  // 依赖目标的文本（票 #17）：搜「PDF 处理」时，依赖了 PDF 工具的资产也算命中。
  const dependencyText = buildDependencyTextClause(q);

  return Prisma.sql`(${fulltextTitleSummary} OR ${fulltextBody} OR ${trgm} OR ${like} OR ${dependencyText})`;
}

/** 相关度得分：五路证据加权求和。 */
function buildScoreClause(q: string): Prisma.Sql {
  const tsquery = Prisma.sql`plainto_tsquery('simple', ${q})`;
  const fulltextTitleSummary = Prisma.sql`ts_rank_cd(${FTS_TITLE_SUMMARY}, ${tsquery}, 32)`;
  const fulltextBody = Prisma.sql`ts_rank_cd(${FTS_BODY}, ${tsquery}, 32)`;
  const trgm = Prisma.sql`greatest(similarity(lower("displayName"), lower(${q})), similarity(lower("slug"), lower(${q})))`;
  const likeHit = Prisma.sql`CASE WHEN ${buildLikeClause(q)} THEN 1 ELSE 0 END`;
  // 依赖目标的文本命中（票 #17）：权重与 trigram 同一档 ——
  // 它是一条**间接**证据，不该压过资产自身的标题 / 简介。
  const dependencyHit = Prisma.sql`CASE WHEN ${buildDependencyTextClause(q)} THEN 1 ELSE 0 END`;

  return Prisma.sql`(${WEIGHT_FULLTEXT} * ${fulltextTitleSummary}
    + ${WEIGHT_FULLTEXT_BODY} * ${fulltextBody}
    + ${WEIGHT_TRGM} * ${trgm}
    + ${WEIGHT_LIKE} * ${likeHit}
    + ${WEIGHT_DEPENDENCY} * ${dependencyHit})`;
}

/**
 * 过滤条件（标签矩阵：分类 × 许可证 × 是否有官方版本）。
 *
 * `skip` 用来算分面时排除自己那一维（钻取语义）。
 */
function buildFilterClause(
  filters: NormalizedQuery["filters"],
  skip?: FilterDimension,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];

  if (skip !== "kind" && filters.kind.length > 0) {
    // "kind" 是 Postgres 枚举类型，绑定参数默认按 text 传，
    // 直接比较会报 "operator does not exist: "AssetKind" = text"，所以显式转换。
    const kinds = filters.kind.map((value) => Prisma.sql`${value}::"AssetKind"`);
    parts.push(Prisma.sql`"kind" IN (${Prisma.join(kinds)})`);
  }

  if (skip !== "license" && filters.license.length > 0) {
    const declared = filters.license.filter((value): value is string => value !== null);
    const branches: Prisma.Sql[] = [];

    if (declared.length > 0) {
      branches.push(Prisma.sql`"license" IN (${Prisma.join(declared)})`);
    }
    if (filters.license.includes(null)) {
      branches.push(Prisma.sql`"license" IS NULL`);
    }
    parts.push(Prisma.sql`(${Prisma.join(branches, " OR ")})`);
  }

  if (skip !== "official" && filters.official !== null) {
    parts.push(Prisma.sql`"isOfficial" = ${filters.official}`);
  }

  // ─── Prompt 模态（票 #15）───────────────────────────────────────────
  //
  // 用 EXISTS 子查询而不是 JOIN：检索层只查 Asset 主表，
  // 加 JOIN 会与 `Asset_fulltext_idx` 的全文表达式打架。
  // 只有 PROMPT 类的资产在 PromptDetail 里有行，
  // 所以选了模态就自动把其它类型的资产排除掉了。
  if (skip !== "modality" && filters.modality && filters.modality.length > 0) {
    const modalities = filters.modality.map((value) => Prisma.sql`${value}::"PromptModality"`);
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "PromptDetail" pd
      WHERE pd."assetId" = "Asset"."id"
        AND pd."modality" IN (${Prisma.join(modalities)})
    )`);
  }

  // ─── Prompt 工具 / 模型（票 #15）────────────────────────────────────
  //
  // `toolTags` 是 text[]，用数组重叠算子 `&&` 判断「命中任一即可」。
  // 工具名来自用户输入 → 必须按字面量拼（LIKE 元字符转义同理）。
  if (skip !== "tool" && filters.tool && filters.tool.length > 0) {
    const tools = filters.tool.map((value) => Prisma.sql`${Prisma.raw(sqlLiteral(value))}::text`);
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "PromptDetail" pd
      WHERE pd."assetId" = "Asset"."id"
        AND pd."toolTags" && ARRAY[${Prisma.join(tools)}]::text[]
    )`);
  }

  // 依赖筛选（票 #17）：不是分面维度，所以**任何维度钻取时都保留**。
  if (filters.dependsOn && filters.dependsOn.length > 0) {
    parts.push(buildDependsOnClause(filters.dependsOn));
  }

  if (parts.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`(${Prisma.join(parts, " AND ")})`;
}

/**
 * 整条查询的 WHERE：归档过滤 + 下架过滤 + 标签矩阵 + 关键词命中。
 *
 * 「下架过滤」是票 #11 带来的：用户发布的资产被审核下架（审核中 / 已拒绝）后
 * 不该再出现在搜索结果里 —— 与 listAssets / getAssetBySlug 同一条口径。
 * 没有发布记录的资产（采集来的）不受这条限制影响。
 */
function buildWhereClause(normalized: NormalizedQuery, skip?: FilterDimension): Prisma.Sql {
  return Prisma.sql`"archivedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "UserPublishedAsset" upa
      WHERE upa."assetId" = "Asset"."id" AND upa."status" <> 'PUBLISHED'
    )
    AND ${buildFilterClause(normalized.filters, skip)}
    AND ${buildMatchClause(normalized.q)}`;
}

/**
 * 排序子句。
 *
 * 每个维度都是「主指标降序 + 热度降序」兜底 —— 同分条目的顺序必须稳定，
 * 否则每次采集刷新数据，列表顺序就跟着抖一下。
 *
 * `installs` / `trending` 是 spec 决策 5 的两个热度视图（票 #24）：
 * 累计安装量与近期增速。第三个视图 hot（每小时对比昨日同时段）需要安装量
 * 的历史快照，单独在票 #31 里做。
 */
function buildOrderClause(sort: SearchSort): Prisma.Sql {
  if (sort === "relevance") {
    return Prisma.sql`"score" DESC, "heatScore" DESC, "updatedAt" DESC`;
  }
  if (sort === "recent") {
    return Prisma.sql`"updatedAt" DESC, "heatScore" DESC`;
  }
  if (sort === "name") {
    return Prisma.sql`"displayName" ASC, "heatScore" DESC`;
  }
  if (sort === "installs") {
    return Prisma.sql`"installs" DESC, "heatScore" DESC, "updatedAt" DESC`;
  }
  if (sort === "trending") {
    return Prisma.sql`"trendScore" DESC, "heatScore" DESC, "updatedAt" DESC`;
  }
  return Prisma.sql`"heatScore" DESC, "updatedAt" DESC`;
}

/** 把入参归一化：去空白、去重、夹紧分页、确定默认排序。 */
function normalize(query: SearchQuery): NormalizedQuery {
  const q = (query.q ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const filters = query.filters ?? {};

  const kind: AssetKind[] = [];
  for (const value of filters.kind ?? []) {
    if (isAssetKind(value) && !kind.includes(value)) {
      kind.push(value);
    }
  }

  const license: (string | null)[] = [];
  for (const value of filters.license ?? []) {
    if (value === null) {
      if (!license.includes(null)) {
        license.push(null);
      }
      continue;
    }
    const normalizedLicense = value.trim().toLowerCase();
    if (normalizedLicense.length > 0 && !license.includes(normalizedLicense)) {
      license.push(normalizedLicense);
    }
  }

  const official = typeof filters.official === "boolean" ? filters.official : null;

  // ─── Prompt 模态 / 工具（票 #15）────────────────────────────────────
  //
  // ⚠️ 没选时是 `undefined` 而不是空数组：既有调用方会把 `query.filters`
  //    整个拿去断言相等，多一个空数组键就会让那些断言红掉。
  const modality: PromptModality[] = [];
  for (const value of filters.modality ?? []) {
    if (isPromptModality(value) && !modality.includes(value)) {
      modality.push(value);
    }
  }

  const tool: string[] = [];
  for (const value of filters.tool ?? []) {
    const normalizedTool = value.trim().toLowerCase();
    if (normalizedTool.length > 0 && !tool.includes(normalizedTool)) {
      tool.push(normalizedTool);
    }
  }

  // 依赖筛选（票 #17）：slug 归一化（站内 slug 全小写）+ 去重。
  const dependsOn: string[] = [];
  for (const value of filters.dependsOn ?? []) {
    const normalizedSlug = value.trim().toLowerCase();
    if (normalizedSlug.length > 0 && !dependsOn.includes(normalizedSlug)) {
      dependsOn.push(normalizedSlug);
    }
  }

  return {
    q,
    filters: {
      kind,
      license,
      official,
      ...(modality.length > 0 ? { modality } : {}),
      ...(tool.length > 0 ? { tool } : {}),
      // ⚠️ 没有依赖筛选时**不出现**这个键（不是空数组）：
      //    归一化后的结构是公开契约，多一个空数组会让既有调用方对不上。
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    },
    sort: resolveSort(query.sort, q),
    page: clampInt(query.page, 1, 1_000_000, 1),
    pageSize: clampInt(query.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
  };
}

function isAssetKind(value: string): value is AssetKind {
  return (Object.values(AssetKind) as string[]).includes(value);
}

function isPromptModality(value: string): value is PromptModality {
  return (Object.values(PromptModality) as string[]).includes(value);
}

function resolveSort(sort: SearchSort | undefined, q: string): SearchSort {
  if (sort && SEARCH_SORTS.includes(sort)) {
    return sort;
  }
  // 有查询词时默认按相关度，纯浏览时默认按热度。
  return defaultSortFor(q);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

/**
 * Postgres 检索实现。
 *
 * 全站唯一的具体实现；换实现（→ 向量检索）时只改
 * `src/lib/search-service.ts` 里的 {@link getSearchService}。
 */
export class PostgresSearchService implements SearchService {
  async search(query: SearchQuery): Promise<SearchResult> {
    const normalized = normalize(query);

    const [items, total, kindFacet, licenseFacet, officialFacet, modalityFacet, toolFacet] =
      await Promise.all([
        queryItems(normalized),
        queryTotal(normalized),
        queryFacet(normalized, "kind", Prisma.raw(`"kind"`)),
        queryFacet(normalized, "license", Prisma.raw(`"license"`)),
        queryFacet(normalized, "official", Prisma.raw(`"isOfficial"::text`)),
        queryModalityFacet(normalized),
        queryToolFacet(normalized),
      ]);

    const totalPages = normalized.pageSize > 0 ? Math.ceil(total / normalized.pageSize) : 0;

    return {
      items: items.map(toHit),
      total,
      page: normalized.page,
      pageSize: normalized.pageSize,
      totalPages,
      facets: {
        kind: kindFacet,
        license: licenseFacet,
        official: officialFacet,
        modality: modalityFacet,
        tool: toolFacet,
      },
      query: normalized,
    };
  }
}

/**
 * Prompt 模态分面（票 #15）。
 *
 * JOIN `PromptDetail` —— 只有 PROMPT 类的资产才有模态。
 * 该维度自身的过滤条件不参与（钻取语义），其余条件（含关键词）都参与。
 */
async function queryModalityFacet(normalized: NormalizedQuery): Promise<SearchFacetBucket[]> {
  const where = buildWhereClause(normalized, "modality");
  const rows = await prisma.$queryRaw<FacetRow[]>`
    SELECT pd."modality"::text AS "value", count(*)::int AS "count"
    FROM "Asset"
    JOIN "PromptDetail" pd ON pd."assetId" = "Asset"."id"
    WHERE ${where}
    GROUP BY pd."modality"
  `;
  return rows.map((row) => ({ value: row.value, count: row.count }));
}

/**
 * Prompt 工具 / 模型分面（票 #15）。
 *
 * `toolTags` 是数组，要先展开成行再统计：
 * `CROSS JOIN LATERAL unnest(...)` 让每个标签单独成一行。
 */
async function queryToolFacet(normalized: NormalizedQuery): Promise<SearchFacetBucket[]> {
  const where = buildWhereClause(normalized, "tool");
  const rows = await prisma.$queryRaw<FacetRow[]>`
    SELECT t AS "value", count(*)::int AS "count"
    FROM "Asset"
    JOIN "PromptDetail" pd ON pd."assetId" = "Asset"."id"
    CROSS JOIN LATERAL unnest(pd."toolTags") AS t
    WHERE ${where}
    GROUP BY t
  `;
  return rows.map((row) => ({ value: row.value, count: row.count }));
}

/** 取当前页的结果条目。 */
async function queryItems(normalized: NormalizedQuery): Promise<AssetRow[]> {
  const where = buildWhereClause(normalized);
  const score =
    normalized.sort === "relevance" && normalized.q.length > 0
      ? buildScoreClause(normalized.q)
      : Prisma.raw("0::float8");
  const limit = normalized.pageSize;
  const offset = (normalized.page - 1) * normalized.pageSize;

  return prisma.$queryRaw<AssetRow[]>`
    SELECT ${SELECT_COLUMNS}, ${score} AS "score"
    FROM "Asset"
    WHERE ${where}
    ORDER BY ${buildOrderClause(normalized.sort)}
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/** 取命中总数（不受分页影响）。 */
async function queryTotal(normalized: NormalizedQuery): Promise<number> {
  const where = buildWhereClause(normalized);
  const rows = await prisma.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS "total" FROM "Asset" WHERE ${where}
  `;
  return rows[0]?.total ?? 0;
}

/**
 * 取某个维度的分面。
 *
 * 该维度自身的过滤条件不参与（钻取语义），其余条件（含关键词）都参与。
 */
async function queryFacet(
  normalized: NormalizedQuery,
  dimension: FilterDimension,
  column: Prisma.Sql,
): Promise<SearchFacetBucket[]> {
  const where = buildWhereClause(normalized, dimension);
  const rows = await prisma.$queryRaw<FacetRow[]>`
    SELECT ${column} AS "value", count(*)::int AS "count"
    FROM "Asset"
    WHERE ${where}
    GROUP BY ${column}
  `;
  return rows.map((row) => ({ value: row.value, count: row.count }));
}

/** 数据库行 → 检索结果条目。 */
function toHit(row: AssetRow): SearchHit {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    displayName: row.displayName,
    summaryZh: row.summaryZh,
    whenToUse: row.whenToUse,
    howToUse: row.howToUse,
    license: row.license,
    contentTier: row.contentTier,
    isOfficial: row.isOfficial,
    heatScore: row.heatScore,
    installs: row.installs,
    trendScore: row.trendScore,
    stars: row.stars,
    favoriteCount: row.favoriteCount,
    likeCount: row.likeCount,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    repoUrl: row.repoUrl,
    updatedAt: row.updatedAt,
    score: row.score,
  };
}
