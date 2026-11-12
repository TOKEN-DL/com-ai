/**
 * 许可证 override 的匹配规则与种子数据（票 #15）。
 *
 * 验的是三件事：
 *   1. **仓库级 + 文件级**两级覆盖的匹配规则（文件级优先）；
 *   2. 「一仓两许可」能不能表达 —— `f/prompts.chat` 的 prompt 内容是 CC0、
 *      源码是 MIT，两边必须判出不同的结果；
 *   3. 迁移里 seed 的 override 行与应用层算出来的 id 一致（防漂移）。
 */
import { describe, expect, it } from "vitest";

import {
  licenseOverrideId,
  loadLicenseOverrides,
  resolveLicenseOverride,
  type LicenseOverrideRow,
} from "@/lib/license-override";

/** 造一行 override。 */
function row(partial: Partial<LicenseOverrideRow> & { repoSlug: string; spdxId: string }) {
  const appliesTo = partial.appliesTo ?? [];
  return {
    id: partial.id ?? licenseOverrideId(partial.repoSlug, partial.spdxId, appliesTo),
    repoSlug: partial.repoSlug,
    spdxId: partial.spdxId,
    appliesTo,
    evidence: partial.evidence ?? null,
    attribution: partial.attribution ?? null,
    note: partial.note ?? null,
  };
}

describe("override 匹配规则", () => {
  it("没有 override 时用上游自己声明的许可证", () => {
    const resolved = resolveLicenseOverride([], "f/prompts.chat", "prompts.csv", "mit");
    expect(resolved.spdxId).toBe("mit");
    expect(resolved.match).toBe("detected");
    expect(resolved.matchedId).toBeNull();
  });

  it("上游声明的是 NOASSERTION 时如实保留（→ 会落 METADATA_ONLY）", () => {
    const resolved = resolveLicenseOverride([], "whoever/whatever", "README.md", "NOASSERTION");
    expect(resolved.spdxId).toBe("noassertion");
    expect(resolved.match).toBe("detected");
  });

  it("文件级 override 优先于仓库级 override", () => {
    const overrides: LicenseOverrideRow[] = [
      row({ repoSlug: "f/prompts.chat", spdxId: "mit" }),
      row({ repoSlug: "f/prompts.chat", spdxId: "cc0-1.0", appliesTo: ["prompts.csv"] }),
    ];

    const file = resolveLicenseOverride(overrides, "f/prompts.chat", "prompts.csv", "NOASSERTION");
    expect(file.spdxId).toBe("cc0-1.0");
    expect(file.match).toBe("file");

    // 同一个仓库的别的文件 → 落到仓库级的 MIT。
    const other = resolveLicenseOverride(overrides, "f/prompts.chat", "src/index.ts", "NOASSERTION");
    expect(other.spdxId).toBe("mit");
    expect(other.match).toBe("repo");
  });

  it("文件级规则支持 glob", () => {
    const overrides: LicenseOverrideRow[] = [
      row({ repoSlug: "a/b", spdxId: "cc-by-4.0", appliesTo: ["README*.md"] }),
    ];

    expect(resolveLicenseOverride(overrides, "a/b", "README.md", null).spdxId).toBe("cc-by-4.0");
    expect(resolveLicenseOverride(overrides, "a/b", "README_zh.md", null).spdxId).toBe("cc-by-4.0");
    expect(resolveLicenseOverride(overrides, "a/b", "other.md", null).match).toBe("detected");
  });

  it("多条文件级规则命中时，取最具体的那条", () => {
    const overrides: LicenseOverrideRow[] = [
      row({ repoSlug: "a/b", spdxId: "cc0-1.0", appliesTo: ["**"] }),
      row({ repoSlug: "a/b", spdxId: "mit", appliesTo: ["docs/**"] }),
      row({ repoSlug: "a/b", spdxId: "apache-2.0", appliesTo: ["docs/api.md"] }),
    ];

    // 精确路径最具体。
    expect(resolveLicenseOverride(overrides, "a/b", "docs/api.md", null).spdxId).toBe("apache-2.0");
    // 其余 docs 下的文件命中 docs/**。
    expect(resolveLicenseOverride(overrides, "a/b", "docs/guide.md", null).spdxId).toBe("mit");
    // 其它路径落到兜底的 **。
    expect(resolveLicenseOverride(overrides, "a/b", "src/main.ts", null).spdxId).toBe("cc0-1.0");
  });

  it("仓库标识大小写不敏感", () => {
    const overrides: LicenseOverrideRow[] = [
      row({ repoSlug: "F/Prompts.Chat", spdxId: "cc0-1.0", appliesTo: ["prompts.csv"] }),
    ];
    expect(resolveLicenseOverride(overrides, "f/prompts.chat", "prompts.csv", null).spdxId).toBe(
      "cc0-1.0",
    );
  });

  it("override 的 spdxId 写成空串 = 明确「不允许再分发」", () => {
    const overrides: LicenseOverrideRow[] = [
      row({ repoSlug: "a/b", spdxId: "", appliesTo: ["data/**"] }),
    ];
    const resolved = resolveLicenseOverride(overrides, "a/b", "data/x.json", "mit");
    expect(resolved.spdxId).toBeNull();
    expect(resolved.match).toBe("file");
  });

  it("署名跟着命中的那条 override 走", () => {
    const overrides: LicenseOverrideRow[] = [
      row({
        repoSlug: "a/b",
        spdxId: "cc-by-4.0",
        appliesTo: ["README.md"],
        attribution: "A / b — CC BY 4.0 — https://github.com/a/b",
      }),
    ];
    const resolved = resolveLicenseOverride(overrides, "a/b", "README.md", "NOASSERTION");
    expect(resolved.attribution).toBe("A / b — CC BY 4.0 — https://github.com/a/b");
  });

  it("id 是确定性的：同样的输入永远算出同一个 id", () => {
    expect(licenseOverrideId("f/prompts.chat", "cc0-1.0", ["prompts.csv", "PROMPTS.md"])).toBe(
      licenseOverrideId("f/prompts.chat", "cc0-1.0", ["PROMPTS.md", "prompts.csv"]),
    );
    expect(licenseOverrideId("a/b", "mit", [])).toBe("a/b::mit::");
  });
});

