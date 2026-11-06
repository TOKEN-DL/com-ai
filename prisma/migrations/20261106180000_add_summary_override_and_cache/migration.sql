-- 中文简介：人工覆盖字段 + 按内容 hash 的生成缓存（票 #7）。
--
-- 三件事：
--   1. Asset 上加「何时用 / 怎么用」两列 —— 搜索结果项也要展示它们，
--      而检索层只查主表，所以不能只放在 SkillDetail 里。
--   2. Asset 上加「人工覆盖时间 / 覆盖人」—— 覆盖过的简介，批量重跑必须跳过。
--   3. 新增 AssetSummaryCache —— 键 = 内容 hash + 生成器版本，
--      同一份内容重复采集时不再重复调模型；模型/提示词一改，键就变，可批量重跑。
--
-- ⚠️ 触发器与函数对 Prisma 不可见（Prisma 不管理函数 / 触发器）。
--    这里只**替换函数体**，不重建触发器 —— 触发器按 OID 绑定函数，
--    CREATE OR REPLACE 之后原触发器继续生效。

-- ─── 1. Asset 主表新增列 ───────────────────────────────────────────
ALTER TABLE "Asset"
  ADD COLUMN "whenToUse" TEXT,
  ADD COLUMN "howToUse" TEXT,
  ADD COLUMN "summaryOverriddenAt" TIMESTAMP(3),
  ADD COLUMN "summaryOverriddenBy" TEXT;

-- ─── 2. 简介缓存表 ────────────────────────────────────────────────
CREATE TABLE "AssetSummaryCache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "summaryZh" TEXT NOT NULL,
    "whenToUse" TEXT,
    "howToUse" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "SummarySource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetSummaryCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssetSummaryCache_cacheKey_key" ON "AssetSummaryCache"("cacheKey");
CREATE INDEX "AssetSummaryCache_contentHash_idx" ON "AssetSummaryCache"("contentHash");
CREATE INDEX "AssetSummaryCache_generatorVersion_idx" ON "AssetSummaryCache"("generatorVersion");

-- ─── 3. 许可证分层的触发器：把「何时用 / 怎么用」一并纳入 ──────────
--
-- 与 20261106012632_add_full_data_model 里那条触发器**同一份规则**，
-- 只是多了两列的清理：
--   - METADATA_ONLY 档位不落「基于原文的内容」；
--   - 「何时用 / 怎么用」按 spec 决策 7 也是由原文生成的 → 一并清空；
--   - 例外：**人工撰写（HUMAN）保留** —— 那是人写的，不是原文摘抄。
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
    -- 「何时用 / 怎么用」同样由原文生成 → 清空；
    -- 人工撰写（HUMAN）例外：那是人写的，不是原文摘抄。
    IF NEW."summarySource" IS DISTINCT FROM 'HUMAN'::"SummarySource" THEN
      NEW."whenToUse" := NULL;
      NEW."howToUse" := NULL;
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- ─── 4. SkillDetail 的同名两列：与主表对齐（同一条 HUMAN 例外）──────
--
-- SkillDetail.whenToUse / howToUse 是主表那两列的**镜像**（主表是权威存储，
-- 因为搜索结果项要读它）。镜像与权威值必须永远一致 → 触发器用同一条规则。
CREATE OR REPLACE FUNCTION "comai_guard_skill_detail"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tier "ContentTier";
  v_source "SummarySource";
BEGIN
  SELECT "contentTier", "summarySource"
    INTO v_tier, v_source
    FROM "Asset" WHERE "id" = NEW."assetId";

  IF v_tier = 'METADATA_ONLY'::"ContentTier" THEN
    -- 人工撰写（HUMAN）保留，其余清空 —— 与 Asset 主表触发器同一条规则。
    IF v_source IS DISTINCT FROM 'HUMAN'::"SummarySource" THEN
      NEW."whenToUse" := NULL;
      NEW."howToUse" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
