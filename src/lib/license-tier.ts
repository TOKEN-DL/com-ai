/**
 * 许可证分层判定（spec 决策 6「许可证分层与版权」）。
 *
 * 这是纯函数：输入 SPDX id，输出内容档位。不碰数据库、不看时间、不读环境变量。
 * 数据库侧有一份等价实现（迁移里的触发器），作用是**绕过应用层直接写库也拦得住**；
 * 两者的一致性由 test/asset-content-tier.test.ts 守着。
 *
 * 分档规则（spec 约束 1）：
 *   FULL          —— 允许再分发的许可（CC0 / MIT / Apache-2.0 等）：可存正文、可生成简介；
 *   METADATA_ONLY —— 无许可证、未知许可或限制性许可：只存元数据与链接，不复制原文。
 *
 * 白名单取「明确允许再分发」的宽松许可，判不出来的宁可降到 METADATA_ONLY ——
 * 漏判只会少存正文（安全），错判会把别人的版权正文复制进来（不安全）。
 */
import type { ContentTier } from "@prisma/client";

/**
 * 允许再分发 → FULL 档的许可证白名单。
 *
 * 一律用小写 SPDX id：GitHub API 的 `license.spdx_id` 就是小写
 * （"mit" / "apache-2.0" / "cc0-1.0"），存储与比较都按这个形式。
 *
 * 收录标准：SPDX 明确允许再分发的宽松许可。
 *   - 公共领域 / 宽松许可：0bsd、mit、mit-0、isc、bsd-2-clause、bsd-3-clause、
 *     apache-2.0、unlicense、cc0-1.0、blueoak-1.0.0、python-2.0；
 *   - 署名类（允许再分发，平台始终保留原仓库链接与许可证标识）：
 *     cc-by-4.0、cc-by-sa-4.0。
 *
 * 不在名单里的（GPL / AGPL / 专有 / 未声明 / NOASSERTION）一律 METADATA_ONLY。
 */
export const REDISTRIBUTABLE_LICENSES = [
  "0bsd",
  "apache-2.0",
  "blueoak-1.0.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "cc0-1.0",
  "isc",
  "mit",
  "mit-0",
  "python-2.0",
  "unlicense",
] as const;

/**
 * 归一化 SPDX id：去首尾空白、转小写；空值 / 空串一律视为 null（未声明许可证）。
 */
export function normalizeSpdxId(spdxId: string | null | undefined): string | null {
  const normalized = (spdxId ?? "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** 该许可证是否允许再分发（可存正文、可生成基于原文的简介）。 */
export function isRedistributableLicense(spdxId: string | null | undefined): boolean {
  const normalized = normalizeSpdxId(spdxId);
  if (normalized === null) {
    return false;
  }
  return (REDISTRIBUTABLE_LICENSES as readonly string[]).includes(normalized);
}

/**
 * SPDX id → 内容档位。
 *
 * 这是全站唯一的分档入口：采集器、导入脚本、用户发布都走它，
 * 不允许在别处另写一份判断逻辑。
 */
export function resolveContentTier(spdxId: string | null | undefined): ContentTier {
  return isRedistributableLicense(spdxId) ? "FULL" : "METADATA_ONLY";
}
