/**
 * 游客态的「我的收藏」取数：本地清单 → 批量查资产。
 *
 * 游客态的收藏清单存在浏览器里（localStorage），服务端不替游客保管清单。
 * 所以这一页的流程是：读本地 slug 清单 → 批量取资产详情 → 渲染。
 *
 * 存储不可用（隐私模式等）时优雅降级：明确提示「当前环境无法保存收藏」，
 * 而不是白屏或假装「你还没有收藏」。
 */
import { readFavoriteSlugs, STORAGE_UNAVAILABLE_MESSAGE, type StorageLike } from "@/lib/client/guest-store";

/** 收藏清单里用到的资产字段。 */
export type FavoriteItem = {
  slug: string;
  displayName: string;
  summaryZh: string | null;
  repoOwner: string | null;
  repoName: string | null;
  license: string | null;
  favoriteCount: number;
  likeCount: number;
};

/** 游客态收藏页的取数结果。 */
export type GuestFavoritesResult =
  | { status: "ok"; items: FavoriteItem[] }
  | { status: "empty" }
  | { status: "unavailable"; message: string };

/**
 * 读本地收藏清单并批量取资产。
 *
 * @param deps.storage  localStorage（不可用时传 null）。
 * @param deps.fetcher  取数用的 fetch（测试里可以塞个假的进来）。
 */
export async function loadGuestFavorites(deps: {
  storage: StorageLike | null;
  fetcher?: (input: string) => Promise<Response>;
}): Promise<GuestFavoritesResult> {
  const fetcher = deps.fetcher ?? ((input: string) => fetch(input));

  const local = readFavoriteSlugs(deps.storage);
  if (!local.available) {
    return { status: "unavailable", message: STORAGE_UNAVAILABLE_MESSAGE };
  }
  if (local.slugs.length === 0) {
    return { status: "empty" };
  }

  const query = local.slugs.map(encodeURIComponent).join(",");
  const response = await fetcher(`/api/assets?slugs=${query}`);
  if (!response.ok) {
    return { status: "empty" };
  }

  const body = (await response.json()) as { items?: FavoriteItem[] };
  return { status: "ok", items: body.items ?? [] };
}
