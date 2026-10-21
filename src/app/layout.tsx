import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "우연한 식탁 · 좋은 저녁의 시작",
  description: "처음 만나는 사람들과 취향이 닮은 저녁 한 끼.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "우연한 식탁",
    statusBarStyle: "default",
  },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
