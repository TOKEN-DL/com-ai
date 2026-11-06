"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { defaultStorage, ensureDeviceId } from "@/lib/client/guest-store";

/**
 * 登录面板。
 *
 * 三件事：
 *   1. **用邮件链接登录**：填邮箱 → 服务端生成一次性链接 → 发信；
 *   2. **校验链接**：URL 上带着 `token` 时自动调 `/api/auth/verify` 换成会话 ——
 *      这一步带上 `x-device-id` 请求头，服务端才能把游客态的收藏 / 点赞合并到账号；
 *   3. **GitHub 登录**（备选）：没配置客户端凭据时按钮置灰并说明原因。
 *
 * 状态反映：已登录时显示邮箱与登出按钮（导航栏上的登录态由 AuthNav 负责）。
 */
type LoginPanelProps = {
  /** 链接里的登录令牌（有它就自动校验）。 */
  token?: string;
  /** 回调带回来的状态（ok / invalid / expired / used / github_error）。 */
  status?: string;
  /** 回调带回来的说明。 */
  message?: string;
  /** 合并到账号的收藏条数。 */
  mergedFavorites?: string;
  /** 合并到账号的点赞条数。 */
  mergedLikes?: string;
  /** 合并时被去重丢弃的收藏条数。 */
  mergedFavoritesDeduplicated?: string;
  /** 合并时被去重丢弃的点赞条数。 */
  mergedLikesDeduplicated?: string;
  /** GitHub OAuth 是否已配置。 */
  githubEnabled: boolean;
  /** 邮件发送器会不会把链接回显出来（开发模式为 true）。 */
  emailExposesLink: boolean;
};

type MeResponse = {
  authenticated: boolean;
  user: { email: string; displayName: string | null } | null;
};

type LinkRequestState =
  | { mode: "idle" }
  | { mode: "sending" }
  | { mode: "sent"; message: string; devLink: string | null }
  | { mode: "failed"; message: string };

const STATUS_MESSAGES: Record<string, string> = {
  invalid: "登录链接无效，请重新申请一个。",
  expired: "登录链接已过期，请重新申请一个。",
  used: "这个登录链接已经用过了，请重新申请一个。",
  github_error: "GitHub 登录失败，请重新发起登录。",
};

