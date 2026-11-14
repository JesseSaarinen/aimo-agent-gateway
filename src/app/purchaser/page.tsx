import type { Metadata } from "next";
import { PurchaserDesk } from "@/components/PurchaserDesk";

export const metadata: Metadata = { title: "Purchaser's desk" };

export default function PurchaserPage() {
  return <PurchaserDesk />;
}
