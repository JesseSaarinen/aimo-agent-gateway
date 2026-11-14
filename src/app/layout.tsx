import type { Metadata } from "next";
import { Geist_Mono, Schibsted_Grotesk } from "next/font/google";
import { Shell } from "@/components/Shell";
import "./globals.css";

const schibsted = Schibsted_Grotesk({ variable: "--font-schibsted", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Aimo Agent Gateway", template: "%s | Aimo Agent Gateway" },
  description: "Valio Aimo's door for buying agents: any agent can ask, only the buyer's mandate can buy. A Junction 2026 demo.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${schibsted.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
