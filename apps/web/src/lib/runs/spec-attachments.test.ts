import { randomUUID } from "node:crypto";
import {
  closeDb,
  createDb,
  createFeature,
  createOrganization,
  createRun,
  insertAttachment,
  linkFeatureEpic,
  users,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { MAX_RUN_ATTACHMENTS, RunSpec, type JobToken } from "@omniralph/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Storage from "@/lib/attachments/storage";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ storage: null as Storage.ObjectStorage | null }));
vi.mock("@/lib/attachments/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof Storage>();
  return { ...actual, getObjectStorage: () => state.storage };
});

const { memoryObjectStorage } = await import("@/lib/attachments/storage");
const { RUN_ATTACHMENT_URL_TTL_SECONDS, resolveRunAttachments, RunAttachmentsError } =
  await import("./spec-attachments");
const { resolveRunSpec, RunSpecError } = await import("./resolve");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");

const databaseAvailable = testDatabaseAvailable();
const NOW = new Date("2026-11-05T10:00:00.000Z");

describe.skipIf(!databaseAvailable)("the attachments a run spec lists", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await db.insert(users).values({ id: "planner", name: "Ada" });
    orgId = (await createOrganization(db, { name: "Acme", createdBy: "planner" })).id;
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.storage = memoryObjectStorage();
  });

  /** A tracker run on a new epic. */
  async function epicRun(identifier = "ENG-10") {
    const { run } = await createRun(db, {
      organizationId: orgId,
      trackerIssueId: `issue-${randomUUID()}`,
      trackerIdentifier: identifier,
      trackerSessionId: `session-${randomUUID()}`,
      kind: "children",
      repositoryId: null,
      status: "running",
    });
    return {
      run,
      key: { organizationId: orgId, tracker: "linear" as const, externalId: run.trackerIssueId! },
    };
  }

  async function feature(name: string) {
    const created = await createFeature(db, {
      organizationId: orgId,
      name,
      repositoryId: null,
      createdBy: "planner",
    });
    if (created.status !== "created") throw new Error(created.status);
    return created.feature;
  }

  async function attach(
    owner: Parameters<typeof insertAttachment>[1]["owner"],
    fileName: string,
    contentType = "image/png",
  ) {
    const id = randomUUID();
    return insertAttachment(db, {
      id,
      owner,
      fileName,
      contentType,
      size: 12,
      storageKey: `attachments/${orgId}/${id}`,
      createdBy: "planner",
    });
  }

  it("lists the feature's files, then the epic's, each with a URL that expires soon", async () => {
    const { run, key } = await epicRun();
    const checkout = await feature("Checkout redesign");
    await linkFeatureEpic(db, { featureId: checkout.id, ...key });
    const board = await attach(
      { kind: "feature", organizationId: orgId, featureId: checkout.id },
      "board.pdf",
      "application/pdf",
    );
    const flow = await attach({ kind: "work_item", ...key }, "flow.png");
    // Another epic's and another feature's files stay out.
    const other = await epicRun("ENG-20");
    await attach({ kind: "work_item", ...other.key }, "unrelated.png");
    const elsewhere = await feature("Elsewhere");
    await attach({ kind: "feature", organizationId: orgId, featureId: elsewhere.id }, "other.png");

    const listed = await resolveRunAttachments(db, { ralphRunId: run.id }, { now: NOW });
    const expiresAt = new Date(NOW.getTime() + RUN_ATTACHMENT_URL_TTL_SECONDS * 1000);
    expect(listed).toEqual([
      {
        id: board.id,
        owner: "feature",
        ownerName: "Checkout redesign",
        fileName: "board.pdf",
        contentType: "application/pdf",
        size: 12,
        url: `https://blob.test/${board.storageKey}?expires=${expiresAt.getTime()}`,
        expiresAt: expiresAt.toISOString(),
      },
      {
        id: flow.id,
        owner: "epic",
        ownerName: "ENG-10",
        fileName: "flow.png",
        contentType: "image/png",
        size: 12,
        url: `https://blob.test/${flow.storageKey}?expires=${expiresAt.getTime()}`,
        expiresAt: expiresAt.toISOString(),
      },
    ]);
  });

  it("lists only the epic's files when the epic belongs to no feature", async () => {
    const { run, key } = await epicRun();
    const flow = await attach({ kind: "work_item", ...key }, "flow.png");
    const listed = await resolveRunAttachments(db, { ralphRunId: run.id }, { now: NOW });
    expect(listed.map((a) => [a.id, a.owner])).toEqual([[flow.id, "epic"]]);
  });

  it("lists nothing for a job of no ralph run, and needs no storage then", async () => {
    state.storage = null;
    expect(await resolveRunAttachments(db, { ralphRunId: null })).toEqual([]);
    const { run } = await epicRun();
    expect(await resolveRunAttachments(db, { ralphRunId: run.id })).toEqual([]);
  });

  it("can't list files when storage isn't set up or there are too many", async () => {
    const { run, key } = await epicRun();
    await attach({ kind: "work_item", ...key }, "flow.png");
    state.storage = null;
    await expect(resolveRunAttachments(db, { ralphRunId: run.id })).rejects.toThrow(
      RunAttachmentsError,
    );

    state.storage = memoryObjectStorage();
    for (let i = 0; i < MAX_RUN_ATTACHMENTS; i++) {
      await attach({ kind: "work_item", ...key }, `shot-${i}.png`);
    }
    await expect(resolveRunAttachments(db, { ralphRunId: run.id })).rejects.toThrow(
      `${MAX_RUN_ATTACHMENTS + 1} attachments, more than the ${MAX_RUN_ATTACHMENTS} a run downloads`,
    );
  });

  describe("in the run spec", () => {
    const tokens = (jobId: string): { lifecycle: JobToken; session: JobToken } => ({
      lifecycle: { jobId, token: "lifecycle", expiresIn: 900, kind: "lifecycle" },
      session: { jobId, token: "session", expiresIn: 900, kind: "session" },
    });
    const job = (taskId: string, taskType: Job["taskType"], ralphRunId: string) =>
      ({
        id: randomUUID(),
        organizationId: orgId,
        taskType,
        taskId,
        repositoryId: null,
        ralphRunId,
        payload: { trigger: { kind: "tracker.delegated", context: {} } },
      }) as unknown as Job;

    it("gives a story run on one of the epic's tasks the epic's and feature's files", async () => {
      const { run, key } = await epicRun();
      const checkout = await feature("Checkout");
      await linkFeatureEpic(db, { featureId: checkout.id, ...key });
      await attach({ kind: "feature", organizationId: orgId, featureId: checkout.id }, "board.png");
      await attach({ kind: "work_item", ...key }, "flow.png");
      const story = job("builtin:implement-story", "coding", run.id);
      const spec = await resolveRunSpec(db, story, tokens(story.id), BUILTIN_PLAYBOOK_SOURCE);
      expect(RunSpec.parse(spec).attachments?.map((a) => [a.owner, a.fileName])).toEqual([
        ["feature", "board.png"],
        ["epic", "flow.png"],
      ]);
    });

    it("leaves attachments out of a run on an epic without any", async () => {
      const { run } = await epicRun();
      const story = job("builtin:implement-story", "coding", run.id);
      const spec = await resolveRunSpec(db, story, tokens(story.id), BUILTIN_PLAYBOOK_SOURCE);
      expect(spec).not.toHaveProperty("attachments");
    });

    it("fails the run when its files can never be listed", async () => {
      const { run, key } = await epicRun();
      await attach({ kind: "work_item", ...key }, "flow.png");
      state.storage = null;
      const story = job("builtin:implement-story", "coding", run.id);
      await expect(
        resolveRunSpec(db, story, tokens(story.id), BUILTIN_PLAYBOOK_SOURCE),
      ).rejects.toThrow(RunSpecError);
    });
  });
});
