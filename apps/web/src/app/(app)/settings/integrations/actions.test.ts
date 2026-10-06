import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  integration: null as null | { name: string; credentials: { accessToken: string } },
  deletes: 0,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => ({
  deleteIntegration: async () => {
    state.deletes += 1;
    const removed = state.integration;
    state.integration = null;
    return removed;
  },
}));

const { disconnectLinear } = await import("./actions");

const revoked: string[] = [];
let revokeStatus = 200;
const server = setupServer(
  http.post("https://api.linear.app/oauth/revoke", ({ request }) => {
    revoked.push(request.headers.get("authorization") ?? "");
    return new HttpResponse(null, { status: revokeStatus });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });

describe("disconnectLinear", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.integration = { name: "Acme", credentials: { accessToken: "access-1" } };
    state.deletes = 0;
    revoked.length = 0;
    revokeStatus = 200;
  });

  it("removes the integration and revokes its token", async () => {
    expect(await disconnectLinear()).toEqual({ ok: true });
    expect(state.integration).toBeNull();
    expect(revoked).toEqual(["Bearer access-1"]);
  });

  it("still disconnects, with a warning, when revoking fails", async () => {
    revokeStatus = 500;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await disconnectLinear();
    consoleError.mockRestore();
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("Acme") });
    expect(state.integration).toBeNull();
  });

  it("reports when nothing is connected", async () => {
    state.integration = null;
    expect(await disconnectLinear()).toEqual({
      ok: false,
      error: "No Linear workspace is connected.",
    });
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await disconnectLinear()).toMatchObject({ ok: false });
    expect(state.deletes).toBe(0);
  });
});
