"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { loadGuestFavorites, type FavoriteItem } from "@/lib/client/guest-favorites";
import { defaultStorage } from "@/lib/client/guest-store";

/**
 * 「我的收藏」面板。
 *
 * 先问服务端「你是不是登录的」：
 *   - 登录了 → 从服务端读（Favorite 表，跨设备同步）；
 *   - 没登录 → 从**本地**读（localStorage 里的 slug 清单）。
 *
 * 存储不可用（隐私模式等）时明确提示「当前环境无法保存收藏」，
 * 而不是白屏或者假装没收藏过。
 */
type PanelState =
  | { mode: "loading" }
  | { mode: "account"; items: FavoriteItem[] }
  | { mode: "guest"; items: FavoriteItem[] }
  | { mode: "empty" }
  | { mode: "unavailable"; message: string };

export function FavoritesPanel() {
  const [state, setState] = useState<PanelState>({ mode: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/favorites", { cache: "no-store" });
        if (response.ok) {
          const body = await response.json();
          setState({ mode: "account", items: body.items ?? [] });
          return;
        }
      } catch {
        // 服务端问不到就按游客态处理：本地清单照样能看。
      }

      const guest = await loadGuestFavorites({ storage: defaultStorage() });
      if (guest.status === "ok") {
        setState({ mode: "guest", items: guest.items });
      } else if (guest.status === "unavailable") {
        setState({ mode: "unavailable", message: guest.message });
      } else {
        setState({ mode: "empty" });
      }
    })();
  }, []);

  if (state.mode === "loading") {
    return <p className="badge-muted">读取中…</p>;
  }

  if (state.mode === "unavailable") {
    return (
      <p className="bad" role="alert">
        {state.message}
      </p>
    );
  }

  const items = state.mode === "account" || state.mode === "guest" ? state.items : [];

  if (items.length === 0) {
    return (
      <p className="badge-muted">
        还没有收藏。去 <Link href="/skills">Skill 列表</Link> 逛逛，遇到有用的点一下收藏。
      </p>
    );
  }

  return (
    <>
      <p className="badge-muted">
        {state.mode === "account" ? "来自你的账号" : "保存在这台设备上（登录后可跨设备同步）"}
      </p>
      <ul className="asset-list">
        {items.map((item) => (
          <li key={item.slug}>
            <Link href={`/skills/${item.slug}`}>{item.displayName}</Link>
            {/* 订阅式提示（票 #16）：收藏之后上游出了新版本，列表里直接标出来。 */}
            {item.hasUpdate ? (
              <span className="update-badge">
                有新版本{item.latestVersion ? ` · ${item.latestVersion.label}` : ""}
              </span>
            ) : null}
            <span className="asset-meta">
              {item.repoOwner && item.repoName ? `${item.repoOwner}/${item.repoName}` : "—"}
              {item.license ? ` · ${item.license}` : ""}
              {` · 收藏 ${item.favoriteCount}`}
              {` · 点赞 ${item.likeCount}`}
            </span>
            {item.summaryZh ? <p className="asset-summary">{item.summaryZh}</p> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
