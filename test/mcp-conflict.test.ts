/**
 * 冲突检测纯函数的单元测试（票 #14）。
 *
 * 验收标准要求这个函数是**纯函数**，并且有独立用例覆盖四种输入：
 * 无冲突 / 环境变量冲突 / 端口冲突 / 同时冲突。
 *
 * 这里不碰数据库：喂进去的就是「候选声明」与「已接入集合」两张表，
 * 拿出来的就是冲突项列表 —— 同样的输入永远同样的输出。
 */
import { describe, expect, it } from "vitest";

import {
  describeMcpConflict,
  detectMcpConflicts,
  type InstalledMcpServer,
} from "@/lib/mcp-conflict";

/** 已接入的 server：声明 GCS_BUCKET，占 3000 端口。 */
const INSTALLED_FILESYSTEM: InstalledMcpServer = {
  slug: "installed-filesystem",
  displayName: "已接入的 Filesystem Server",
  envVars: ["GCS_BUCKET", "GCS_PRIVATE_KEY"],
  ports: [3000],
};

describe("冲突检测纯函数", () => {
  it("无冲突：环境变量名与端口都不撞 → 空列表", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["SOME_TOKEN"], ports: [8080] },
      [INSTALLED_FILESYSTEM],
    );

    // 空数组 = 页面不展示冲突区域（不制造噪音）。
    expect(conflicts).toEqual([]);
  });

  it("环境变量冲突：候选声明了同名变量 → 报出变量名与撞车的已装 server", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["GCS_BUCKET", "OTHER_TOKEN"], ports: [8080] },
      [INSTALLED_FILESYSTEM],
    );

    expect(conflicts).toEqual([
      {
        kind: "ENV_VAR",
        name: "GCS_BUCKET",
        port: null,
        servers: [{ slug: "installed-filesystem", displayName: "已接入的 Filesystem Server" }],
      },
    ]);
  });

  it("端口冲突：候选声明了同一个端口 → 报出端口号与撞车的已装 server", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["SOME_TOKEN"], ports: [3000, 9000] },
      [INSTALLED_FILESYSTEM],
    );

    expect(conflicts).toEqual([
      {
        kind: "PORT",
        name: "3000",
        port: 3000,
        servers: [{ slug: "installed-filesystem", displayName: "已接入的 Filesystem Server" }],
      },
    ]);
  });

  it("同时冲突：环境变量与端口都撞 → 两种冲突一起报出来", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["GCS_BUCKET"], ports: [3000] },
      [INSTALLED_FILESYSTEM],
    );

    expect(conflicts).toEqual([
      {
        kind: "ENV_VAR",
        name: "GCS_BUCKET",
        port: null,
        servers: [{ slug: "installed-filesystem", displayName: "已接入的 Filesystem Server" }],
      },
      {
        kind: "PORT",
        name: "3000",
        port: 3000,
        servers: [{ slug: "installed-filesystem", displayName: "已接入的 Filesystem Server" }],
      },
    ]);
    expect(conflicts.map((conflict) => conflict.kind)).toEqual(["ENV_VAR", "PORT"]);
  });

  it("候选自己已在集合里：不与自己冲突", () => {
    const conflicts = detectMcpConflicts(
      { slug: "installed-filesystem", envVars: ["GCS_BUCKET"], ports: [3000] },
      [INSTALLED_FILESYSTEM],
    );

    expect(conflicts).toEqual([]);
  });

  it("两个已装 server 抢同一个变量名 → 仍然只报一条，但列出两个来源", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["GCS_BUCKET"], ports: [8080] },
      [
        INSTALLED_FILESYSTEM,
        {
          slug: "installed-backup",
          displayName: "已接入的 Backup Server",
          envVars: ["GCS_BUCKET"],
          ports: [4000],
        },
      ],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].servers.map((server) => server.slug)).toEqual([
      "installed-filesystem",
      "installed-backup",
    ]);
  });

  it("候选重复声明同一个变量名 → 只报一条", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["GCS_BUCKET", "GCS_BUCKET"], ports: [] },
      [INSTALLED_FILESYSTEM],
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].name).toBe("GCS_BUCKET");
  });

  it("变量名大小写不同不算同名（环境变量名大小写敏感）", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["gcs_bucket"], ports: [] },
      [INSTALLED_FILESYSTEM],
    );

    expect(conflicts).toEqual([]);
  });

  it("非法端口（0、超出范围、非整数）不当成冲突", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: [], ports: [0, -1, 65536, 3000.5] },
      [{ slug: "installed-weird", displayName: "已接入的 Weird Server", envVars: [], ports: [0, 65536] }],
    );

    expect(conflicts).toEqual([]);
  });

  it("空的环境变量名被忽略", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["", "   "], ports: [] },
      [{ slug: "installed-empty", displayName: "已接入的 Empty Server", envVars: [""], ports: [] }],
    );

    expect(conflicts).toEqual([]);
  });

  it("已接入集合为空 → 没有冲突", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["GCS_BUCKET"], ports: [3000] },
      [],
    );

    expect(conflicts).toEqual([]);
  });
});

describe("冲突文案", () => {
  it("环境变量冲突说清「哪个变量、与谁同名」", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: ["GCS_BUCKET"], ports: [] },
      [INSTALLED_FILESYSTEM],
    );

    expect(describeMcpConflict(conflicts[0])).toBe(
      "环境变量 GCS_BUCKET 与已接入的 已接入的 Filesystem Server 同名",
    );
  });

  it("端口冲突说清「哪个端口、与谁相同」", () => {
    const conflicts = detectMcpConflicts(
      { slug: "candidate", envVars: [], ports: [3000] },
      [INSTALLED_FILESYSTEM],
    );

    expect(describeMcpConflict(conflicts[0])).toBe(
      "端口 3000 与已接入的 已接入的 Filesystem Server 相同",
    );
  });
});
