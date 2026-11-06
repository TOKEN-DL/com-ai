/**
 * 游客态「我的收藏」的取数路径：本地清单 → 批量查资产。
 *
 * 游客态的收藏清单在浏览器里，服务端不替游客保管清单 ——
 * 所以这一页的数据来源是本地清单 + 一次批量查询。
 */
import { describe, expect, it } from "vitest";

import { loadGuestFavorites } from "@/lib/client/guest-favorites";
import { FAVORITES_KEY, type StorageLike } from "@/lib/client/guest-store";

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(seed));
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("游客态「我的收藏」", () => {
  it("按本地清单批量取资产", async () => {
    const storage = memoryStorage({
      [FAVORITES_KEY]: JSON.stringify(["skill-a", "skill-b"]),
    });

    const requested: string[] = [];
    const fetcher = async (input: string) => {
      requested.push(input);
      return jsonResponse({
        items: [
          { slug: "skill-a", displayName: "A", favoriteCount: 1, likeCount: 2 },
          { slug: "skill-b", displayName: "B", favoriteCount: 3, likeCount: 4 },
        ],
      });
    };

    const result = await loadGuestFavorites({ storage, fetcher });

    expect(result.status).toBe("ok");
    expect(requested).toEqual(["/api/assets?slugs=skill-a,skill-b"]);

    if (result.status === "ok") {
      expect(result.items.map((item) => item.slug)).toEqual(["skill-a", "skill-b"]);
      expect(result.items[0].likeCount).toBe(2);
    }
  });

  it("存储不可用时给出用户可见的提示，而不是白屏", async () => {
    const result = await loadGuestFavorites({ storage: null });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.message).toBe("当前环境无法保存收藏");
    }
  });

  it("本地清单为空时是空状态，不发请求", async () => {
    let called = false;
    const fetcher = async () => {
      called = true;
      return jsonResponse({ items: [] });
    };

    const result = await loadGuestFavorites({ storage: memoryStorage(), fetcher });

    expect(result.status).toBe("empty");
    expect(called).toBe(false);
  });
});
