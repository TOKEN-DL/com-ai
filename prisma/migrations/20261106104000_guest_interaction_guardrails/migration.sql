-- #8：游客态点赞与收藏
--
-- ─── 一、IP 只存哈希 ────────────────────────────────────────────────────
--
-- 游客态限流要用到客户端 IP，但明文 IP 等于把用户的位置写进数据库。
-- 所以库里只放**哈希后的** IP（HMAC-SHA256，见 src/lib/guest-identity.ts），
-- 明文只在内存里活一瞬间，用来算哈希。
--
-- ipHash 为 NULL = 登录态的行（账号已验证，不需要 IP 限流）。

-- AlterTable
ALTER TABLE "Favorite" ADD COLUMN "ipHash" TEXT;

-- AlterTable
ALTER TABLE "Like" ADD COLUMN "ipHash" TEXT;

-- 限流查询按「资产 + IP 哈希 + 时间窗」过滤，给它配一条索引。
-- CreateIndex
CREATE INDEX "Favorite_assetId_ipHash_createdAt_idx" ON "Favorite"("assetId", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "Like_assetId_ipHash_createdAt_idx" ON "Like"("assetId", "ipHash", "createdAt");


-- ─── 二、收藏数 / 点赞数改由触发器维护 ──────────────────────────────────
--
-- 为什么计数下沉到数据库：
--   计数必须恒等于「该资产下的互动行数」。放在应用层维护有两个洞：
--     1. 绕过服务层直接 prisma.favorite.create → 计数漂移；
--     2. 合并游客互动到账号时要手工修计数，很容易算错。
--   交给触发器之后，任何写路径都自动对上：
--     - 新增互动行 → 计数 +1；
--     - 删除互动行 → 计数 -1（下限 0）；
--     - 合并时的「更新归属」不新增不删除行 → 计数不变，天然不翻倍。
--
-- ⚠️ 触发器与函数对 Prisma 不可见（Prisma 不管理函数 / 触发器）。
--    `prisma migrate dev` 若把它们当成漂移要删，用 --create-only 后把本段原样贴回。

-- 迁移前先把存量数据对齐一次（计数与行数对不上时以行数为准）。
UPDATE "Asset" a
SET "favoriteCount" = (SELECT count(*) FROM "Favorite" f WHERE f."assetId" = a."id");

UPDATE "Asset" a
SET "likeCount" = (SELECT count(*) FROM "Like" l WHERE l."assetId" = a."id");

-- ─── 收藏数 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "comai_sync_favorite_count"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE "Asset"
    SET "favoriteCount" = "favoriteCount" + 1, "updatedAt" = NOW()
    WHERE "id" = NEW."assetId";
    RETURN NEW;
  END IF;

  UPDATE "Asset"
  SET "favoriteCount" = GREATEST("favoriteCount" - 1, 0), "updatedAt" = NOW()
  WHERE "id" = OLD."assetId";
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "Favorite_asset_count_sync" ON "Favorite";
CREATE TRIGGER "Favorite_asset_count_sync"
  AFTER INSERT OR DELETE ON "Favorite"
  FOR EACH ROW EXECUTE FUNCTION "comai_sync_favorite_count"();

-- ─── 点赞数 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "comai_sync_like_count"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE "Asset"
    SET "likeCount" = "likeCount" + 1, "updatedAt" = NOW()
    WHERE "id" = NEW."assetId";
    RETURN NEW;
  END IF;

  UPDATE "Asset"
  SET "likeCount" = GREATEST("likeCount" - 1, 0), "updatedAt" = NOW()
  WHERE "id" = OLD."assetId";
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "Like_asset_count_sync" ON "Like";
CREATE TRIGGER "Like_asset_count_sync"
  AFTER INSERT OR DELETE ON "Like"
  FOR EACH ROW EXECUTE FUNCTION "comai_sync_like_count"();
