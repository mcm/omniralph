import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LinearClient from "@/lib/linear/client";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  organizations: [] as string[],
  /** Organizations whose workspace was disconnected meanwhile. */
  disconnected: new Set<string>(),
  gateways: [] as string[],
  passes: [] as Array<[string, string, string]>,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@omniralph/db", () => ({
  listIntegratedOrganizationIds: async () => state.organizations,
}));
vi.mock("@/lib/linear/client", async (importOriginal) => {
  const original = await importOriginal<typeof LinearClient>();
  return {
    ...original,
    getLinearGateway: async ({ organizationId }: { organizationId: string }) => {
      if (state.disconnected.has(organizationId)) throw new original.LinearNotConnectedError();
      state.gateways.push(organizationId);
      return { workspaceOf: organizationId };
    },
  };
});
type Deps = { organizationId: string; linear: { workspaceOf: string } };
const pass = (name: string) => (deps: Deps) => {
  state.passes.push([name, deps.organizationId, deps.linear.workspaceOf]);
};
vi.mock("@/lib/ralph/reconcile", () => ({
  reconcileRuns: async (deps: Deps) => {
    pass("runs")(deps);
    return { reconciled: 2, failed: 1 };
  },
}));
vi.mock("@/lib/ralph/cleanup", () => ({
  reconcileCleanup: async (deps: Deps) => {
    pass("cleanup")(deps);
    return { checked: 1, started: 1, expired: 0, failed: 0 };
  },
}));
vi.mock("@/lib/ralph/ci", () => ({
  reconcileCi: async (deps: Deps) => {
    pass("ci")(deps);
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

  it("does nothing while no organization has Linear connected", async () => {
    expect(await (await cron()).json()).toMatchObject({ organizations: 0, reconciled: 0 });
    expect(state.passes).toEqual([]);
  });
});
