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
  desired: "1.4.0",
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requirePageUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@omniralph/db", () => ({
  DESIRED_AGENT_VERSION_KEY: "agent.desiredVersion",
  TRACK_LATEST_AGENT_VERSION: "latest",
  getAppSetting: async () => ({
    value: state.desired,
    updatedBy: "admin-1",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  }),
  getDesiredAgentVersion: async () => state.desired,
  getLatestAgentVersionCheck: async () => ({
    version: "1.5.0",
    error: null,
    checkedAt: new Date(Date.now() - 1000),
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
      latest: null,
      packageName: "@omniralph/agent",
    });
  });

  it("shows the version read from npm when the organization tracks latest", async () => {
    state.user = user("admin");
    state.desired = "latest";
    expect((await AgentSettingsPage()).props).toMatchObject({
      desiredVersion: "latest",
      latest: { version: "1.5.0", error: null, checkedAt: expect.any(String) },
    });
  });
});
