import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config redirects", () => {
  it("sends the old /ralph and /coding pages to the Runs screen", async () => {
    expect(await nextConfig.redirects?.()).toEqual([
      { source: "/ralph", destination: "/runs", permanent: true },
      { source: "/ralph/:path*", destination: "/runs/:path*", permanent: true },
      { source: "/coding", destination: "/runs", permanent: true },
      { source: "/coding/:path*", destination: "/runs/:path*", permanent: true },
    ]);
  });
});
