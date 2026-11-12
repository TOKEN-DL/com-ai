/**
 * MCP 的「已接入清单」—— 用户已经装了哪些 MCP server（票 #14）。
 *
 * ## 来源
 *
 * 站内自己的记录：`UserInstall` 表（spec 决策 3 的「用户安装清单」，
 * spec 决策 10 说清楚安装清单是**跨设备同步**的那部分，所以它挂在账号下）。
 *
 * ⚠️ **envVars / ports 不在安装记录里冗余存一份**，而是现查 `McpDetail`：
 *    冲突检测要比对的声明， 必须跟详情页展示的声明**是同一份** ——
 *    冗余一份迟早会对不上（采集更新了 server 的声明，装机记录还停在旧值）。
 *    关联路径：`UserInstall.assetId → Asset.id → McpDetail.assetId`。
 *
 * ## 游客态
 *
 * 游客没有账号，也就没有跨设备状态 —— **已接入集合为空**，
 * 于是详情页不展示冲突区域（而不是展示一个「你去装一个再来比」的噪音区）。
 *
 * ## 现状：这一层只负责读
 *
 * ⚠️ 站内目前**还没有写 `UserInstall` 的入口**（没有「标记已接入」的按钮）——
 *    本模块只负责读；接入清单的写入流程落地后，写入方同样写这张表，
 *    冲突检测这一侧不用改。测试里直接写 `UserInstall` 行来构造已接入集合。
 */
import type { InstalledMcpServer } from "@/lib/mcp-conflict";
import { prisma } from "@/lib/prisma";

/**
 * 列出某个用户已接入的 MCP server（带各自的声明）。
 *
 * 装的是 Skill / Prompt 的记录直接跳过 —— 端口与环境变量只有 MCP server 会声明。
 */
export async function listInstalledMcpServers(userId: string): Promise<InstalledMcpServer[]> {
  const rows = await prisma.userInstall.findMany({
    where: { userId },
    include: { asset: { include: { mcpDetail: true } } },
  });

  const servers: InstalledMcpServer[] = [];
  for (const row of rows) {
    const detail = row.asset.mcpDetail;
    if (row.asset.kind !== "MCP" || !detail) {
      continue;
    }
    servers.push({
      slug: row.asset.slug,
      displayName: row.asset.displayName,
      envVars: detail.envVars,
      ports: detail.ports,
    });
  }

  return servers;
}
