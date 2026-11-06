/**
 * 版本号的形态判别与比较（票 #16「版本管理与一键更新」）。
 *
 * 站内的版本号只有两种形态，**共用一张 `AssetVersion` 表**：
 *   - **上游 commit sha**（采集来的资产）：版本 = 上游仓库的那次提交；
 *   - **平台 semver**（用户发布的资产）：版本 = 发布者声明的版本号。
 *
 * 这个模块只放纯函数：形态判别 + semver 比较。
 * 不碰数据库、不碰网络 —— 单元测试直接跑，不需要测试库。
 *
 * 为什么要单独判别形态：
 *   1. sha **没有顺序**（不能按字符串比大小判断新旧），semver 有；
 *   2. 展示时两者该显示成不同样式（「上游提交 abc1234」vs「版本 v1.2.0」）；
 *   3. 「来源可区分」除了数据库里的 `origin` 列，版本号本身的形态也是一道兜底。
 */

/** 版本号的形态。 */
export type VersionShape =
  /// 上游 commit sha。
  | "sha"
  /// 平台 semver（x.y.z）。
  | "semver"
  /// 认不出来的形态（脏数据 / 将来新增的形态）。
  | "unknown";

/**
 * commit sha：7–40 位十六进制。
 *
 * 7 位是 GitHub 展示用的短 sha，40 位是完整 sha。
 */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * semver：`主版本.次版本.修订号`，可带预发布标识（`-beta.1`）与构建元数据（`+build`）。
 *
 * 不接受 `v1.2.0` 这种带 `v` 前缀的写法 —— 落库的是**规范化**的版本号，
 * 前缀只是展示层的装饰。
 */
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** 解析出来的 semver 结构。 */
export type SemverParts = {
  major: number;
  minor: number;
  patch: number;
  /// 预发布标识（`1.0.0-beta.1` 的 `beta.1`）；没有则 null。
  prerelease: string | null;
};

/** 是不是一个 commit sha。 */
export function isCommitSha(value: string): boolean {
  return SHA_PATTERN.test(value.trim());
}

/** 是不是一个合法的 semver。 */
export function isSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value.trim());
}

/**
 * 解析 semver。解析不出来返回 null（**不抛错**）。
 *
 * 库里可能存着脏数据，读取路径上不该因为一条坏数据把整个页面炸掉。
 */
export function parseSemver(value: string): SemverParts | null {
  const matched = SEMVER_PATTERN.exec(value.trim());
  if (!matched) {
    return null;
  }

  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    prerelease: matched[4] ?? null,
  };
}

/**
 * 比较两个 semver：a 比 b 新返回 1，一样返回 0，旧返回 -1。
 *
 * 任一侧不是合法 semver 时返回 **null**（= 比不了），调用方自己决定怎么降级。
 *
 * 预发布标识按 semver 规范：`1.0.0-alpha` **小于** `1.0.0`；
 * 两个都有预发布时逐段比，纯数字段按数值比，其余按字符串比。
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    return null;
  }

  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;

  return comparePrerelease(left.prerelease, right.prerelease);
}

/** 预发布标识的比较。 */
function comparePrerelease(left: string | null, right: string | null): number {
  // 没有预发布标识的版本**更大**（1.0.0 > 1.0.0-alpha）。
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const leftParts = left.split(".");
  const rightParts = right.split(".");

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];

    // 短的那个是前缀 → 短的小（1.0.0-alpha < 1.0.0-alpha.1）。
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber > rightNumber ? 1 : -1;
    }
    // 数字段永远小于非数字段（semver 规范）。
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;

    return leftPart > rightPart ? 1 : -1;
  }

  return 0;
}

/**
 * 判别一个版本号是什么形态。
 *
 * 判不出来时返回 `"unknown"` —— **不猜**。猜错了会把上游 sha 当成平台 semver
 * （或者反过来），更新提示就会指错版本。
 */
export function classifyVersion(value: string): VersionShape {
  const trimmed = value.trim();
  if (isCommitSha(trimmed)) {
    return "sha";
  }
  if (isSemver(trimmed)) {
    return "semver";
  }
  return "unknown";
}

/**
 * 候选版本是否比当前版本「新」。
 *
 * - 上游（sha）：sha **没有顺序**，只要跟当前的不一样就是新的；
 * - 平台（semver）：按 semver 比较，**必须真的更大**（同版本重复发布不算更新）。
 *
 * 当前版本为空（第一次见这个资产）时，任何候选都算新。
 */
export function isNewerVersion(
  current: string | null | undefined,
  candidate: string,
  origin: "UPSTREAM" | "PLATFORM",
): boolean {
  const currentValue = (current ?? "").trim();
  if (currentValue.length === 0) {
    return true;
  }

  if (origin === "UPSTREAM") {
    return currentValue !== candidate.trim();
  }

  const compared = compareSemver(candidate, currentValue);
  // 比不了（脏数据）时**不**当成更新 —— 宁可少提示，也不要误报。
  return compared !== null && compared > 0;
}

/**
 * 展示用的短版本号：sha 取前 7 位（与 GitHub 一致），semver 原样。
 */
export function shortVersionLabel(value: string): string {
  const trimmed = value.trim();
  if (isCommitSha(trimmed)) {
    return trimmed.slice(0, 7);
  }
  return trimmed;
}
