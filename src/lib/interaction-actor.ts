/**
 * 从请求里认出「当前是谁」，好走互动路径。
 *
 * 主体有三种可能：
 *   1. 已登录的账号（有会话）→ 归属账号，**不受游客限流约束**；
 *   2. 游客（带设备指纹）→ 归属设备指纹，按 IP 限流；
 *   3. 什么都没有 → 明确报错，不静默写匿名行。
 */
import type { InteractionActor } from "@/lib/interactions";
import {
  clientIpFromRequest,
  hashClientIp,
  hashDeviceId,
  isValidDeviceId,
} from "@/lib/guest-identity";
import { getSessionUser } from "@/lib/session";

/** 认出主体成功 / 失败的结果。 */
export type ResolvedActor =
  | { ok: true; actor: InteractionActor }
  | { ok: false; status: number; error: string; message: string };

/** 浏览器带上设备指纹的请求头。 */
export const DEVICE_ID_HEADER = "x-device-id";

/**
 * 认出当前请求的互动主体。
 *
 * 失败时给出**用户可见**的提示文案 —— 互动被拒不能是静默的。
 */
export async function resolveInteractionActor(request: Request): Promise<ResolvedActor> {
  const session = await getSessionUser(request);
  if (session) {
    return { ok: true, actor: { userId: session.id } };
  }

  const deviceId = request.headers.get(DEVICE_ID_HEADER);
  if (!deviceId) {
    return {
      ok: false,
      status: 400,
      error: "missing_device_id",
      message: "缺少设备标识，请刷新页面后重试。",
    };
  }

  if (!isValidDeviceId(deviceId)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_device_id",
      message: "设备标识格式不正确，请刷新页面后重试。",
    };
  }

  const ip = clientIpFromRequest(request);

  return {
    ok: true,
    actor: {
      // 落库的只有哈希值：明文设备指纹与明文 IP 都不进数据库。
      deviceId: hashDeviceId(deviceId),
      ipHash: ip ? hashClientIp(ip) : null,
    },
  };
}
