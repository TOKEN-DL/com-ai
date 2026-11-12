/**
 * 版本号形态与比较的纯函数测试（票 #16）。
 *
 * 这一层不碰数据库、不碰网络：sha 与 semver 的判别、semver 的大小比较、
 * 「候选版本是不是更新」的判断，全是纯函数，直接跑。
 */
import { describe, expect, it } from "vitest";

import {
  classifyVersion,
  compareSemver,
  isCommitSha,
  isNewerVersion,
  isSemver,
  parseSemver,
  shortVersionLabel,
} from "@/lib/version-format";

describe("版本号形态判别", () => {
  it("commit sha：7 位短 sha 与 40 位完整 sha 都算", () => {
    expect(isCommitSha("9f1c2b7")).toBe(true);
    expect(isCommitSha("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c")).toBe(true);
    expect(isCommitSha("9F1C2B7D4E5A6F708192A3B4C5D6E7F8091A2B3C")).toBe(true);
  });

  it("不是 sha 的东西不能被当成 sha", () => {
    expect(isCommitSha("1.2.3")).toBe(false);
    expect(isCommitSha("9f1c2b")).toBe(false); // 只有 6 位
    expect(isCommitSha("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c4d")).toBe(false); // 41 位
    expect(isCommitSha("zzzzzzz")).toBe(false);
  });

  it("semver：三段式，带预发布 / 构建元数据都认", () => {
    expect(isSemver("1.0.0")).toBe(true);
    expect(isSemver("0.12.3")).toBe(true);
    expect(isSemver("1.0.0-beta.1")).toBe(true);
    expect(isSemver("1.0.0+build.5")).toBe(true);
  });

  it("semver：两段式、带 v 前缀都不认", () => {
    expect(isSemver("1.0")).toBe(false);
    expect(isSemver("v1.0.0")).toBe(false);
    expect(isSemver("latest")).toBe(false);
  });

  it("semver：首尾空格会被去掉（库里的脏值不该误判）", () => {
    expect(isSemver("1.0.0 ")).toBe(true);
    expect(parseSemver(" 1.0.0 ")?.major).toBe(1);
  });

  it("classifyVersion：sha / semver / 认不出来", () => {
    expect(classifyVersion("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c")).toBe("sha");
    expect(classifyVersion("1.4.2")).toBe("semver");
    expect(classifyVersion("main")).toBe("unknown");
  });

  it("shortVersionLabel：sha 取前 7 位，semver 原样", () => {
    expect(shortVersionLabel("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c")).toBe("9f1c2b7");
    expect(shortVersionLabel("1.4.2")).toBe("1.4.2");
  });
});

describe("semver 解析与比较", () => {
  it("解析出主次修订与预发布标识", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
    expect(parseSemver("1.2.3-beta.1")?.prerelease).toBe("beta.1");
    expect(parseSemver("不是版本")).toBeNull();
  });

  it("主版本优先于次版本，次版本优先于修订号", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.9.9", "2.0.0")).toBe(-1);
    expect(compareSemver("1.2.0", "1.1.9")).toBe(1);
    expect(compareSemver("1.1.3", "1.1.2")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("预发布版本比正式版本旧", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
  });

  it("比不了的时候返回 null（不猜）", () => {
    expect(compareSemver("1.0.0", "不是版本")).toBeNull();
    expect(compareSemver("", "1.0.0")).toBeNull();
  });
});

describe("「是不是新版本」的判断", () => {
  it("上游 sha：跟当前不一样就是新的", () => {
    expect(
      isNewerVersion(
        "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
        "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
        "UPSTREAM",
      ),
    ).toBe(true);
    expect(
      isNewerVersion(
        "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
        "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
        "UPSTREAM",
      ),
    ).toBe(false);
  });

  it("上游 sha：当前版本为空（第一次见）算新的", () => {
    expect(isNewerVersion(null, "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c", "UPSTREAM")).toBe(
      true,
    );
    expect(isNewerVersion(undefined, "9f1c2b7", "UPSTREAM")).toBe(true);
  });

  it("平台 semver：必须真的更大（同版本重复发布不算更新）", () => {
    expect(isNewerVersion("1.0.0", "1.0.1", "PLATFORM")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0", "PLATFORM")).toBe(false);
    expect(isNewerVersion("1.1.0", "1.0.9", "PLATFORM")).toBe(false);
  });

  it("平台 semver：当前版本不是合法 semver 时不误报", () => {
    expect(isNewerVersion("latest", "1.0.0", "PLATFORM")).toBe(false);
  });
});
