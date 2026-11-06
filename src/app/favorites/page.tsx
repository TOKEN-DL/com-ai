import { FavoritesPanel } from "./FavoritesPanel";

/**
 * 「我的收藏」页。
 *
 * 游客态从**本地**读（localStorage 存 slug 清单，服务端不替游客保管清单）；
 * 登录态从服务端读（Favorite 表）。
 * 两种路径都由面板在浏览器里判定，见 ./FavoritesPanel.tsx。
 */
export default function FavoritesPage() {
  return (
    <main>
      <h1>我的收藏</h1>
      <p className="lede">收藏的 Skill 都在这里。</p>
      <FavoritesPanel />
    </main>
  );
}
