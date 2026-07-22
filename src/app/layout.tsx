import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 图像工作台",
  description: "本地优先的 FLUX 图像创建工作台。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><main>{children}</main></body></html>;
}
