import type { Metadata } from "next";
import { AgentConsole } from "@/components/AgentConsole";

export const metadata: Metadata = { title: "Ask a real agent" };

export default function AgentPage() {
  return <AgentConsole />;
}
