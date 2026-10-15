import type { Metadata } from "next";
import { Suspense } from "react";
import { Home } from "@/components/Home.tsx";

export const metadata: Metadata = { title: "Discover" };

export default function Page() {
  return (
    <Suspense>
      <Home />
    </Suspense>
  );
}
