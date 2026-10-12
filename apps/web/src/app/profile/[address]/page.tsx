import type { Metadata } from "next";
import { Profile } from "@/components/Profile.tsx";

export const metadata: Metadata = { title: "Profile" };

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <Profile address={address} />;
}
