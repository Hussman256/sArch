import type { Metadata } from "next";
import { Admin } from "@/components/Admin.tsx";

export const metadata: Metadata = { title: "Admin" };

export default function Page() {
  return <Admin />;
}
