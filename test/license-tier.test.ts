/**
 * 许可证分层判定的纯函数单元测试（spec 决策 6 / 票 #3 验收标准）。
 *
 * 这条判定是整个内容版权策略的入口：
 *   FULL          = 允许再分发，可存正文、可生成基于原文的简介；
 *   METADATA_ONLY = 只存元数据与链接，不复制原文。
 *
 * 判定必须是纯函数：同样的输入永远得到同样的输出，不依赖数据库、时间或环境。
 * 数据库侧的强制执行（触发器）见 test/asset-content-tier.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
  REDISTRIBUTABLE_LICENSES,
  isRedistributableLicense,
  normalizeSpdxId,
  resolveContentTier,
} from "@/lib/license-tier";

describe("normalizeSpdxId", () => {
  it("统一转成小写并去掉首尾空白", () => {
    expect(normalizeSpdxId("  MIT  ")).toBe("mit");
    expect(normalizeSpdxId("Apache-2.0")).toBe("apache-2.0");
  });

  it("缺失 / 空串 / 只有空白都归一成 null（视为「未声明许可证」）", () => {
    expect(normalizeSpdxId(null)).toBeNull();
    expect(normalizeSpdxId(undefined)).toBeNull();
    expect(normalizeSpdxId("")).toBeNull();
    expect(normalizeSpdxId("   ")).toBeNull();
  });
});

describe("resolveContentTier —— 允许再分发的许可", () => {
  it("CC0 / MIT / Apache-2.0 判为 FULL", () => {
    expect(resolveContentTier("CC0-1.0")).toBe("FULL");
    expect(resolveContentTier("MIT")).toBe("FULL");
    expect(resolveContentTier("Apache-2.0")).toBe("FULL");
  });

  it("大小写与空白不影响判定（GitHub API 返回的是小写 spdx_id）", () => {
    expect(resolveContentTier("mit")).toBe("FULL");
    expect(resolveContentTier(" apache-2.0 ")).toBe("FULL");
    expect(isRedistributableLicense("cc0-1.0")).toBe(true);
  });

  it("白名单里的每一个许可都判为 FULL", () => {
    for (const spdxId of REDISTRIBUTABLE_LICENSES) {
      expect(resolveContentTier(spdxId)).toBe("FULL");
    }
  });
});

describe("resolveContentTier —— 未知许可", () => {
  it("GitHub 无法识别许可时的 NOASSERTION 判为 METADATA_ONLY", () => {
    expect(resolveContentTier("NOASSERTION")).toBe("METADATA_ONLY");
  });

  it("指向文件的许可声明判为 METADATA_ONLY", () => {
    expect(resolveContentTier("SEE LICENSE IN LICENSE.md")).toBe("METADATA_ONLY");
  });

  it("拼写不认识的许可判为 METADATA_ONLY", () => {
    expect(resolveContentTier("MIT-ish")).toBe("METADATA_ONLY");
    expect(resolveContentTier("Apache 2.0")).toBe("METADATA_ONLY");
  });

  it("限制性许可（copyleft / 专有）判为 METADATA_ONLY", () => {
    expect(resolveContentTier("GPL-3.0")).toBe("METADATA_ONLY");
    expect(resolveContentTier("AGPL-3.0")).toBe("METADATA_ONLY");
    expect(resolveContentTier("proprietary")).toBe("METADATA_ONLY");
  });
});

describe("resolveContentTier —— 许可字段缺失", () => {
  it("null / undefined / 空串都判为 METADATA_ONLY", () => {
    expect(resolveContentTier(null)).toBe("METADATA_ONLY");
    expect(resolveContentTier(undefined)).toBe("METADATA_ONLY");
    expect(resolveContentTier("")).toBe("METADATA_ONLY");
    expect(resolveContentTier("   ")).toBe("METADATA_ONLY");
  });
});
