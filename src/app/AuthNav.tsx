"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * 导航栏上的登录态。
 *
 * 为什么要客户端取：服务端组件读 cookie 会把**整个站点**变成动态渲染，
 * 而登录态只是导航栏上的一小块。用 `/api/auth/me` 取，代价是一次小请求。
 *
 * 游客态优先（spec 约束 7）：没登录也只是导航栏上多一个「登录」入口，
 * 浏览 / 搜索 / 收藏 / 点赞全都照常能用。
 */
type MeResponse = {
  authenticated: boolean;
  user: { email: string; displayName: string | null } | null;
};

export function AuthNav() {
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (response.ok) {
          setMe((await response.json()) as MeResponse);
        }
      } catch {
        // 问不到就当游客态。
      }
    })();
  }, []);

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setMe({ authenticated: false, user: null });
    } catch {
      // 登出失败就保持原样，用户可以再点一次。
    }
  };

  return (
    <nav className="site-nav">
      <Link href="/">com-ai</Link>
      <span className="site-nav-spacer" />
      {me?.authenticated ? (
        <>
          {/* 注册墙只出现在「发布自己的资产」这一处（spec 约束 7）。 */}
          <Link href="/publish">发布</Link>
          <span className="badge-muted">{me.user?.displayName ?? me.user?.email}</span>
          <button type="button" className="interaction-button" onClick={() => void logout()}>
            登出
          </button>
        </>
      ) : (
        <Link href="/login">登录</Link>
      )}
    </nav>
  );
}
