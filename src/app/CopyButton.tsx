"use client";

import { useCallback, useState } from "react";

type CopyButtonProps = {
  /**
   * 要复制的原文。
   *
   * 由服务端组件直接传进来 —— 页面显示的文本与复制的文本**是同一个字符串**，
   * 所以「复制出来与原文逐字一致」是构造上保证的，不靠两边对齐。
   */
  value: string;
  label?: string;
};

/**
 * 一键复制按钮（游客态可用，不需要注册 —— spec 约束 7）。
 *
 * 优先用 `navigator.clipboard`；非安全上下文（http 且非 localhost）下退回
 * `document.execCommand("copy")`。
 *
 * ⚠️ 放在 `src/app/` 根下而不是某个详情页目录里：Skill 详情页与 MCP 详情页
 *    都要用它（一键复制安装命令 / 一键复制 mcpServers 配置片段）。
 */
export function CopyButton({ value, label = "复制" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = useCallback(async () => {
    setFailed(false);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!ok) {
          throw new Error("execCommand 复制失败");
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  }, [value]);

  return (
    <button type="button" className="copy-button" onClick={copy} aria-live="polite">
      {copied ? "已复制" : failed ? "复制失败，请手动选中" : label}
    </button>
  );
}
