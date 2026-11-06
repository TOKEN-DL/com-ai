import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "com-ai",
  description: "面向中文 AI 开发者的 Agent 资产市场",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
