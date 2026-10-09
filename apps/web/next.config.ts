import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // discord.js (behind the Chat SDK Discord adapter) lazily imports optional
  // native modules (`zlib-sync`, …) the bundler can't resolve; load it from
  // node_modules at runtime instead.
  serverExternalPackages: ["@chat-adapter/discord", "discord.js"],
};

export default nextConfig;
