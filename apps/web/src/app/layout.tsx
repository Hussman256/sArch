import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell.tsx";
import { AppProvider } from "@/lib/app.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "SARCH: launch a coin on Bitcoin in one step", template: "%s · SARCH" },
  description:
    "Launch a coin for free and trade it on a fair bonding curve priced in bitcoin. Fixed supply, no freeze, liquidity locked at graduation on Arch Swap.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <AppProvider>
          <Shell>{children}</Shell>
        </AppProvider>
      </body>
    </html>
  );
}
