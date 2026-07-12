import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI视频生成平台",
  description: "AI Video Platform 本地模拟Worker与私有视频存储骨架，不连接真实GPU或支付。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
