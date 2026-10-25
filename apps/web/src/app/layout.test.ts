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
