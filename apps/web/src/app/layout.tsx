import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell.tsx";
import { AppProvider } from "@/lib/app.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Archpad: launch and trade coins on Arch", template: "%s · Archpad" },
  description:
    "Launch a coin for free and trade it on a bonding curve priced in bitcoin. Fixed supply, no freeze, liquidity locked at graduation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>
          <Shell>{children}</Shell>
        </AppProvider>
      </body>
    </html>
  );
}
