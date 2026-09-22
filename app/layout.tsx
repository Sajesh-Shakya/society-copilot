import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// design-guidelines.md specifies Inter. --font-sans is what globals.css's
// `@theme inline` block resolves `font-sans` to (see below) — previously
// pointed at itself (`--font-sans: var(--font-sans)`, circular/unresolved),
// so no explicit font was actually being applied despite Geist being loaded.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Society Ops Copilot",
  description: "Society Ops Copilot",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
