/**
 * 列表项的统一形状。
 *
 * 列表接口（`/api/skills`、`/api/assets`、`/api/favorites`）共用同一个映射，
 * 所以「页面上显示的计数」与「接口返回的计数」永远是同一份数据。
 */
import type { Asset } from "@prisma/client";

export type AssetListItem = {
  slug: string;
  displayName: string;
  summaryZh: string | null;
  /// 「何时用」（票 #7）。列表页要把它与「怎么用」分开显示。
  whenToUse: string | null;
  /// 「怎么用」（票 #7）。
  howToUse: string | null;
  license: string | null;
  contentTier: string;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  heatScore: number;
  installs: number;
  stars: number;
  /** 收藏数（跨 kind 统一计数）。 */
  favoriteCount: number;
  /** 点赞数（跨 kind 统一计数）。 */
  likeCount: number;
};

/** Asset → 列表项。互动计数由数据库触发器维护，这里只读。 */
export function toAssetListItem(asset: Asset): AssetListItem {
  return {
    slug: asset.slug,
    displayName: asset.displayName,
    summaryZh: asset.summaryZh,
    whenToUse: asset.whenToUse,
    howToUse: asset.howToUse,
    license: asset.license,
    contentTier: asset.contentTier,
    repoOwner: asset.repoOwner,
    repoName: asset.repoName,
    repoUrl: asset.repoUrl,
    heatScore: asset.heatScore,
    installs: asset.installs,
    stars: asset.stars,
    favoriteCount: asset.favoriteCount,
    likeCount: asset.likeCount,
  };
}
