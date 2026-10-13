import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as DevSignIn from "@/lib/auth/dev-sign-in";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  dbUsed: false,
  users: new Set(["admin@fixtures.example"]),
}));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    state.dbUsed = true;
    return {};
  },
}));
vi.mock("@/lib/auth/dev-sign-in", async (importOriginal) => {
  const actual = await importOriginal<typeof DevSignIn>();
  return {
    ...actual,
    createDevSession: async (_db: unknown, email: string) =>
      state.users.has(email)
        ? { sessionToken: "token-1", expires: new Date("2030-01-01T00:00:00Z") }
        : null,
  };
});

const { GET } = await import("./route");
const { devSignInEnabled } = await import("@/lib/auth/dev-sign-in");

const request = (query: string, origin = "http://localhost:3000") =>
  new NextRequest(`${origin}/sign-in/dev?${query}`);

afterEach(() => {
  vi.unstubAllEnvs();
  state.dbUsed = false;
});

describe("devSignInEnabled", () => {
  it("is on only with OMNIRALPH_DEV_SIGNIN=1 outside production", () => {
    expect(devSignInEnabled({ NODE_ENV: "development", OMNIRALPH_DEV_SIGNIN: "1" })).toBe(true);
    expect(devSignInEnabled({ NODE_ENV: "test", OMNIRALPH_DEV_SIGNIN: "1" })).toBe(true);
  });

  it("is off in production even with the variable set", () => {
    expect(devSignInEnabled({ NODE_ENV: "production", OMNIRALPH_DEV_SIGNIN: "1" })).toBe(false);
  });

  it("is off when the variable is unset or not 1", () => {
    expect(devSignInEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devSignInEnabled({ NODE_ENV: "development", OMNIRALPH_DEV_SIGNIN: "true" })).toBe(false);
  });
});

describe("GET /sign-in/dev", () => {
  it("is absent in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OMNIRALPH_DEV_SIGNIN", "1");
    const response = await GET(request("email=admin@fixtures.example"));
    expect(response.status).toBe(404);
    expect(response.cookies.getAll()).toEqual([]);
    expect(state.dbUsed).toBe(false);
  });

  it("is absent when OMNIRALPH_DEV_SIGNIN is unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OMNIRALPH_DEV_SIGNIN", undefined);
    const response = await GET(request("email=admin@fixtures.example"));
    expect(response.status).toBe(404);
    expect(response.cookies.getAll()).toEqual([]);
    expect(state.dbUsed).toBe(false);
  });

  describe("when enabled", () => {
    const enable = () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("OMNIRALPH_DEV_SIGNIN", "1");
    };

    it("sets the session cookie and redirects to the callback path", async () => {
      enable();
      const response = await GET(
        request("email=admin@fixtures.example&callbackUrl=%2Fcoding%3Fstatus%3Drunning"),
      );
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("http://localhost:3000/coding?status=running");
      const cookie = response.cookies.get("authjs.session-token");
      expect(cookie?.value).toBe("token-1");
      expect(cookie?.httpOnly).toBe(true);
    });

    it("uses the secure cookie over HTTPS", async () => {
      enable();
      const response = await GET(request("email=admin@fixtures.example", "https://panel.test"));
      expect(response.cookies.get("__Secure-authjs.session-token")?.value).toBe("token-1");
    });

    it("never redirects off-site", async () => {
      enable();
      const response = await GET(
        request("email=admin@fixtures.example&callbackUrl=https%3A%2F%2Fevil.test"),
      );
      expect(response.headers.get("location")).toBe("http://localhost:3000/");
    });

    it("rejects a missing or unknown email", async () => {
      enable();
      expect((await GET(request(""))).status).toBe(400);
      const unknown = await GET(request("email=nobody@fixtures.example"));
      expect(unknown.status).toBe(404);
      expect(unknown.cookies.getAll()).toEqual([]);
    });
  });
});
