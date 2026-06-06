import type { NextConfig } from "next";

const DOWNSTREAM_FILESYSTEM_ORIGIN = process.env.DOWNSTREAM_FILESYSTEM_ORIGIN ?? "http://115.33.108.104:31056";

const nextConfig: NextConfig = {
  transpilePackages: ["@agenthub/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:3001/api/:path*",
      },
      {
        source: "/socket.io/:path*",
        destination: "http://localhost:3001/socket.io/:path*",
      },
      {
        source: "/filesystem/git/:path*",
        destination: `${DOWNSTREAM_FILESYSTEM_ORIGIN}/filesystem/git/:path*`,
      },
    ];
  },
};

export default nextConfig;
