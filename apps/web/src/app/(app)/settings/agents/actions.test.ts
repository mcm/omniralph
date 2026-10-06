import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  version: null as string | null,
  updatedBy: null as string | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => ({
  setDesiredAgentVersion: async (_db: unknown, version: string | null, updatedBy: string) => {
    state.version = version;
    state.updatedBy = updatedBy;
  },
}));

const { applyLatestAgentVersion, setGlobalAgentVersion } = await import("./actions");

const REGISTRY = "https://registry.npmjs.org/@iamthemcmaster%2fomniralph-agent";
const requests: { authorization: string | null; accept: string | null }[] = [];
let registry: () => Response = () => HttpResponse.json({ "dist-tags": { latest: "1.4.2" } });
const server = setupServer(
  http.get(REGISTRY, ({ request }) => {
    requests.push({
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
    });
    return registry();
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });

describe("Settings › Agents actions", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.version = null;
    state.updatedBy = null;
    requests.length = 0;
    registry = () => HttpResponse.json({ "dist-tags": { latest: "1.4.2" } });
    process.env.NPM_TOKEN = "npm_secret";
  });

  afterEach(() => {
    delete process.env.NPM_TOKEN;
  });

  it("sets the global version, which must be semver", async () => {
    expect(await setGlobalAgentVersion(" 1.4.0 ")).toEqual({ ok: true });
    expect(state).toMatchObject({ version: "1.4.0", updatedBy: "admin-1" });
    expect(await setGlobalAgentVersion("v1.5.0-beta.1")).toEqual({ ok: true });
    expect(state.version).toBe("1.5.0-beta.1");

    for (const bad of ["latest", "1.4", "01.2.3", "1.2.3; rm -rf /"]) {
      expect(await setGlobalAgentVersion(bad)).toEqual({ ok: false, error: expect.any(String) });
    }
    expect(state.version).toBe("1.5.0-beta.1");

    expect(await setGlobalAgentVersion("")).toEqual({ ok: true });
    expect(state.version).toBeNull();
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await setGlobalAgentVersion("1.4.0")).toEqual({ ok: false, error: expect.any(String) });
    expect(await applyLatestAgentVersion()).toEqual({ ok: false, error: expect.any(String) });
    expect(state.version).toBeNull();
    expect(requests).toEqual([]);
  });

  it("uses the latest version on npm, read with NPM_TOKEN", async () => {
    expect(await applyLatestAgentVersion()).toEqual({ ok: true, version: "1.4.2" });
    expect(state.version).toBe("1.4.2");
    expect(requests).toEqual([
      { authorization: "Bearer npm_secret", accept: "application/vnd.npm.install-v1+json" },
    ]);
  });

  it("needs NPM_TOKEN", async () => {
    delete process.env.NPM_TOKEN;
    expect(await applyLatestAgentVersion()).toEqual({
      ok: false,
      error: "Set NPM_TOKEN to read versions from npm.",
    });
    expect(requests).toEqual([]);
  });

  it("reports registry errors and keeps the version", async () => {
    registry = () => HttpResponse.json({ error: "Not found" }, { status: 404 });
    expect(await applyLatestAgentVersion()).toEqual({
      ok: false,
      error: expect.stringContaining(
        "check that NPM_TOKEN can read @iamthemcmaster/omniralph-agent",
      ),
    });
    registry = () => HttpResponse.json({ "dist-tags": { latest: "not-a-version" } });
    expect(await applyLatestAgentVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("didn't list a latest version"),
    });
    registry = () => new HttpResponse("oops", { status: 500 });
    expect(await applyLatestAgentVersion()).toEqual({
      ok: false,
      error: expect.stringContaining("answered 500"),
    });
    expect(state.version).toBeNull();
  });
});
