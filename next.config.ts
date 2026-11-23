import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev only: lets a phone/other device on the LAN load the dev server's JS
  // (without this, hydration fails and the login form submits as a plain GET).
  // Override with DEV_ALLOWED_ORIGINS="ip1,ip2" if your LAN IP changes.
  allowedDevOrigins: process.env.DEV_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()) ?? ["192.0.0.2"],
  experimental: {
    serverActions: {
      // The XLSX upload posts the whole file to a Server Action. A
      // 5,000-row export is ~1.3 MB, over the 1 MB default. Kept under
      // Vercel's documented ~4.5 MB function request limit (not verified
      // in this repo).
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
