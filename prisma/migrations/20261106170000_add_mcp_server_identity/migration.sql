-- MCP 条目的上游身份信息（票 #13）。
--
-- 为什么需要这三个字段（都是**实测发现的缺口**，不是锦上添花）：
--
--  1. "serverName" —— registry 里的 server 名是 reverse-DNS（`io.github.owner/server`），
--     它是 server 在 registry 里的**规范身份**。但 `Asset.displayName` 装的是
--     registry 的 `title`（实测 88% 的条目有 title），两者不是一回事，
--     规范名会丢。详情页要能同时展示「展示名」与「registry 里的规范名」。
--
--  2. "serverDescription" —— registry 给的原始描述。详情页要展示它
--     （与 Skill 详情页展示 frontmatter.description 同构）。
--     ⚠️ 它**不进** `Asset.summaryZh`：MCP 条目一律 METADATA_ONLY
--     （registry 不声明许可证），可检索字段里不放上游原文。
--     放在扩展表里与 SkillDetail.frontmatter 的处境一致：
--     触发器只清 contentBody / LLM 简介 / snapshot / promptBody / whenToUse / howToUse，
--     不碰扩展表的其它字段。
--
--  3. "repoPushedAt" —— 「仓库 star 与最近更新日期」里的「最近更新日期」。
--     star 数来自 GitHub Search API（票 #13 明确要求自算），
--     同一个响应里就有 `pushed_at`，顺手一起存，不额外发请求。
--
-- 三列都可空：老数据 / 没声明的条目就是 NULL，不回填假值。

-- AlterTable
ALTER TABLE "McpDetail" ADD COLUMN     "serverName" TEXT,
ADD COLUMN     "serverDescription" TEXT,
ADD COLUMN     "repoPushedAt" TIMESTAMP(3);