describe("迁移 seed 的 override 数据", () => {
  it("每一行的 id 都与应用层的派生规则一致（防漂移）", async () => {
    const rows = await loadLicenseOverrides();
    expect(rows.length).toBeGreaterThan(0);

    for (const item of rows) {
      expect(item.id).toBe(licenseOverrideId(item.repoSlug, item.spdxId, item.appliesTo));
    }
  });

  it("「一仓两许可」表达出来了：prompt 内容 CC0、源码 MIT", async () => {
    const rows = await loadLicenseOverrides();
    const repo = "f/prompts.chat";

    const content = resolveLicenseOverride(rows, repo, "prompts.csv", "NOASSERTION");
    expect(content.spdxId).toBe("cc0-1.0");
    expect(content.match).toBe("file");

    const source = resolveLicenseOverride(rows, repo, "src/index.ts", "NOASSERTION");
    expect(source.spdxId).toBe("mit");
    expect(source.match).toBe("repo");
  });

  it("CC BY 4.0 的源带署名要求（作者 + 许可证标识 + 原仓库链接）", async () => {
    const rows = await loadLicenseOverrides();
    const resolved = resolveLicenseOverride(
      rows,
      "YouMind-OpenLab/awesome-seedance-2-prompts",
      "README.md",
      "NOASSERTION",
    );

    expect(resolved.spdxId).toBe("cc-by-4.0");
    expect(resolved.attribution).toContain("CC BY 4.0");
    expect(resolved.attribution).toContain("https://github.com/YouMind-OpenLab");
  });

  it("每条 override 都带人读证据（能审计）", async () => {
    const rows = await loadLicenseOverrides();
    for (const item of rows) {
      expect(item.evidence).toBeTruthy();
    }
  });
});