export function LoginPanel({
  token,
  status,
  message,
  mergedFavorites,
  mergedLikes,
  mergedFavoritesDeduplicated,
  mergedLikesDeduplicated,
  githubEnabled,
  emailExposesLink,
}: LoginPanelProps) {
  const [email, setEmail] = useState("");
  const [request, setRequest] = useState<LinkRequestState>({ mode: "idle" });
  const [me, setMe] = useState<MeResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [merged, setMerged] = useState<{
    favorites: number;
    likes: number;
    favoritesDeduplicated: number;
    likesDeduplicated: number;
  } | null>(null);

  // 登录态 + 自动校验链接。
  useEffect(() => {
    const device = ensureDeviceId(defaultStorage());

    void (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.ok) {
          setMe((await response.json()) as MeResponse);
        }
      } catch {
        // 问不到就当游客态，不打扰用户。
      }

      if (!token) {
        return;
      }

      try {
        const response = await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json", "x-device-id": device.id },
          body: JSON.stringify({ token }),
        });
        const body = (await response.json()) as {
          ok?: boolean;
          message?: string;
          merged?: {
            favorites?: number;
            likes?: number;
            favoritesDeduplicated?: number;
            likesDeduplicated?: number;
          };
        };

        if (response.ok) {
          setMerged({
            favorites: Number(body.merged?.favorites ?? 0),
            likes: Number(body.merged?.likes ?? 0),
            favoritesDeduplicated: Number(body.merged?.favoritesDeduplicated ?? 0),
            likesDeduplicated: Number(body.merged?.likesDeduplicated ?? 0),
          });
          setNotice("登录成功。");

          const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
          if (meResponse.ok) {
            setMe((await meResponse.json()) as MeResponse);
          }

          // 别把令牌留在地址栏（会留在浏览器历史里）。
          window.history.replaceState({}, "", "/login");
          return;
        }

        setNotice(body.message ?? STATUS_MESSAGES.invalid);
      } catch {
        setNotice("网络不太顺，请稍后再试。");
      }
    })();
  }, [token]);

  const requestLink = async (event: React.FormEvent) => {
    event.preventDefault();
    setRequest({ mode: "sending" });
    setNotice(null);

    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json()) as { message?: string; devLink?: string };

      if (!response.ok) {
        setRequest({ mode: "failed", message: body.message ?? "发送失败，请稍后再试。" });
        return;
      }

      setRequest({
        mode: "sent",
        message: body.message ?? "登录链接已生成，请到邮箱查收。",
        devLink: typeof body.devLink === "string" ? body.devLink : null,
      });
    } catch {
      setRequest({ mode: "failed", message: "网络不太顺，请稍后再试。" });
    }
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setMe({ authenticated: false, user: null });
    } catch {
      setNotice("登出失败，请稍后再试。");
    }
  };

  // 回调带回来的状态（走的是 GET 路径，例如直接点链接进来看见的是过期）。
  const statusNotice = status && status !== "ok" ? (message ?? STATUS_MESSAGES[status] ?? null) : null;
  const mergedFromUrl =
    mergedFavorites || mergedLikes
      ? {
          favorites: Number(mergedFavorites ?? 0),
          likes: Number(mergedLikes ?? 0),
          favoritesDeduplicated: Number(mergedFavoritesDeduplicated ?? 0),
          likesDeduplicated: Number(mergedLikesDeduplicated ?? 0),
        }
      : null;
  const mergedTotal = merged ?? mergedFromUrl;
  const deduplicatedTotal = mergedTotal
    ? mergedTotal.favoritesDeduplicated + mergedTotal.likesDeduplicated
    : 0;

  return (
    <section className="auth-panel">
      {me?.authenticated ? (
        <div className="auth-panel-block">
          <p className="ok">
            已登录为 {me.user?.displayName ?? me.user?.email}
          </p>
          <button type="button" className="interaction-button" onClick={() => void logout()}>
            登出
          </button>
        </div>
      ) : null}

      {status === "ok" ? <p className="ok">登录成功。</p> : null}
      {statusNotice ? (
        <p className="bad" role="alert">
          {statusNotice}
        </p>
      ) : null}
      {notice ? <p className="ok">{notice}</p> : null}
      {mergedTotal && mergedTotal.favorites + mergedTotal.likes > 0 ? (
        <p className="badge-muted">
          已合并 {mergedTotal.favorites} 条收藏
          {mergedTotal.likes > 0 ? `、${mergedTotal.likes} 条点赞` : ""}到你的账号。
          {deduplicatedTotal > 0 ? `（另有 ${deduplicatedTotal} 条本来就有，已去重）` : ""}
        </p>
      ) : null}

      <div className="auth-panel-block">
        <h2>用邮箱登录</h2>
        <p className="badge-muted">
          不用记密码：我们发一个一次性链接给你，点一下就登录（链接过期后需要重新申请）。
        </p>

        <form className="auth-form" onSubmit={requestLink}>
          <label htmlFor="auth-email">邮箱</label>
          <input
            id="auth-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
          <button
            type="submit"
            className="interaction-button"
            disabled={request.mode === "sending"}
          >
            {request.mode === "sending" ? "发送中…" : "发送登录链接"}
          </button>
        </form>

        {request.mode === "sent" ? (
          <div className="auth-panel-note">
            <p className="ok">{request.message}</p>
            {request.devLink ? (
              <>
                <p className="badge-muted">
                  当前环境未配置邮件服务，链接已输出到服务端日志；下面这份是同一个链接，
                  点开即可完成登录。
                </p>
                <p>
                  <Link href={request.devLink}>打开登录链接</Link>
                </p>
              </>
            ) : null}
          </div>
        ) : null}

        {request.mode === "failed" ? (
          <p className="bad" role="alert">
            {request.message}
          </p>
        ) : null}

        {emailExposesLink ? (
          <p className="badge-muted">当前环境未配置邮件服务，登录链接会输出到服务端日志。</p>
        ) : null}
      </div>

      <div className="auth-panel-block">
        <h2>用 GitHub 登录</h2>
        {githubEnabled ? (
          <a className="interaction-button" href="/api/auth/github">
            用 GitHub 登录
          </a>
        ) : (
          <>
            <button type="button" className="interaction-button" disabled>
              用 GitHub 登录
            </button>
            <p className="badge-muted">
              当前环境未配置 GitHub OAuth 客户端，GitHub 登录暂不可用 —— 用邮箱登录即可。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
