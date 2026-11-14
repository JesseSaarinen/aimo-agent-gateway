import type { Metadata } from "next";
import { VerifyTool } from "@/components/VerifyTool";

export const metadata: Metadata = { title: "Verify an offer" };

export default function VerifyPage() {
  return <VerifyTool />;
}
