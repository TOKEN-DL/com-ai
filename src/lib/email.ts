/**
 * 邮件发送（只用于「登录链接」这一种邮件）。
 *
 * 为什么抽成接口：本机 / 开发环境**没有配 SMTP，也没有任何邮件服务凭据**。
 * 如果把邮件 SDK 直接写进业务流程，就得为它准备凭据；没凭据时要么启动崩，
 * 要么流程卡死。抽成接口之后：
 *
 *   - 默认实现（`console`）把链接写进服务端日志，并在响应里回显给用户 ——
 *     开发环境不配邮件也能把整条登录链路走通；
 *   - 生产接入真实邮件服务时**只换实现**，判定逻辑（限流、一次性、有效期）一行不动；
 *   - 不引入任何需要凭据才能初始化的邮件 SDK，所以**没有凭据也不会崩**。
 *
 * `exposesLink` 告诉调用方「这个发送器会不会把链接回显给用户」。
 * 只有开发模式才回显 —— 生产环境回显等于把登录链接公开。
 */
import { httpEmailConfig } from "@/lib/auth-config";

/** 一封登录链接邮件的内容。 */
export type MagicLinkEmail = {
  /** 收件人邮箱。 */
  to: string;
  /** 一次性登录链接。 */
  link: string;
  /** 链接的过期时刻。 */
  expiresAt: Date;
};

/** 邮件发送器。实现可以换，调用方只认这三个字段。 */
export type EmailSender = {
  /** 实现标识（如 `console` / `http`），会出现在响应体与日志里。 */
  readonly id: string;
  /** 是否把链接回显给用户（仅开发模式为 true）。 */
  readonly exposesLink: boolean;
  /** 发送登录链接邮件。抛异常 = 发送失败。 */
  sendMagicLink(email: MagicLinkEmail): Promise<void>;
};

/** 开发模式发送器：把链接写进服务端日志。 */
export const consoleEmailSender: EmailSender = {
  id: "console",
  exposesLink: true,
  async sendMagicLink(email) {
    console.warn(
      [
        "[auth] 未配置邮件服务，登录链接只输出到服务端日志（不会真的发信）。",
        `  收件人：${email.to}`,
        `  登录链接：${email.link}`,
        `  过期时间：${email.expiresAt.toISOString()}`,
      ].join("\n"),
    );
  },
};

/** 生产发送器：POST 到一个通用的邮件 HTTP 接口（不绑定某一家邮件 SDK）。 */
function createHttpEmailSender(config: {
  apiUrl: string;
  apiKey: string | null;
  from: string;
}): EmailSender {
  return {
    id: "http",
    exposesLink: false,
    async sendMagicLink(email) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (config.apiKey) {
        headers.authorization = `Bearer ${config.apiKey}`;
      }

      const response = await fetch(config.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: config.from,
          to: email.to,
          subject: "com-ai 登录链接",
          text: `点击下面的链接完成登录（${email.expiresAt.toISOString()} 过期，只能用一次）：\n\n${email.link}\n`,
          html: `<p>点击下面的链接完成登录（过期时间 ${email.expiresAt.toISOString()}，只能用一次）：</p><p><a href="${email.link}">${email.link}</a></p>`,
        }),
      });

      if (!response.ok) {
        throw new Error(`邮件服务返回 ${response.status}`);
      }
    },
  };
}

/** 测试用的替身：记录收到的邮件，不真的发。 */
export function createRecordingEmailSender(): EmailSender & {
  sent: MagicLinkEmail[];
} {
  const sent: MagicLinkEmail[] = [];

  return {
    id: "recording",
    exposesLink: true,
    sent,
    async sendMagicLink(email) {
      sent.push(email);
    },
  };
}

let override: EmailSender | null = null;

/** 覆盖默认发送器（测试用）。传 null 恢复默认。 */
export function setEmailSender(sender: EmailSender | null): void {
  override = sender;
}

/**
 * 取当前生效的发送器。
 *
 * 优先级：测试替身 → 环境变量指定的 http 发送器 → 控制台发送器。
 * 没配邮件服务时**降级到控制台发送器**，绝不抛异常。
 */
export function getEmailSender(): EmailSender {
  if (override) {
    return override;
  }

  const httpConfig = httpEmailConfig();
  if (process.env.AUTH_EMAIL_SENDER === "http" && httpConfig) {
    return createHttpEmailSender(httpConfig);
  }

  return consoleEmailSender;
}
