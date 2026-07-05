import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";

import { DevDeployBadge } from "@/components/DevDeployBadge";
import { WarmingBar } from "@/components/WarmingBanner";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata = {
  title: "STEALTHGRAPH — 위협 행위자 지식그래프",
  description:
    "흩어진 식별자를 확률적으로 하나의 실체로 묶는 위협 인텔리전스 조사 콘솔.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className={`${inter.variable} ${mono.variable} dark`}>
      <body className="sg-root">
        <WarmingBar />
        <DevDeployBadge />
        {children}
      </body>
    </html>
  );
}
