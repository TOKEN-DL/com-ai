"use client";

import { useEffect, useState } from "react";

import { defaultStorage, ensureDeviceId } from "@/lib/client/guest-store";

/**
 * 设备标识请求头。
 *
 * ⚠️ 服务端的常量在 `@/lib/interaction-actor`，但那个模块依赖 prisma 与会话模块，
 *    **不能进客户端包**（浏览器里没有 node:crypto，也没有 Prisma）。
 *    所以这里写死一份，并在服务端保持一致（#8 定下的约定）。
 */
const DEVICE_ID_HEADER = "x-device-id";

/** 版本条目（只取提示要用的几个字段）。 */
export type NoticeVersion = {
  version: string;
  label: string;
  originLabel: string;
  createdAt: string;
};

/** 更新提示的状态。 */
export type UpdateNoticeState = {
  /// 收藏之后有没有新版本。
  hasUpdate: boolean;
  /// 当前主体有没有收藏这个资产。
  favorited: boolean;
  /// 最新版本。
  latestVersion: NoticeVersion | null;
  /// 收藏时看到的版本。
  seenVersion: NoticeVersion | null;
};

type VersionUpdateNoticeProps = {
  slug: string;
  /**
   * 服务端算好的初始状态。
   *
   * 登录用户在服务端就能算出来（会话 cookie 随请求带上），首屏直接显示；
   * 游客态服务端认不出主体（设备指纹在 localStorage 里），由下面的请求补上。
   */
  initial: UpdateNoticeState | null;
};

/**
 * 「收藏的资产出现新版本」的提示（票 #16）。
 *
 * ## 为什么是客户端组件
 *
 * 游客态的收藏靠**设备指纹**识别，而设备指纹只存在于浏览器的 localStorage 里 ——
 * 服务端渲染时拿不到，提示就没法在首屏出现。
 * 所以：服务端能算（登录用户）就先算，客户端再补一次请求（游客）。
 *
 * ## 语义
 *
 * 「你收藏之后，上游（或发布者）又出了新版本」。点击提示跳到版本历史，
 * 那里有这条新版本的**变更摘要**（一键查看差异）。
 */
export function VersionUpdateNotice({ slug, initial }: VersionUpdateNoticeProps) {
  const [state, setState] = useState<UpdateNoticeState>(
    initial ?? { hasUpdate: false, favorited: false, latestVersion: null, seenVersion: null },
  );

  useEffect(() => {
    let cancelled = false;

    const device = ensureDeviceId(defaultStorage());

    void (async () => {
      try {
        const response = await fetch(`/api/assets/${encodeURIComponent(slug)}/versions`, {
          headers: { [DEVICE_ID_HEADER]: device.id },
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const body = await response.json();
        if (cancelled || !body?.update) {
          return;
        }
        setState({
          hasUpdate: Boolean(body.update.hasUpdate),
          favorited: Boolean(body.update.favorited),
          latestVersion: body.update.latestVersion ?? null,
          seenVersion: body.update.seenVersion ?? null,
        });
      } catch {
        // 网络问题：保留服务端渲染出来的状态，不打扰用户。
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!state.hasUpdate || !state.latestVersion) {
    return null;
  }

  return (
    <p className="version-update-notice" role="status" data-testid="version-update-notice">
      这个资产有新版本：{state.latestVersion.label}（{state.latestVersion.originLabel}）。
      <a href="#version-history">查看版本差异</a>
    </p>
  );
}
