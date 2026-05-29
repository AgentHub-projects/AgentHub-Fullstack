import type { Metadata } from "next";
import "./globals.css";
import "./workbench/workbench.css";

export const metadata: Metadata = {
  title: "AgentHub Workbench",
  description: "AgentHub multi-agent collaboration platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
