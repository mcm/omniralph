import { randomBytes } from "node:crypto";
import {
  closeDb,
  createDb,
  DEFAULT_TRACKER_STATE_MAPPING,
  getIntegration,
  integrations,
  organizations,
  saveIntegration,
  setTrackerLabels,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";

vi.mock("server-only", () => ({}));

const { getWorkItemTracker, workItemTrackerFor } = await import("./get-tracker");
const { FixLabelsError, TrackerNotConnectedError } = await import("./tracker");

const databaseAvailable = testDatabaseAvailable();
const key = randomBytes(32);

describe.skipIf(!databaseAvailable)("getWorkItemTracker", () => {
  let testDb: TestDatabase;
  let db: Database;
  let organizationId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    organizationId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(integrations);
  });

  const connect = () =>
    saveIntegration(
      db,
      {
        organizationId,
        provider: "linear",
        externalId: "ws-1",
        name: "Acme",
        credentials: { accessToken: "lin_token" },
        installedByUserId: null,
      },
      key,
    );

  it("throws TrackerNotConnectedError without a Linear connection", async () => {
    await expect(getWorkItemTracker({ db, organizationId })).rejects.toBeInstanceOf(
      TrackerNotConnectedError,
    );
    await expect(getWorkItemTracker({ db, organizationId })).rejects.toThrow(
      /^This organization has no work item tracker connected/,
    );
  });

  it("returns the organization's tracker, loading its gateway on the first call", async () => {
    await connect();
    const fake = new FakeLinearGateway();
    const issue = fake.add({ title: "Ship it", identifier: "ENG-7" });
    let loads = 0;
    const tracker = await getWorkItemTracker({
      db,
      organizationId,
      gateway: async () => {
        loads += 1;
        return fake;
      },
    });
    const integration = await getIntegration(db, organizationId, "linear");
    expect(tracker).toMatchObject({ kind: "linear", integrationId: integration!.id });
    // The credentials are only read on the first call to the tracker.
    expect(loads).toBe(0);
    expect(await tracker.get("ENG-7")).toMatchObject({ id: issue.id, readiness: "ready" });
    await tracker.get(issue.id);
    expect(loads).toBe(1);
    expect(await tracker.getStateMapping()).toEqual(DEFAULT_TRACKER_STATE_MAPPING);

    // Another organization's tracker isn't this one.
    await expect(getWorkItemTracker({ db, organizationId: otherOrgId })).rejects.toBeInstanceOf(
      TrackerNotConnectedError,
    );
  });

  it("saves the state mapping on the integration", async () => {
    await connect();
    const fake = new FakeLinearGateway();
    const tracker = await getWorkItemTracker({
      db,
      organizationId,
      gateway: async () => fake,
    });
    const mapping = {
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-1": { ready: ["state-started"], needsRefining: ["state-unstarted"] } },
    };
    await tracker.setStateMapping(mapping);
    expect((await getIntegration(db, organizationId, "linear"))!.stateMapping).toEqual(mapping);
    const reloaded = await getWorkItemTracker({
      db,
      organizationId,
      gateway: async () => fake,
    });
    expect(await reloaded.getStateMapping()).toEqual(mapping);
  });

  it("makes a work item with the default fix label, Bug, a Fix and others Stories", async () => {
    await connect();
    const fake = new FakeLinearGateway();
    fake.add({ identifier: "ENG-1", title: "Crash", labels: ["Bug"] });
    fake.add({ identifier: "ENG-2", title: "Lowercase", labels: ["bug", "ui"] });
    fake.add({ identifier: "ENG-3", title: "Feature", labels: ["Enhancement"] });
    fake.add({ identifier: "ENG-4", title: "Unlabelled" });
    const tracker = await getWorkItemTracker({ db, organizationId, gateway: async () => fake });
    expect(await tracker.getFixLabels()).toEqual(["Bug"]);
    const kinds = Object.fromEntries(
      (await tracker.findByIdentifiers(["ENG-1", "ENG-2", "ENG-3", "ENG-4"])).map((item) => [
        item.identifier,
        item.kind,
      ]),
    );
    expect(kinds).toEqual({ "ENG-1": "fix", "ENG-2": "fix", "ENG-3": "story", "ENG-4": "story" });
  });

  it("saves custom fix labels on the integration, and kinds follow them everywhere", async () => {
    await connect();
    const fake = new FakeLinearGateway();
    const bug = fake.add({ identifier: "ENG-1", title: "Old label", labels: ["Bug"] });
    const defect = fake.add({ identifier: "ENG-2", title: "New label", labels: ["DEFECT"] });
    const tracker = await getWorkItemTracker({ db, organizationId, gateway: async () => fake });
    expect(await tracker.setFixLabels([" Defect ", "defect", "Regression"])).toEqual([
      "Defect",
      "Regression",
    ]);
    // The writer's own items follow at once.
    expect((await tracker.get(defect.id)).kind).toBe("fix");
    expect((await tracker.get(bug.id)).kind).toBe("story");
    expect((await getIntegration(db, organizationId, "linear"))!.fixLabels).toEqual([
      "Defect",
      "Regression",
    ]);
    // A tracker read later, and one over a webhook's gateway, use the saved labels.
    for (const reloaded of [
      await getWorkItemTracker({ db, organizationId, gateway: async () => fake }),
      await workItemTrackerFor({ db, organizationId, gateway: fake }),
    ]) {
      expect(await reloaded.getFixLabels()).toEqual(["Defect", "Regression"]);
      expect((await reloaded.get(defect.id)).kind).toBe("fix");
      expect((await reloaded.get(bug.id)).kind).toBe("story");
    }
  });

  it("refuses a blank fix label or an empty list, saving nothing", async () => {
    await connect();
    const tracker = await getWorkItemTracker({
      db,
      organizationId,
      gateway: async () => new FakeLinearGateway(),
    });
    await expect(tracker.setFixLabels(["Bug", " "])).rejects.toMatchObject({
      fieldErrors: { "fixLabels.1": "A fix label can't be blank." },
    });
    await expect(tracker.setFixLabels([])).rejects.toBeInstanceOf(FixLabelsError);
    expect((await getIntegration(db, organizationId, "linear"))!.fixLabels).toEqual(["Bug"]);
  });

  it("marks stories manual by the organization's manual labels", async () => {
    await connect();
    await setTrackerLabels(
      db,
      organizationId,
      { manualLabels: ["needs-human"], blockedLabels: [] },
      null,
    );
    const fake = new FakeLinearGateway();
    const parent = fake.add({ title: "Epic" });
    fake.add({ title: "Human", parentId: parent.id, labels: ["Needs-Human"] });
    fake.add({ title: "Default label", parentId: parent.id, labels: ["manual"] });
    const tracker = await getWorkItemTracker({
      db,
      organizationId,
      gateway: async () => fake,
    });
    expect(
      (await tracker.stories(parent.id)).map(({ title, manual }) => ({ title, manual })),
    ).toEqual([
      { title: "Human", manual: true },
      { title: "Default label", manual: false },
    ]);
    await setTrackerLabels(db, organizationId, null, null);
  });

  it("throws TrackerNotConnectedError when the connection was removed since", async () => {
    await connect();
    const tracker = await getWorkItemTracker({ db, organizationId });
    await db.delete(integrations);
    await expect(tracker.get("ENG-1")).rejects.toBeInstanceOf(TrackerNotConnectedError);
    await expect(tracker.setStateMapping(DEFAULT_TRACKER_STATE_MAPPING)).rejects.toBeInstanceOf(
      TrackerNotConnectedError,
    );
  });
});
