-- 近期增速（票 #24）
--
-- skills.sh 榜单给的是「累计安装量 + 近 8 周的周安装量」。
-- 前者已经存在（Asset.installs），后者此前只喂给热度分的趋势修正、**没有落库**，
-- 于是「近期增长最快」这个榜（spec 故事 14）算不出来。
--
-- 这一列存**派生分**：近一半的周安装量 vs 远一半，夹在 [-1, 1]。
--   0 = 没有趋势数据（站点地图来源的条目既没有安装量也没有趋势序列）；
--   1 = 翻倍增长；-1 = 腰斩。
--
-- 为什么存派生分而不是 8 周原始序列：
-- 热度分（heatScore）也是派生分入库 —— 上游每次给的数据都是新的，
-- 每次采集重算一遍即可；公式变了重跑一轮采集也就够了。
ALTER TABLE "Asset" ADD COLUMN "trendScore" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 「近期增长最快」榜按这一列排序 —— 与 heatScore 一样建索引。
CREATE INDEX "Asset_trendScore_idx" ON "Asset"("trendScore");
