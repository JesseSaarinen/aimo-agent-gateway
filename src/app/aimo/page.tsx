import type { Metadata } from "next";
import { AimoView } from "@/components/AimoView";

export const metadata: Metadata = { title: "Valio Aimo's view" };

export default function AimoPage() {
  return <AimoView />;
}
