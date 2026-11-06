/**
 * 游客态的身份：设备指纹与 IP 限流。
 *
 * spec 约束 8：点赞游客态，**设备指纹 + IP 限流**。两条硬规矩：
 *
 *   1. **不采集可追踪的指纹**。
 *      不用 UA、屏幕分辨率、语言、时区这类「浏览器特征」——它们既能撞库
 *      （同一台机器换浏览器就认不出）又构成反追踪指纹。
 *      设备指纹改成：浏览器本地生成的一串随机 id，存 localStorage，
 *      服务端**只存它的哈希**。随机 = 不可关联；哈希 = 落库的也不是原文。
 *
 *   2. **IP 只存哈希**。
 *      限流要看 IP，但明文 IP 等于把用户的位置写进数据库。
 *      取到 IP 立刻哈希，明文不落库、不进日志、不回传。
 *
 * 哈希用 HMAC-SHA256，并做**域分隔**（设备 / IP 用不同前缀），
 * 交叉碰撞也推不出对方的原值。密钥来自环境变量，不进仓库：
 * 优先 `INTERACTION_HASH_SECRET`，没配就退回 `DATABASE_URL`
 * （同样是环境变量、同样带密钥性质，保证重启后哈希不变）。
 */
import { createHmac } from "node:crypto";

/**
 * 浏览器生成的设备指纹原文格式。
 * 宽松到能装下 UUID 与随机串，又紧到能挡住垃圾输入。
 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** 限流默认参数：同一 IP 在时间窗内对**同一资产**的互动条数上限。 */
const DEFAULT_MAX_PER_WINDOW = 10;
const DEFAULT_WINDOW_SECONDS = 3600;

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 设备指纹原文是否是可接受的格式。 */
export function isValidDeviceId(raw: string): boolean {
  return DEVICE_ID_PATTERN.test(raw);
}

/** 哈希用的密钥材料。只从环境变量取，绝不写进代码。 */
function hashKey(): string {
  return process.env.INTERACTION_HASH_SECRET ?? process.env.DATABASE_URL ?? "";
}

/** 域分隔的 HMAC-SHA256：设备指纹与 IP 走不同前缀。 */
function hmac(domain: string, value: string): string {
  return createHmac("sha256", hashKey()).update(`${domain}:${value}`).digest("hex");
}

/** 设备指纹原文 → 落库的哈希值。 */
export function hashDeviceId(raw: string): string {
  return hmac("device", raw);
}

/** 客户端 IP → 落库的哈希值。 */
export function hashClientIp(ip: string): string {
  return hmac("ip", ip);
}

/**
 * 取客户端 IP。
 *
 * 多层代理时 `x-forwarded-for` 是一串「客户端, 代理1, 代理2」。
 * **只取最右一跳**：每一层代理都把自己看到的对端地址追加到末尾，
 * 所以最右边那段是**我们的边缘代理亲眼看到的地址**。
 * 伪造只能污染左边的段 —— 想伪造最右那段，就得连我们的边缘代理一起骗过去。
 *
 * 拿不到 IP 时返回 null（退化成只靠设备指纹的唯一约束）。
 */
export function clientIpFromRequest(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) {
    return null;
  }

  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (hops.length === 0) {
    return null;
  }

  const candidate = hops[hops.length - 1];
  return isIpAddress(candidate) ? candidate : null;
}

/** 粗粒度的 IP 字面量校验（够挡住垃圾输入，不必是完整的地址解析器）。 */
function isIpAddress(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  // IPv6：含冒号，且只由十六进制数字、冒号与点组成。
  return value.includes(":") && /^[0-9A-Fa-f:.]+$/.test(value);
}

/**
 * 游客态限流参数。
 *
 * 同一 IP 在时间窗内对**同一资产**的点赞 / 收藏条数上限。
 * 可用环境变量 `GUEST_RATE_LIMIT_MAX` / `GUEST_RATE_LIMIT_WINDOW_SECONDS` 覆盖。
 */
export function guestRateLimit(): { max: number; windowSeconds: number } {
  const max = Number.parseInt(process.env.GUEST_RATE_LIMIT_MAX ?? "", 10);
  const windowSeconds = Number.parseInt(process.env.GUEST_RATE_LIMIT_WINDOW_SECONDS ?? "", 10);

  return {
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_PER_WINDOW,
    windowSeconds:
      Number.isFinite(windowSeconds) && windowSeconds > 0
        ? windowSeconds
        : DEFAULT_WINDOW_SECONDS,
  };
}
