/**
 * 游客态的本地存储：设备指纹与「我的收藏」清单。
 *
 * 两条原则：
 *   1. **本地优先**。游客态的收藏清单存在浏览器里（localStorage），
 *      服务端不替游客保管清单 —— 想看收藏，打开「我的收藏」页就行。
 *   2. **降级要看得见**。隐私模式 / 存储被禁用时 localStorage 会抛异常，
 *      这时不能崩，也不能假装存上了：明确告诉用户「当前环境无法保存收藏」。
 *
 * 设备指纹是**浏览器本地生成的随机 id**，不是浏览器特征 ——
 * 不用 UA、屏幕分辨率、语言这类可追踪的组合（见 src/lib/guest-identity.ts）。
 */

/** localStorage 里用到的最小接口（测试里可以塞个假的进来）。 */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 设备指纹的存储键。 */
export const DEVICE_ID_KEY = "com-ai.device-id";
/** 本地收藏清单的存储键。 */
export const FAVORITES_KEY = "com-ai.favorites";

/** 存储不可用时的统一提示文案。 */
export const STORAGE_UNAVAILABLE_MESSAGE = "当前环境无法保存收藏";

/** 存不住时的易失设备指纹（同一个页面会话内保持不变）。 */
let volatileDeviceId: string | null = null;

/** 浏览器里的 localStorage；不可用时返回 null。 */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof globalThis.localStorage === "undefined") {
      return null;
    }
    return globalThis.localStorage;
  } catch {
    // 某些浏览器在访问 localStorage 时就会抛异常（隐私模式 / 禁用 cookie）。
    return null;
  }
}

/** 生成一串随机设备指纹原文。 */
export function newDeviceId(): string {
  const cryptoRef = globalThis.crypto;

  if (typeof cryptoRef?.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }

  if (typeof cryptoRef?.getRandomValues === "function") {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // 极老的环境：仍然给出一串随机值，只是熵低一些。
  return `fallback-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * 读取（或生成）设备指纹原文。
 *
 * `persistent` = false 表示这次没能存住（隐私模式之类），
 * 调用方据此提示用户，而不是假装一切正常。
 */
export function ensureDeviceId(storage: StorageLike | null): {
  id: string;
  persistent: boolean;
} {
  if (storage) {
    try {
      const existing = storage.getItem(DEVICE_ID_KEY);
      if (existing) {
        return { id: existing, persistent: true };
      }

      const created = newDeviceId();
      storage.setItem(DEVICE_ID_KEY, created);
      return { id: created, persistent: true };
    } catch {
      // 落到下面的易失分支。
    }
  }

  if (!volatileDeviceId) {
    volatileDeviceId = newDeviceId();
  }
  return { id: volatileDeviceId, persistent: false };
}

/**
 * 读本地收藏清单。
 *
 * `available` = false 表示存储不可用（读不到、也写不进）。
 */
export function readFavoriteSlugs(storage: StorageLike | null): {
  slugs: string[];
  available: boolean;
} {
  if (!storage) {
    return { slugs: [], available: false };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(FAVORITES_KEY);
  } catch {
    return { slugs: [], available: false };
  }

  if (!raw) {
    return { slugs: [], available: true };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { slugs: [], available: true };
    }
    return {
      slugs: parsed.filter((entry): entry is string => typeof entry === "string"),
      available: true,
    };
  } catch {
    // 清单坏了（被人改过）不等于存储不可用：当作空清单，但仍然可以往里写。
    return { slugs: [], available: true };
  }
}

/**
 * 把资产加入 / 移出本地收藏清单。
 *
 * 返回写完之后的状态；存储不可用时 `available` 为 false 且清单不变。
 */
export function toggleFavoriteSlug(
  storage: StorageLike | null,
  slug: string,
): { slugs: string[]; favorited: boolean; available: boolean } {
  const current = readFavoriteSlugs(storage);
  return setFavoriteSlug(storage, slug, !current.slugs.includes(slug));
}

/**
 * 把本地收藏清单设成指定状态（加入或移出）。
 *
 * 方向由调用方决定（服务端状态说了算），避免本地清单与服务端不同步时点错方向。
 */
export function setFavoriteSlug(
  storage: StorageLike | null,
  slug: string,
  favorited: boolean,
): { slugs: string[]; favorited: boolean; available: boolean } {
  const current = readFavoriteSlugs(storage);
  if (!current.available || !storage) {
    return { slugs: current.slugs, favorited: false, available: false };
  }

  const has = current.slugs.includes(slug);
  if (has === favorited) {
    return { slugs: current.slugs, favorited, available: true };
  }

  const slugs = favorited
    ? [...current.slugs, slug]
    : current.slugs.filter((entry) => entry !== slug);

  try {
    storage.setItem(FAVORITES_KEY, JSON.stringify(slugs));
  } catch {
    return { slugs: current.slugs, favorited: false, available: false };
  }

  return { slugs, favorited, available: true };
}
