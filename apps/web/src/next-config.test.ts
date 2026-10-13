import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config redirects", () => {
  it("sends the old /ralph pages to /coding", async () => {
    expect(await nextConfig.redirects?.()).toEqual([
      { source: "/ralph", destination: "/coding", permanent: true },
      { source: "/ralph/:path*", destination: "/coding/:path*", permanent: true },
    ]);
  });
});
