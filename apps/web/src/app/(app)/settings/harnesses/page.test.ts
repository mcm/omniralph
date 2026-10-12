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
  DESIRED_HARNESS_VERSION_KEY: "harness.desiredVersion",
  TRACK_LATEST_HARNESS_VERSION: "latest",
  getAppSetting: async () => ({
    value: state.desired,
    updatedBy: "admin-1",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  }),
  getDesiredHarnessVersion: async () => state.desired,
  listHostTools: async (_db: unknown, organizationId: string) =>
    organizationId === "org-1"
      ? [
          {
            id: "tool-1",
            organizationId,
            name: "semgrep",
            description: "SAST scanner",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]
      : [],
  getLatestHarnessVersionCheck: async () => ({
    version: "1.5.0",
    error: null,
    checkedAt: new Date(Date.now() - 1000),
  }),
}));
vi.mock("./harness-settings-view", () => ({ HarnessSettingsView: () => null }));

const { default: HarnessSettingsPage } = await import("./page");

const user = (role: Role) => ({
  id: `${role}-1`,
  role,
  organization: { id: "org-1", name: "Acme" },
  name: null,
  email: null,
  image: null,
});

describe("Settings › Harnesses page", () => {
  it("is for admins only", async () => {
    state.user = null;
    await expect(HarnessSettingsPage()).rejects.toThrow();
    state.user = user("member");
    await expect(HarnessSettingsPage()).rejects.toThrow();
  });

  it("shows the organization's version", async () => {
    state.user = user("admin");
    expect((await HarnessSettingsPage()).props).toEqual({
      desiredVersion: "1.4.0",
      updatedAt: "2026-10-01T00:00:00.000Z",
      latest: null,
      packageName: "@omniralph/harness",
      hostTools: [{ id: "tool-1", name: "semgrep", description: "SAST scanner" }],
    });
  });

  it("shows the version read from npm when the organization tracks latest", async () => {
    state.user = user("admin");
    state.desired = "latest";
    expect((await HarnessSettingsPage()).props).toMatchObject({
      desiredVersion: "latest",
      latest: { version: "1.5.0", error: null, checkedAt: expect.any(String) },
    });
  });
});
