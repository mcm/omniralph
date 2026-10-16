import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // discord.js (behind the Chat SDK Discord adapter) lazily imports optional
  // native modules (`zlib-sync`, …) the bundler can't resolve; load it from
  // node_modules at runtime instead.
  serverExternalPackages: ["@chat-adapter/discord", "discord.js"],
  // Extra hosts `next dev` serves its dev resources to, e.g. `host.docker.internal` when
  // `verify:screens` or `e2e` runs on Docker Desktop (scripts/browser/environment.ts).
  allowedDevOrigins: process.env.OMNIRALPH_ALLOWED_DEV_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Coding tasks moved from `/ralph` to `/coding`; old links (bookmarks, chat
  // and Linear messages) keep working. The query string is passed along.
  async redirects() {
    return [
      { source: "/ralph", destination: "/coding", permanent: true },
      { source: "/ralph/:path*", destination: "/coding/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
