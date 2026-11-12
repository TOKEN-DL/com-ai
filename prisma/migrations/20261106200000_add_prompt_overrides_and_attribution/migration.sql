-- Prompt 库：许可证 override 表 + 署名 + 工具/模型维度（票 #15）。
--
-- 三件事：
--   1. PromptDetail 加两列：`toolTags`（工具/模型维度）与 `attribution`（CC BY 4.0 的署名要求）；
--   2. 新增 LicenseOverride 表 —— **仓库级 + 文件级**两级的许可证覆盖；
--   3. 种子数据：把实测确认过的 override 写进去。
--
-- ## 为什么需要 LicenseOverride
--
-- GitHub 的 `license.spdx_id` 来自仓库根目录 LICENSE 的**机器识别**，
-- 认不出下面两种情况，一律返回 NOASSERTION：
--
--   1. **一仓两许可**：`f/prompts.chat` 的 LICENSE 是一段双许可说明 ——
--      prompt 内容（prompts.csv / PROMPTS.md）是 CC0 1.0，源码是 MIT。
--      只给仓库一个 SPDX 的话，两边必然判错其中一边。
--   2. **Markdown 结构的许可声明**：`YouMind-OpenLab/awesome-seedance-2-prompts`
--      的 LICENSE 就是标准 CC BY 4.0 全文，GitHub 仍未识别。
--
-- 照默认路径实现，这两个源（2,897 + 106 条）会全部掉进 METADATA_ONLY，
-- 整个票就没有正文了 —— 所以这张表不是「锦上添花」，是本票的地基。
--
-- ## 这张表怎么生效（**不要改触发器**）
--
-- 触发器 `comai_apply_content_tier` 只认 `Asset.license` 这一列。
-- 所以采集器的做法是：**按 override 表决定该资产写什么 `license` 值**，
-- 由触发器据此推导 `contentTier`，再由 `contentTier` 决定 `promptBody` 能不能存。
-- 触发器侧一行都不用动。
--
-- ⚠️ 触发器与函数对 Prisma 不可见（Prisma 不管理函数 / 触发器）。
--    `prisma migrate dev` 若把它们当成漂移要删，用 --create-only 后把原样贴回。

-- ─── 1. PromptDetail 新增两列 ────────────────────────────────────────
--
-- `toolTags`：工具 / 模型维度（Flux / Seedance / Suno …）。
--   用 text[] 而不是 JSON：Postgres 的数组支持 `&&`（重叠）算子，
--   「按工具筛选」能直接走索引；JSON 得先展开再比较。
--   空数组 = 通用提示词（不针对任何特定工具 / 模型）。
--
-- `attribution`：许可证要求的署名（作者 + 许可证标识 + 原仓库链接）。
--   CC BY 4.0 允许再分发但**必须署名**。
--   ⚠️ 它与 `contributor`（这条提示词是谁贡献的）是两回事，不能互相替代：
--   前者来自许可证，后者来自上游仓库。
ALTER TABLE "PromptDetail"
  ADD COLUMN "toolTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "attribution" TEXT;

CREATE INDEX "PromptDetail_modality_idx" ON "PromptDetail"("modality");

