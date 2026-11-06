-- #9：邮箱魔法链接与 GitHub OAuth 的一次性登录令牌
--
-- ─── 为什么单独一张表 ──────────────────────────────────────────────────
--
-- 登录令牌和会话令牌是两回事，不能共用一张表：
--
--   - **登录令牌**（这张表）：一次性、短期、用来「证明你就是这个邮箱的主人」。
--     魔法链接里的 token、GitHub OAuth 的 state 都落在这里。
--   - **会话令牌**（Session 表）：长期、可撤销、用来「证明你现在是这个账号」。
--
-- 两者混在一起的话，「链接用过没有」和「会话还有效吗」就没法分开判定，
-- 一次性链接也就名存实亡了。
--
-- ─── 三条硬规矩 ────────────────────────────────────────────────────────
--
--   1. **只存哈希**：明文令牌只在生成那一次活在内存与链接里，落库的是 SHA-256。
--      数据库被拖库也拿不到可直接使用的令牌。
--   2. **一次性**：`usedAt` 一旦写上，同一个令牌再来一律拒绝。
--   3. **有有效期**：`expiresAt` 过了就拒绝（令牌本身还在，但换不到会话）。
--
-- 这张表同时是「请求登录链接」的限流账本：窗口内发了多少条，
-- 按 email / ipHash 数这张表自己就行，不必再开一张限流表。

-- CreateEnum
CREATE TYPE "LoginTokenPurpose" AS ENUM ('EMAIL_MAGIC', 'GITHUB_OAUTH');

-- CreateTable
CREATE TABLE "LoginToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "LoginTokenPurpose" NOT NULL,
    "email" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoginToken_tokenHash_key" ON "LoginToken"("tokenHash");

-- CreateIndex
CREATE INDEX "LoginToken_purpose_email_idx" ON "LoginToken"("purpose", "email");

-- CreateIndex
CREATE INDEX "LoginToken_ipHash_createdAt_idx" ON "LoginToken"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginToken_expiresAt_idx" ON "LoginToken"("expiresAt");

-- ⚠️ 不要动 "Asset_displayName_trgm_idx" / "Asset_slug_trgm_idx"：
--    那是 pg_trgm 的 GIN 索引，Prisma 的 datamodel 表达不了，
--    `prisma migrate diff` 会把它们当成漂移要删 —— 删了全文模糊检索就废了。
