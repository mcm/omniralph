import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));

const { metadata } = await import("./layout");

describe("root layout metadata", () => {
  it("lists the favicon set", () => {
    expect(metadata.icons).toEqual({
      icon: [
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      ],
      apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
    });
  });
});

describe("root layout stylesheets", () => {
  it("loads @omniralph/ui after the library's styles and before globals.css", () => {
    const source = readFileSync(path.join(__dirname, "layout.tsx"), "utf8");
    const stylesheets = Array.from(source.matchAll(/^import\s+"([^"]+)";$/gm), ([, s]) => s);
    // The first two are the library's styles (legacy-ui-boundary.test.ts names them).
    expect(stylesheets).toHaveLength(5);
    expect(stylesheets.slice(2)).toEqual([
      "@omniralph/ui/fonts.css",
      "@omniralph/ui/styles.css",
      "./globals.css",
    ]);
  });
});
