/**
 * 邮箱地址的归一化与校验。
 *
 * 归一化（去空白 + 转小写）不是为了好看，是因为 `User.email` 是唯一键：
 * `Alice@Example.com` 与 `alice@example.com` 必须是**同一个账号**，
 * 否则一个人能注册出两个账号、收藏也得分两份。
 */

/** 粗粒度的邮箱格式校验。够挡住垃圾输入，不必是完整的 RFC 5322 解析。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** 归一化邮箱：去空白 + 转小写。 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 邮箱格式是否可接受。 */
export function isValidEmail(raw: string): boolean {
  const normalized = normalizeEmail(raw);
  return normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
}
