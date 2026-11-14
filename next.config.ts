import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // The XLSX upload posts the whole file to a Server Action. A
      // 5,000-row export is ~1.3 MB, over the 1 MB default. Kept under
      // Vercel's 4.5 MB request-body cap, which cannot be raised.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
