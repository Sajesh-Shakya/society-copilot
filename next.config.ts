import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
