import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const { disconnectedTrackerGateway } = await import("./client");
const { FakeTrackerGateway, NO_CAPABILITIES } = await import("@omniralph/tracker/testing");
const { FakeLinearGateway } = await import("@omniralph/tracker/linear/testing");
const {
  clearTrackerSettingsOptionsCache,
  getTrackerSettingsOptions,
  TRACKER_SETTINGS_OPTIONS_TTL_MS,
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
  linear.projectMilestones = [
    { id: "m1", name: "GA", projectName: "Omniralph" },
    { id: "m2", name: "Beta", projectName: "Omniralph" },
    { id: "m3", name: "beta", projectName: "Cyralph" },
  ];
  linear.cycles = [
    { id: "cy3", number: 4, name: null, teamKey: "ENG" },
    { id: "cy2", number: 3, name: "Launch", teamKey: "ENG" },
    { id: "cy1", number: 9, name: null, teamKey: "DES" },
  ];
  linear.users = [
    { id: "u2", name: "Grace" },
    { id: "u1", name: "Ada" },
  ];
  return linear;
}

describe("getTrackerSettingsOptions", () => {
  let now = 1_000_000;
  beforeEach(() => {
    clearTrackerSettingsOptionsCache();
    now = 1_000_000;
  });

  it("returns teams, de-duplicated labels, projects, state and milestone names, cycles and users", async () => {
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

    expect(await getTrackerSettingsOptions("org-a", { gateway: async () => linear })).toEqual({
      teams: [
        { key: "DES", name: "Design" },
        { key: "ENG", name: "Engineering" },
      ],
      labels: ["Backend", "manual", "ralph"],
      projects: ["Cyralph", "Omniralph"],
      states: ["Done", "Shipped", "Todo"],
      projectMilestones: ["Beta", "GA"],
      cycles: [
        { id: "cy1", number: 9, name: null, teamKey: "DES" },
        { id: "cy2", number: 3, name: "Launch", teamKey: "ENG" },
        { id: "cy3", number: 4, name: null, teamKey: "ENG" },
      ],
      users: [
        { id: "u1", name: "Ada" },
        { id: "u2", name: "Grace" },
      ],
    });
  });

  it("reuses an organization's options for 5 minutes", async () => {
    const linear = workspace();
    const listTeams = vi.spyOn(linear, "listTeams");
    const gateway = vi.fn(async () => linear);
    const deps = { gateway, now: () => now };

    const first = await getTrackerSettingsOptions("org-a", deps);
    now += TRACKER_SETTINGS_OPTIONS_TTL_MS - 1;
    expect(await getTrackerSettingsOptions("org-a", deps)).toEqual(first);
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(linear.pageRequests.filter((r) => r.method === "listLabels")).toHaveLength(1);

    await getTrackerSettingsOptions("org-b", deps);
    expect(gateway).toHaveBeenLastCalledWith("org-b");

    now += 1;
    await getTrackerSettingsOptions("org-a", deps);
    expect(listTeams).toHaveBeenCalledTimes(3);
  });

  it("shares one load between concurrent callers", async () => {
    const gateway = vi.fn(async () => workspace());
    await Promise.all([
      getTrackerSettingsOptions("org-a", { gateway }),
      getTrackerSettingsOptions("org-a", { gateway }),
    ]);
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("returns null when no tracker is connected, and asks again next time", async () => {
    const gateway = vi.fn(async () => disconnectedTrackerGateway());
    expect(await getTrackerSettingsOptions("org-a", { gateway })).toBeNull();

    gateway.mockResolvedValueOnce(workspace());
    expect((await getTrackerSettingsOptions("org-a", { gateway }))?.projects).toEqual([
      "Cyralph",
      "Omniralph",
    ]);
  });

  it("doesn't cache a failed load", async () => {
    const linear = workspace();
    linear.failures.set("listProjects", new Error("Linear is down"));
    const gateway = async () => linear;
    await expect(getTrackerSettingsOptions("org-a", { gateway })).rejects.toThrow("Linear is down");

    linear.failures.clear();
    expect(await getTrackerSettingsOptions("org-a", { gateway })).not.toBeNull();
  });

  it("leaves the lists a tracker without Linear's extras doesn't have empty", async () => {
    const tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
    tracker.labels = [{ id: "l1", name: "Backend", teamId: "team-1" }];
    tracker.projects = [{ id: "p1", name: "Omniralph" }];

    expect(await getTrackerSettingsOptions("org-a", { gateway: async () => tracker })).toEqual({
      teams: [{ key: "ENG", name: "Engineering" }],
      labels: ["Backend"],
      projects: ["Omniralph"],
      states: expect.any(Array),
      projectMilestones: [],
      cycles: [],
      users: [],
    });
  });
});