-- ─── 2. LicenseOverride 表 ────────────────────────────────────────────
--
-- 粒度：**仓库级 + 文件级**。
--   - `appliesTo` 为空数组 = 仓库级（整个仓库都是这个许可）；
--   - `appliesTo` 非空 = 文件级（只覆盖列出的路径，支持 `**` / `*` 通配）。
-- 同仓不同文件不同许可 → 两条记录，靠 `appliesTo` 区分；
-- 匹配时**文件级优先于仓库级**（更具体的那条胜出）。
--
-- 主键是**确定性派生**的（仓库 + SPDX + 适用路径），不是自增：
-- 这样下面的种子数据可以幂等重放（ON CONFLICT DO NOTHING），
-- 也不会出现「应用层算出来的 id 与库里对不上」的漂移。
-- 派生规则见 src/lib/license-override.ts 的 licenseOverrideId()。
CREATE TABLE "LicenseOverride" (
    "id" TEXT NOT NULL,
    "repoSlug" TEXT NOT NULL,
    "spdxId" TEXT NOT NULL,
    "appliesTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence" TEXT,
    "attribution" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LicenseOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LicenseOverride_repoSlug_idx" ON "LicenseOverride"("repoSlug");

-- ─── 3. 种子数据（实测核对过 LICENSE 原文）────────────────────────────
--
-- ⚠️ `spdxId` 为空串 = **明确「不允许再分发」**（→ METADATA_ONLY），
--    与「未声明许可证」不是一回事：前者是作者的明示，后者是信息缺失。
INSERT INTO "LicenseOverride" ("id", "repoSlug", "spdxId", "appliesTo", "evidence", "attribution", "note", "updatedAt") VALUES
  -- ① f/prompts.chat：一仓两许可。prompt 内容 CC0，源码 MIT。
  ('f/prompts.chat::cc0-1.0::PROMPTS.md,prompts.csv',
   'f/prompts.chat',
   'cc0-1.0',
   ARRAY['prompts.csv', 'PROMPTS.md'],
   'LICENSE 第 6-8 行：Prompt content and data (prompts.csv, PROMPTS.md, and all user-submitted prompt text) is dedicated to the public domain under CC0 1.0 Universal',
   NULL,
   '一仓两许可：prompt 内容是 CC0，源码是 MIT（LICENSE-MIT）。只收 prompt 正文，不碰源码。',
   CURRENT_TIMESTAMP),
  ('f/prompts.chat::mit::',
   'f/prompts.chat',
   'mit',
   ARRAY[]::TEXT[],
   'LICENSE：If you are unsure which license applies to a particular file, the MIT License applies by default.',
   NULL,
   '仓库级兜底：文件级规则没命中时按 MIT 算（源码部分）。',
   CURRENT_TIMESTAMP),

  -- ② YouMind-OpenLab/awesome-seedance-2-prompts：CC BY 4.0 全文，GitHub 报 NOASSERTION。
  --    署名类许可 → FULL 档，但**必须署名**。
  ('YouMind-OpenLab/awesome-seedance-2-prompts::cc-by-4.0::README*.md',
   'YouMind-OpenLab/awesome-seedance-2-prompts',
   'cc-by-4.0',
   ARRAY['README*.md'],
   'LICENSE 首行：Creative Commons Attribution 4.0 International License (CC BY 4.0) / Copyright (c) 2025 YouMind OpenLab',
   'YouMind OpenLab / awesome-seedance-2-prompts — CC BY 4.0 — https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts',
   '署名类许可：站内保留原仓库链接与许可证标识，并展示上面这段署名。',
   CURRENT_TIMESTAMP),

  -- ③ Anil-matcha/awesome-minimax-music-3-prompts：LICENSE.md 双轨声明（prompt 文本 CC BY 4.0，代码 MIT）。
  ('Anil-matcha/awesome-minimax-music-3-prompts::cc-by-4.0::README.md,docs/**,prompts/catalog.json',
   'Anil-matcha/awesome-minimax-music-3-prompts',
   'cc-by-4.0',
   ARRAY['prompts/catalog.json', 'README.md', 'docs/**'],
   'LICENSE.md 第 3-5 行：original documentation and prompt text in this repository are licensed under the Creative Commons Attribution 4.0 International License',
   'Anil-matcha / awesome-minimax-music-3-prompts — CC BY 4.0 — https://github.com/Anil-matcha/awesome-minimax-music-3-prompts',
   '只收 prompt 正文（catalog.json），代码是 MIT、不混用。',
   CURRENT_TIMESTAMP),

  -- ④ NuNaught/suno-songwriting-skill：标准 Apache-2.0 全文，GitHub 报 NOASSERTION。
  --    仓库级（appliesTo 为空）—— 与上面几条文件级的形成对照。
  ('NuNaught/suno-songwriting-skill::apache-2.0::',
   'NuNaught/suno-songwriting-skill',
   'apache-2.0',
   ARRAY[]::TEXT[],
   'LICENSE 首行：Apache License Version 2.0, January 2004（全文 11,389 字节）',
   NULL,
   '仓库级 override：整个仓库都是 Apache-2.0。',
   CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
