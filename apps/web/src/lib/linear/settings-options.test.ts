import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const { disconnectedLinearGateway } = await import("./client");
const { FakeLinearGateway } = await import("./fake-gateway");
const {
  clearLinearSettingsOptionsCache,
  getLinearSettingsOptions,
  LINEAR_SETTINGS_OPTIONS_TTL_MS,
} = await import("./settings-options");

function workspace(): InstanceType<typeof FakeLinearGateway> {
  const linear = new FakeLinearGateway();
  linear.teams = [
    { id: "team-1", key: "ENG", name: "Engineering" },
    { id: "team-2", key: "DES", name: "Design" },
  ];
  linear.labels = [
    { id: "l1", name: "ralph", teamId: null },
    { id: "l2", name: "Backend", teamId: "team-1" },
    { id: "l3", name: "backend", teamId: "team-2" },
    { id: "l4", name: "manual", teamId: "team-2" },
  ];
  linear.projects = [
    { id: "p1", name: "Omniralph" },
    { id: "p2", name: "Cyralph" },
  ];
  return linear;
}

describe("getLinearSettingsOptions", () => {
  let now = 1_000_000;
  beforeEach(() => {
    clearLinearSettingsOptionsCache();
    now = 1_000_000;
  });

  it("returns teams, de-duplicated labels, projects and state names", async () => {
    const linear = workspace();
    linear.getWorkflowStates = async (teamId) =>
      teamId === "team-1"
        ? [
            { id: "a", name: "Todo", type: "unstarted", position: 0 },
            { id: "b", name: "Done", type: "completed", position: 1 },
          ]
        : [
            { id: "c", name: "todo", type: "unstarted", position: 0 },
            { id: "d", name: "Shipped", type: "completed", position: 1 },
          ];

    expect(await getLinearSettingsOptions("org-a", { gateway: async () => linear })).toEqual({
      teams: [
        { key: "DES", name: "Design" },
        { key: "ENG", name: "Engineering" },
      ],
      labels: ["Backend", "manual", "ralph"],
      projects: ["Cyralph", "Omniralph"],
      states: ["Done", "Shipped", "Todo"],
    });
  });

  it("reuses an organization's options for 5 minutes", async () => {
    const linear = workspace();
    const listTeams = vi.spyOn(linear, "listTeams");
    const gateway = vi.fn(async () => linear);
    const deps = { gateway, now: () => now };

    const first = await getLinearSettingsOptions("org-a", deps);
    now += LINEAR_SETTINGS_OPTIONS_TTL_MS - 1;
    expect(await getLinearSettingsOptions("org-a", deps)).toEqual(first);
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(linear.pageRequests.filter((r) => r.method === "listIssueLabels")).toHaveLength(1);

    await getLinearSettingsOptions("org-b", deps);
    expect(gateway).toHaveBeenLastCalledWith("org-b");

    now += 1;
    await getLinearSettingsOptions("org-a", deps);
    expect(listTeams).toHaveBeenCalledTimes(3);
  });

  it("shares one load between concurrent callers", async () => {
    const gateway = vi.fn(async () => workspace());
    await Promise.all([
      getLinearSettingsOptions("org-a", { gateway }),
      getLinearSettingsOptions("org-a", { gateway }),
    ]);
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("returns null when Linear isn't connected, and asks again next time", async () => {
    const gateway = vi.fn(async () => disconnectedLinearGateway());
    expect(await getLinearSettingsOptions("org-a", { gateway })).toBeNull();

    gateway.mockResolvedValueOnce(workspace());
    expect((await getLinearSettingsOptions("org-a", { gateway }))?.projects).toEqual([
      "Cyralph",
      "Omniralph",
    ]);
  });

  it("doesn't cache a failed load", async () => {
    const linear = workspace();
    linear.failures.set("listProjects", new Error("Linear is down"));
    const gateway = async () => linear;
    await expect(getLinearSettingsOptions("org-a", { gateway })).rejects.toThrow("Linear is down");

    linear.failures.clear();
    expect(await getLinearSettingsOptions("org-a", { gateway })).not.toBeNull();
  });
});
