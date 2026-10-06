import { describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requirePageUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@/lib/linear/oauth", () => ({ linearOAuthConfig: () => ({ clientId: "c" }) }));
vi.mock("@omniralph/db", () => ({
  getIntegration: async () => ({
    name: "Acme",
    externalId: "org-1",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  }),
}));
vi.mock("./integrations-view", () => ({ IntegrationsView: () => null }));

const { default: IntegrationsPage } = await import("./page");

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });
const render = (linear?: string) =>
  IntegrationsPage({ searchParams: Promise.resolve(linear ? { linear } : {}) });

describe("Settings › Integrations page", () => {
  it("is for admins only", async () => {
    state.user = null;
    await expect(render()).rejects.toThrow();
    state.user = user("member");
    await expect(render()).rejects.toThrow();
  });

  it("shows the connected workspace and the OAuth outcome to admins", async () => {
    state.user = user("admin");
    const page = await render("connected");
    expect(page.props).toEqual({
      linear: { name: "Acme", workspaceId: "org-1", connectedAt: "2026-10-01T00:00:00.000Z" },
      linearConfigured: true,
      notice: "connected",
    });
    expect((await render("bogus")).props.notice).toBeNull();
  });
});
