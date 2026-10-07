import { describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as {
    id: string;
    role: Role;
    organization: { id: string; name: string };
    name: null;
    email: null;
    image: null;
  } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requirePageUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => ({
  DESIRED_AGENT_VERSION_KEY: "agent.desiredVersion",
  getAppSetting: async () => ({
    value: "1.4.0",
    updatedBy: "admin-1",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  }),
}));
vi.mock("./agent-settings-view", () => ({ AgentSettingsView: () => null }));

const { default: AgentSettingsPage } = await import("./page");

const user = (role: Role) => ({
  id: `${role}-1`,
  role,
  organization: { id: "org-1", name: "Acme" },
  name: null,
  email: null,
  image: null,
});

describe("Settings › Agents page", () => {
  it("is for admins only", async () => {
    state.user = null;
    await expect(AgentSettingsPage()).rejects.toThrow();
    state.user = user("member");
    await expect(AgentSettingsPage()).rejects.toThrow();
  });

  it("shows the organization's version", async () => {
    state.user = user("admin");
    expect((await AgentSettingsPage()).props).toEqual({
      desiredVersion: "1.4.0",
      updatedAt: "2026-10-01T00:00:00.000Z",
      packageName: "@omniralph/agent",
    });
  });
});
