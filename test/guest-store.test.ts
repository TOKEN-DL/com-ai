/**
 * 游客态的本地存储：设备指纹与本地收藏清单。
 *
 * 这些是**浏览器侧**的行为，没法在 HTTP 边界上观察，所以单独测纯逻辑：
 * 给一个假的 Storage（或者一个会抛异常的 Storage，模拟隐私模式），
 * 断言存了什么、读出了什么、不可用时怎么降级。
 */
import { describe, expect, it } from "vitest";

import {
  ensureDeviceId,
  readFavoriteSlugs,
  toggleFavoriteSlug,
  type StorageLike,
} from "@/lib/client/guest-store";

/** 内存版 Storage。 */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 隐私模式下的 Storage：任何读写都抛异常。 */
function throwingStorage(): StorageLike {
  const boom = () => {
    throw new Error("SecurityError: 存储不可用");
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

describe("设备指纹", () => {
  it("第一次读会生成一个随机 id，之后一直读到同一个", () => {
    const storage = memoryStorage();

    const first = ensureDeviceId(storage);
    const second = ensureDeviceId(storage);

    expect(first.id).toBe(second.id);
    expect(first.id.length).toBeGreaterThanOrEqual(8);
    expect(first.persistent).toBe(true);
  });

  it("存储不可用时降级：仍然给得出 id，但明确说没存住", () => {
    const result = ensureDeviceId(throwingStorage());

    expect(result.id.length).toBeGreaterThanOrEqual(8);
    expect(result.persistent).toBe(false);
  });

  it("存储不可用时，同一次页面会话里 id 保持不变", () => {
    const storage = throwingStorage();

    expect(ensureDeviceId(storage).id).toBe(ensureDeviceId(storage).id);
  });
});

describe("本地收藏清单", () => {
  it("收藏与取消收藏都改本地清单", () => {
    const storage = memoryStorage();

    const added = toggleFavoriteSlug(storage, "skill-a");
    expect(added.favorited).toBe(true);
    expect(added.available).toBe(true);
    expect(added.slugs).toEqual(["skill-a"]);

    expect(readFavoriteSlugs(storage).slugs).toEqual(["skill-a"]);

    const removed = toggleFavoriteSlug(storage, "skill-a");
    expect(removed.favorited).toBe(false);
    expect(removed.slugs).toEqual([]);
  });

  it("重复收藏同一个资产不会产生第二条", () => {
    const storage = memoryStorage();

    toggleFavoriteSlug(storage, "skill-a");
    const second = toggleFavoriteSlug(storage, "skill-a");

    expect(second.slugs).toEqual([]);
    expect(second.favorited).toBe(false);
  });

  it("存储不可用时优雅降级：清单读不到、也写不进去", () => {
    const storage = throwingStorage();

    const read = readFavoriteSlugs(storage);
    expect(read.available).toBe(false);
    expect(read.slugs).toEqual([]);

    const toggled = toggleFavoriteSlug(storage, "skill-a");
    expect(toggled.available).toBe(false);
    expect(toggled.favorited).toBe(false);
  });

  it("没有存储时（null）同样降级而不是抛异常", () => {
    const read = readFavoriteSlugs(null);
    expect(read.available).toBe(false);
    expect(read.slugs).toEqual([]);

    const toggled = toggleFavoriteSlug(null, "skill-a");
    expect(toggled.available).toBe(false);
  });
});
