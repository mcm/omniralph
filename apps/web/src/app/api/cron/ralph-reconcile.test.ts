import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LinearClient from "@/lib/tracker/linear/client";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  organizations: [] as string[],
  /** Organizations with chat runs. */
  chatOrganizations: [] as string[],
  /** Organizations whose workspace was disconnected meanwhile. */
  disconnected: new Set<string>(),
  gateways: [] as string[],
  passes: [] as string[][],
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@omniralph/db", () => ({
  listIntegratedOrganizationIds: async () => state.organizations,
  listChatRunOrganizationIds: async () => state.chatOrganizations,
}));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const original = await importOriginal<typeof LinearClient>();
  return {
    ...original,
    getLinearGateway: async ({ organizationId }: { organizationId: string }) => {
      // Only the organizations with Linear connected have a workspace.
      if (state.disconnected.has(organizationId) || !state.organizations.includes(organizationId)) {
        throw new original.LinearNotConnectedError();
      }
      state.gateways.push(organizationId);
      return { workspaceOf: organizationId };
    },
    disconnectedLinearGateway: () => ({ workspaceOf: "disconnected" }),
  };
});
type Deps = { organizationId: string; tracker: { workspaceOf: string } };
const pass = (name: string) => (deps: Deps, origin?: string) => {
  state.passes.push([
    name,
    deps.organizationId,
    deps.tracker.workspaceOf,
    ...(origin ? [origin] : []),
  ]);
};
vi.mock("@/lib/ralph/reconcile", () => ({
  reconcileRuns: async (deps: Deps, _now: Date, origin?: string) => {
    pass("runs")(deps, origin);
    return { reconciled: 2, failed: 1 };
  },
}));
vi.mock("@/lib/ralph/cleanup", () => ({
  reconcileCleanup: async (deps: Deps, _at: Date, origin?: string) => {
    pass("cleanup")(deps, origin);
    return { checked: 1, started: 1, expired: 0, failed: 0 };
  },
}));
vi.mock("@/lib/ralph/ci", () => ({
  reconcileCi: async (deps: Deps, origin?: string) => {
    pass("ci")(deps, origin);
    return { checked: 3, failed: 0 };
  },
}));

process.env.CRON_SECRET = "cron-secret";
const { GET } = await import("./ralph-reconcile/route");

const cron = () =>
  GET(
    new Request("http://localhost/api/cron/ralph-reconcile", {
      headers: { authorization: "Bearer cron-secret" },
    }),
  );

beforeEach(() => {
  state.organizations = [];
  state.chatOrganizations = [];
  state.disconnected.clear();
  state.gateways = [];
  state.passes = [];
});

describe("GET /api/cron/ralph-reconcile", () => {
  it("requires the cron secret", async () => {
    const res = await GET(new Request("http://localhost/api/cron/ralph-reconcile"));
    expect(res.status).toBe(401);
    expect(state.passes).toEqual([]);
  });

  it("reconciles each organization with a Linear workspace, with its own gateway", async () => {
    state.organizations = ["org-a", "org-b", "org-c"];
    state.disconnected.add("org-c");
    const res = await cron();
    expect(await res.json()).toEqual({
      organizations: 2,
      reconciled: 4,
      failed: 2,
      cleanup: { checked: 2, started: 2, expired: 0, failed: 0 },
      ci: { checked: 6, failed: 0 },
      // Without Redis, nothing is due by the schedule.
      due: { reconciled: 0, failed: 0 },
      dueLanes: { checked: 0, started: 0, expired: 0, failed: 0 },
    });
    expect(state.passes).toEqual([
      ["runs", "org-a", "org-a"],
      ["cleanup", "org-a", "org-a"],
      ["ci", "org-a", "org-a"],
      ["runs", "org-b", "org-b"],
      ["cleanup", "org-b", "org-b"],
      ["ci", "org-b", "org-b"],
    ]);
  });

  it("reconciles the chat runs of organizations without Linear, with a disconnected gateway", async () => {
    state.organizations = ["org-a"];
    state.chatOrganizations = ["org-a", "org-chat"];
    expect(await (await cron()).json()).toMatchObject({ organizations: 2, reconciled: 4 });
    expect(state.passes).toEqual([
      ["runs", "org-a", "org-a"],
      ["cleanup", "org-a", "org-a"],
      ["ci", "org-a", "org-a"],
      ["runs", "org-chat", "disconnected", "chat"],
      ["cleanup", "org-chat", "disconnected", "chat"],
      ["ci", "org-chat", "disconnected", "chat"],
    ]);
  });

  it("does nothing while no organization has Linear connected or chat runs", async () => {
    expect(await (await cron()).json()).toMatchObject({ organizations: 0, reconciled: 0 });
    expect(state.passes).toEqual([]);
  });
});
