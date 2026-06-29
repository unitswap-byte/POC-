// ------------------------------------------------------------------------
// 文件名称：app/layout.tsx
// 文件作用：全站顶级静态布局挂载骨架
// ------------------------------------------------------------------------
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Institutional Web3 Proof Dashboard",
  description: "PoC 回收证明机制外部谈判 DEMO 展示台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="antialiased min-h-screen bg-[#0A192F] text-[#E6F1FF]">{children}</body>
    </html>
  );
}