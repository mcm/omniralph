import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // discord.js (behind the Chat SDK Discord adapter) lazily imports optional
  // native modules (`zlib-sync`, …) the bundler can't resolve; load it from
  // node_modules at runtime instead.
  serverExternalPackages: ["@chat-adapter/discord", "discord.js"],
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
