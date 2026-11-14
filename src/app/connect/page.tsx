import type { Metadata } from "next";
import { ConnectInfo } from "@/components/ConnectInfo";

export const metadata: Metadata = { title: "Connect an agent" };

export default function ConnectPage() {
  return <ConnectInfo />;
}
