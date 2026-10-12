import type { Metadata } from "next";
import { CreateCoin } from "@/components/CreateCoin.tsx";

export const metadata: Metadata = { title: "Launch a coin" };

export default function Page() {
  return <CreateCoin />;
}
