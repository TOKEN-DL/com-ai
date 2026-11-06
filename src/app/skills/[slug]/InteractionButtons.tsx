"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  defaultStorage,
  ensureDeviceId,
  setFavoriteSlug,
  STORAGE_UNAVAILABLE_MESSAGE,
} from "@/lib/client/guest-store";

/**
 * 点赞 / 收藏按钮（游客态可用，不需要注册 —— spec 约束 7）。
 *
 * 主体靠**设备指纹**识别：浏览器本地生成一串随机 id，随请求头带上；
 * 服务端只存它的哈希，所以同一台设备刷新页面后状态还在（spec 约束 8）。
 *
 * 限流触发时后端返回 429 与提示文案，这里**原样显示** ——
 * 限流不能是静默丢弃（票 #8 验收标准第 4 条）。
 */
type InteractionButtonsProps = {
  slug: string;
  initialLikeCount: number;
  initialFavoriteCount: number;
};

type InteractionState = {
  liked: boolean;
  favorited: boolean;
  likeCount: number;
  favoriteCount: number;
};

export function InteractionButtons({
  slug,
  initialLikeCount,
  initialFavoriteCount,
}: InteractionButtonsProps) {
  const [state, setState] = useState<InteractionState>({
    liked: false,
    favorited: false,
    likeCount: initialLikeCount,
    favoriteCount: initialFavoriteCount,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deviceIdRef = useRef<string | null>(null);

  useEffect(() => {
    const device = ensureDeviceId(defaultStorage());
    deviceIdRef.current = device.id;

    void (async () => {
      if (!device.persistent) {
        setNotice(STORAGE_UNAVAILABLE_MESSAGE);
      }

      // 刷新页面后把「已点赞 / 已收藏」的状态恢复出来。
      try {
        const response = await fetch(`/api/assets/${encodeURIComponent(slug)}/interaction`, {
          headers: { "x-device-id": device.id },
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const body = await response.json();
        setState({
          liked: Boolean(body.liked),
          favorited: Boolean(body.favorited),
          likeCount: Number(body.likeCount),
          favoriteCount: Number(body.favoriteCount),
        });
      } catch {
        // 网络问题：保留服务端渲染出来的计数，不打扰用户。
      }
    })();
  }, [slug]);

  const send = useCallback(
    async (kind: "like" | "favorite", action: "set" | "clear") => {
      const deviceId = deviceIdRef.current;
      if (!deviceId) {
        setNotice("设备标识还没准备好，请刷新页面后重试。");
        return;
      }

      setBusy(true);
      setNotice(null);

      try {
        const response = await fetch(`/api/assets/${encodeURIComponent(slug)}/${kind}`, {
          method: action === "set" ? "POST" : "DELETE",
          headers: { "x-device-id": deviceId },
        });
        const body = await response.json();

        if (!response.ok) {
          setNotice(
            typeof body?.message === "string" ? body.message : "操作失败，请稍后再试。",
          );
          return;
        }

        setState({
          liked: Boolean(body.liked),
          favorited: Boolean(body.favorited),
          likeCount: Number(body.likeCount),
          favoriteCount: Number(body.favoriteCount),
        });
      } catch {
        setNotice("网络不太顺，请稍后再试。");
      } finally {
        setBusy(false);
      }
    },
    [slug],
  );

  const toggleLike = useCallback(() => {
    void send("like", state.liked ? "clear" : "set");
  }, [send, state.liked]);

  const toggleFavorite = useCallback(() => {
    const next = !state.favorited;

    // 本地清单先记下来（游客态的「我的收藏」从本地读）。
    const result = setFavoriteSlug(defaultStorage(), slug, next);
    if (!result.available) {
      setNotice(STORAGE_UNAVAILABLE_MESSAGE);
      return;
    }

    void send("favorite", next ? "set" : "clear");
  }, [send, slug, state.favorited]);

  return (
    <section className="interactions">
      <h2>互动</h2>
      <div className="interaction-row">
        <button
          type="button"
          className="interaction-button"
          onClick={toggleLike}
          disabled={busy}
          aria-pressed={state.liked}
        >
          {state.liked ? "已点赞" : "点赞"} · {state.likeCount}
        </button>
        <button
          type="button"
          className="interaction-button"
          onClick={toggleFavorite}
          disabled={busy}
          aria-pressed={state.favorited}
        >
          {state.favorited ? "已收藏" : "收藏"} · {state.favoriteCount}
        </button>
      </div>
      {notice ? (
        <p className="bad" role="alert">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
