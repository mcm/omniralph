import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  addMember,
  closeDb,
  connectRepository,
  createDb,
  createFeature,
  createOrganization,
  featureEpics,
  getJob,
  jobs,
  listRunIterations,
  saveFeatureDocument,
  saveIntegration,
  saveWorkItemMatch,
  setIntegrationFeatureMapping,
  upsertScmConnection,
  users,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import {
  RunSpecJobPayload,
  ShardPlanTriggerContext,
  ShardRound,
  ShardVerifyTriggerContext,
  type QueryRunResult,
  type ShardPlanOutput,
  type ShardVerifyOutput,
} from "@omniralph/shared";
import { TRIAGE_LABEL } from "@omniralph/tracker";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featureShardViewSchema, type FeatureShardView } from "@/lib/api/feature-shards";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/tracker/linear/client";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "shard-admin",
  role: "admin" as "admin" | "member",
  orgId: "",
  linear: undefined as unknown as FakeLinearGateway,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: state.userId,
        role: state.role,
        name: "Steve McMaster",
        email: null,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return { ...actual, getLinearGateway: async () => state.linear };
});
vi.mock("@/lib/dispatch", async () => {
  const { PostgresDispatcher } = await import("@/lib/dispatch/dispatcher");
  return { getDispatcher: () => new PostgresDispatcher({ db: state.db }) };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const shardRoute = await import("./[id]/shard/route");
const draftRoute = await import("./[id]/shard/drafts/[key]/route");
const fileRoute = await import("./[id]/shard/file/route");
const featureRoute = await import("./[id]/route");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");
const { jobHooks } = await import("@/lib/sinks");

const databaseAvailable = testDatabaseAvailable();

/** A Plan with a context, two sections that deliver, success metrics and its expected epics. */
const PLAN = `## Context

Planners split large work by hand.

## Storage

Store features with their documents.

## Review screen

Show each draft beside the sections it covers.

## Success metrics

Fewer epics split by hand.

## Epics

### Storage

- Covers: Storage

### Review

- Covers: Review screen
- After: Storage`;

/** An epic in the epic format. */
const epicBody = (what: string) => `## Problem

Planners need ${what}.

## Scope

### In

- ${what}

### Out

- Anything else

## Requirements

- FR-1: The system must provide ${what}.`;

type Epic = ShardPlanOutput["epics"][number];
const epic = (key: string, covers: string[], dependsOn: string[] = []): Epic => ({
  key,
  title: `Epic ${key}`,
  description: epicBody(`epic ${key}`),
  covers,
  dependsOn,
});

const CONTEXT_EXEMPT = [{ section: "Context", reason: "Why the feature exists; builds nothing." }];

const draft = (epics: Epic[], exempt = CONTEXT_EXEMPT): ShardPlanOutput => ({
  epics,
  exempt,
  summary: "Split by what each delivers.",
});

const answered = (structured: unknown): QueryRunResult => ({
  outcome: "answered",
  answer: null,
  structured: structured as QueryRunResult["structured"],
  references: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
});

const verdict = (overrides: Partial<ShardVerifyOutput> = {}): ShardVerifyOutput => ({
  verdict: "pass",
  uncoveredSections: [],
  inventedScope: [],
  dependencyProblems: [],
  epicNotes: [],
  summary: "Every section is covered and nothing is invented.",
  ...overrides,
});

describe.skipIf(!databaseAvailable)("sharding a feature's plan into reviewed epics", () => {
  let testDb: TestDatabase;
  let db: Database;
  let integrationId: string;
  let repositoryId: string;

  async function call(
    handler: (request: Request, context: { params: Promise<never> }) => Promise<Response>,
    url: string,
    method: string,
    routeParams: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await handler(
      new Request(`http://localhost${url}`, {
        method,
        ...(body !== undefined && {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      }),
      { params: Promise.resolve(routeParams) as Promise<never> },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const view = (body: unknown): FeatureShardView => featureShardViewSchema.parse(body);

  const start = (featureId: string) =>
    call(shardRoute.POST, `/api/ui/features/${featureId}/shard`, "POST", { id: featureId });
  const get = async (featureId: string) =>
    view(
      (await call(shardRoute.GET, `/api/ui/features/${featureId}/shard`, "GET", { id: featureId }))
        .body,
    );
  const patch = (featureId: string, key: string, body: unknown) =>
    call(
      draftRoute.PATCH,
      `/api/ui/features/${featureId}/shard/drafts/${key}`,
      "PATCH",
      {
        id: featureId,
        key,
      },
      body,
    );
  const file = (featureId: string, body: unknown = { repositoryId }) =>
    call(
      fileRoute.POST,
      `/api/ui/features/${featureId}/shard/file`,
      "POST",
      { id: featureId },
      body,
    );

  /** A new feature of the organization with `plan` as its Plan (and a PRFAQ). */
  async function feature(plan = PLAN, name = "Feature planning"): Promise<string> {
    const created = await createFeature(db, {
      organizationId: state.orgId,
      name,
      repositoryId,
      createdBy: state.userId,
    });
    if (created.status !== "created") throw new Error(created.status);
    for (const [kind, body] of [
      ["prfaq", "# Plan big work in Omniralph\n\nPlanners shard plans into epics."],
      ["plan", plan],
    ] as const) {
      await saveFeatureDocument(db, {
        organizationId: state.orgId,
        featureId: created.feature.id,
        kind,
        body,
        baseVersion: 0,
        createdBy: state.userId,
      });
    }
    return created.feature.id;
  }

  /** Finishes `jobId` with `result` through the job lifecycle (its sink, then the loop). */
  async function finish(jobId: string, result: QueryRunResult): Promise<Job> {
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
    const [done] = await db
      .update(jobs)
      .set({ status: "completed", result: result as unknown as Record<string, unknown> })
      .where(eq(jobs.id, jobId))
      .returning();
    const hooks = (await jobHooks(done!, BUILTIN_PLAYBOOK_SOURCE))!;
    expect(hooks.isValidResult!(done!.result)).toBe(true);
    await hooks.onCompleted!(db, done!);
    return done!;
  }

  const iterations = async (featureId: string) => {
    const shard = (await get(featureId)).shard!;
    return listRunIterations(db, { kind: "shard", id: shard.id });
  };

  /** The newest round's worker job and its trigger context. */
  async function worker(featureId: string) {
    const iteration = (await iterations(featureId)).at(-1)!;
    expect(iteration.status).toBe("working");
    const job = (await getJob(db, iteration.workerJobId!))!;
    return {
      job,
      context: ShardPlanTriggerContext.parse(RunSpecJobPayload.parse(job.payload).trigger.context),
    };
  }

  /** The newest round's verifier job and its trigger context. */
  async function verifier(featureId: string) {
    const iteration = (await iterations(featureId)).at(-1)!;
    expect(iteration.status).toBe("verifying");
    const job = (await getJob(db, iteration.verifierJobId!))!;
    return {
      job,
      context: ShardVerifyTriggerContext.parse(
        RunSpecJobPayload.parse(job.payload).trigger.context,
      ),
    };
  }

  /** Runs one round: the worker answers `output`, then the verifier `judgement`. */
  async function round(featureId: string, output: ShardPlanOutput, judgement: ShardVerifyOutput) {
    await finish((await worker(featureId)).job.id, answered(output));
    await finish((await verifier(featureId)).job.id, answered(judgement));
  }

  /** A feature whose two drafts (E1, and E2 after E1) wait for review after one passing round. */
  async function reviewed(): Promise<string> {
    const id = await feature();
    expect((await start(id)).status).toBe(200);
    await round(
      id,
      draft([epic("E1", ["Storage"]), epic("E2", ["Review screen"], ["E1"])]),
      verdict({
        epicNotes: [
          { epic: "E1", note: "Builds the storage." },
          { epic: "E2", note: "Builds the review screen." },
        ],
      }),
    );
    expect((await get(id)).shard!.status).toBe("review");
    return id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db
      .insert(users)
      .values([{ id: "shard-owner" }, { id: state.userId, name: "Steve McMaster" }]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "shard-owner" });
    state.orgId = org.id;
    await addMember(db, { organizationId: org.id, userId: state.userId, role: "admin" });

    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: org.id,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "installation-acme",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    ({ id: repositoryId } = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "acme/planner",
      fullPath: "acme/planner",
    }));
    await saveWorkItemMatch(db, {
      organizationId: org.id,
      repositoryId,
      userId: null,
      match: {
        tracker: "linear",
        team: "ENG",
        project: "Planner",
        withoutProject: false,
        labels: ["planner"],
      },
    });
    await setCodingEnabled(db, repositoryId, true);
    const integration = await saveIntegration(db, {
      organizationId: org.id,
      provider: "linear",
      externalId: "acme-ws",
      name: "acme-ws",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("taken");
    integrationId = integration.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.role = "admin";
    state.linear = new FakeLinearGateway();
    state.linear.projects = [
      { id: "project-planner", name: "Planner" },
    ] as typeof state.linear.projects;
    await setIntegrationFeatureMapping(db, integrationId, "omniralph");
  });

  it("fails a round that leaves a section uncovered, and the next round covers it", async () => {
    const id = await feature();
    const started = await start(id);
    expect(started.status).toBe(200);
    expect(view(started.body).shard).toMatchObject({
      status: "drafting",
      planVersion: 1,
      sections: [{ name: "Context" }, { name: "Storage" }, { name: "Review screen" }],
    });

    const first = await worker(id);
    expect(first.job).toMatchObject({ type: "feature.shard-plan", taskId: "builtin:shard-plan" });
    expect(first.context.shard).toMatchObject({
      feature: "Feature planning",
      sections: "- Context\n- Storage\n- Review screen",
      previousDraft: null,
      revision: null,
    });
    expect(first.context.shard.prfaq).toContain("Plan big work");

    // Round 1 leaves the review screen out: Om's check and the verifier both say so.
    await finish(first.job.id, answered(draft([epic("E1", ["Storage"])])));
    const check = await verifier(id);
    expect(check.job).toMatchObject({
      type: "feature.verify-shard",
      taskId: "builtin:verify-shard",
    });
    expect(check.context.shard.check).toBe(`- No epic covers the Plan's "Review screen" section.`);
    await finish(
      check.job.id,
      answered(
        verdict({
          verdict: "fail",
          uncoveredSections: [{ section: "Review screen", note: "Nothing shows the drafts." }],
          summary: "The review screen is missing.",
        }),
      ),
    );
    const [one] = await iterations(id);
    expect(one).toMatchObject({ number: 1, status: "done", verdict: "continue" });
    expect(ShardRound.parse(one!.details).check.passed).toBe(false);

    // Round 2 gets the draft back with what to fix, and covers it.
    const second = await worker(id);
    expect(second.context.shard.revision).toMatchObject({ round: 2, maxRounds: 3 });
    expect(second.context.shard.revision!.feedback).toContain(
      `No epic covers the Plan's "Review screen" section.`,
    );
    expect(second.context.shard.revision!.feedback).toContain("Nothing shows the drafts.");
    expect(JSON.parse(second.context.shard.previousDraft!).epics).toHaveLength(1);
    await finish(
      second.job.id,
      answered(draft([epic("E1", ["Storage"]), epic("E2", ["Review screen"], ["E1"])])),
    );
    expect((await verifier(id)).context.shard.check).toBeNull();
    await finish(
      (await verifier(id)).job.id,
      answered(verdict({ epicNotes: [{ epic: "E2", note: "Builds the review screen." }] })),
    );

    const done = await get(id);
    expect(done.shard).toMatchObject({
      status: "review",
      leftovers: [],
      rounds: [
        { number: 1, status: "done", passed: false },
        { number: 2, status: "done", passed: true },
      ],
      maxRounds: 3,
    });
    expect(done.shard!.drafts).toMatchObject([
      { key: "E1", covers: ["Storage"], dependsOn: [], decision: "pending", filed: null },
      {
        key: "E2",
        covers: ["Review screen"],
        dependsOn: ["E1"],
        notes: ["Builds the review screen."],
        decision: "pending",
      },
    ]);
    // Nothing is filed before a person reviews the drafts.
    expect(state.linear.created).toEqual([]);
  });

  it("fails invented scope each round and lists what's left at the cap for the person", async () => {
    const id = await feature();
    await start(id);
    const inventing = draft([epic("E1", ["Storage"]), epic("E2", ["Review screen"], ["E1"])]);
    const invented = verdict({
      verdict: "fail",
      inventedScope: [{ epic: "E2", scope: "A billing page the Plan never mentions." }],
      epicNotes: [{ epic: "E2", note: "Drop the billing page." }],
      summary: "E2 invents a billing page.",
    });
    for (let n = 1; n <= 3; n += 1) {
      if (n > 1) {
        expect((await worker(id)).context.shard.revision!.feedback).toContain(
          "Epic E2 adds scope the Plan lacks: A billing page the Plan never mentions.",
        );
      }
      await round(id, inventing, invented);
    }

    const done = (await get(id)).shard!;
    expect(done.status).toBe("review");
    expect(done.rounds.map((r) => r.passed)).toEqual([false, false, false]);
    expect(done.leftovers).toEqual([
      "Epic E2 adds scope the Plan lacks: A billing page the Plan never mentions.",
    ]);
    expect(done.drafts[1]!.notes).toEqual([
      "Drop the billing page.",
      "Adds scope the Plan lacks: A billing page the Plan never mentions.",
    ]);
    expect((await iterations(id)).at(-1)).toMatchObject({ outcome: "max-iterations" });
  });

  it("fails a dependency cycle even when the verifier passes the draft", async () => {
    const id = await feature();
    await start(id);
    await finish(
      (await worker(id)).job.id,
      answered(draft([epic("E1", ["Storage"], ["E2"]), epic("E2", ["Review screen"], ["E1"])])),
    );
    const check = await verifier(id);
    expect(check.context.shard.check).toBe("- The epics' dependencies form a cycle: E1 → E2 → E1.");
    await finish(check.job.id, answered(verdict()));
    expect((await iterations(id))[0]).toMatchObject({ verdict: "continue" });
    expect((await worker(id)).context.shard.revision!.feedback).toContain(
      "The epics' dependencies form a cycle: E1 → E2 → E1.",
    );
  });

  it("refuses to shard a Plan without sections, or a feature being sharded already", async () => {
    const bare = await feature("Just build it all.");
    expect(await start(bare)).toMatchObject({ status: 400, body: { code: "no_sections" } });

    const id = await feature();
    expect((await start(id)).status).toBe(200);
    expect(await start(id)).toMatchObject({ status: 409, body: { code: "shard_active" } });

    state.role = "member";
    expect((await start(await feature())).status).toBe(403);
  });

  it("lets the person edit, remove and approve each draft before filing", async () => {
    const id = await reviewed();

    const edited = await patch(id, "E1", {
      title: "Store features and documents",
      description: epicBody("stored features"),
    });
    expect(edited.status).toBe(200);
    expect(view(edited.body).shard!.drafts[0]).toMatchObject({
      title: "Store features and documents",
      description: epicBody("stored features"),
      edited: true,
      decision: "pending",
    });
    expect(await patch(id, "E1", { title: " " })).toMatchObject({ status: 400 });
    expect(await patch(id, "E9", { decision: "approved" })).toMatchObject({ status: 404 });

    // Every draft must be decided before anything is filed.
    expect((await patch(id, "E2", { decision: "removed" })).status).toBe(200);
    expect(await file(id)).toMatchObject({ status: 409, body: { code: "undecided" } });
    expect((await patch(id, "E2", { decision: "approved" })).status).toBe(200);
    expect((await patch(id, "E1", { decision: "removed" })).status).toBe(200);
    expect(await patch(id, "E2", {})).toMatchObject({ status: 400 });

    state.role = "member";
    expect((await patch(id, "E1", { decision: "approved" })).status).toBe(403);
    expect((await file(id)).status).toBe(403);

    state.role = "admin";
    const decided = (await get(id)).shard!;
    expect(decided.drafts.map((d) => [d.key, d.decision])).toEqual([
      ["E1", "removed"],
      ["E2", "approved"],
    ]);
  });

  it("files the approved drafts with only epic→epic blocks relations, linked to the feature and triaged", async () => {
    const id = await feature();
    await start(id);
    await round(
      id,
      draft([
        epic("E1", ["Storage"]),
        epic("E2", ["Review screen"], ["E1"]),
        epic("E3", ["Review screen"], ["E1", "E2"]),
      ]),
      verdict(),
    );
    await patch(id, "E1", { decision: "approved" });
    await patch(id, "E2", { decision: "removed" });
    await patch(id, "E3", { decision: "approved", title: "Review the drafts" });
    expect(await file(id, { repositoryId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({
      status: 400,
      body: { code: "repository_not_found" },
    });

    const filed = await file(id);
    expect(filed.status).toBe(200);
    const shard = view(filed.body).shard!;
    expect(shard.status).toBe("filed");
    expect(shard.drafts.map((d) => d.filed?.identifier ?? null)).toEqual(["ENG-1", null, "ENG-2"]);

    // The epics, in the repo's team, project and labels, under no parent.
    const linear = state.linear;
    expect(linear.created.map((c) => [c.title, c.projectId, c.labels])).toEqual([
      ["Epic E1", "project-planner", ["planner"]],
      ["Review the drafts", "project-planner", ["planner"]],
    ]);
    const [storage, review] = await Promise.all([
      linear.getIssue("ENG-1"),
      linear.getIssue("ENG-2"),
    ]);
    expect(storage.description).toBe(epicBody("epic E1"));
    expect([storage.parentId, review.parentId]).toEqual([undefined, undefined]);
    // Only epic→epic relations: E3 waits for E1; the removed E2 was never filed.
    expect([...linear.blocks.entries()]).toEqual([[review.id, [storage.id]]]);
    // Each is handed to triage, whose loop gives it its tasks.
    expect(storage.labels).toContain(TRIAGE_LABEL);
    expect(review.labels).toContain(TRIAGE_LABEL);

    const links = await db.select().from(featureEpics).where(eq(featureEpics.featureId, id));
    expect(links.map((l) => l.externalId).toSorted()).toEqual([storage.id, review.id].toSorted());
    const row = await call(featureRoute.GET, `/api/ui/features/${id}`, "GET", { id });
    expect(row.body).toMatchObject({ epicCount: 2 });
    expect((await get(id)).parentIssue).toBeNull();
  });

  it("files the epics under the feature's parent issue with the mapping set to parent-issue", async () => {
    await setIntegrationFeatureMapping(db, integrationId, "parent-issue");
    const id = await reviewed();
    await patch(id, "E1", { decision: "approved" });
    await patch(id, "E2", { decision: "approved" });

    const filed = await file(id);
    expect(filed.status).toBe(200);
    const result = view(filed.body);
    expect(result.featureMapping).toBe("parent-issue");
    expect(result.parentIssue).toMatchObject({ identifier: "ENG-1" });

    const linear = state.linear;
    const parent = await linear.getIssue("ENG-1");
    expect(parent).toMatchObject({ title: "Feature planning", projectId: "project-planner" });
    const epics = await Promise.all([linear.getIssue("ENG-2"), linear.getIssue("ENG-3")]);
    expect(epics.map((e) => e.parentId)).toEqual([parent.id, parent.id]);
    expect([...linear.blocks.entries()]).toEqual([[epics[1].id, [epics[0].id]]]);
    // The parent issue isn't one of the feature's epics, nor triaged.
    const links = await db.select().from(featureEpics).where(eq(featureEpics.featureId, id));
    expect(links.map((l) => l.externalId)).not.toContain(parent.id);
    expect(parent.labels).not.toContain(TRIAGE_LABEL);
  });

  it("keeps what was filed when the tracker fails part way, and files the rest on the next try", async () => {
    const id = await reviewed();
    await patch(id, "E1", { decision: "approved" });
    await patch(id, "E2", { decision: "approved" });
    state.linear.failures.set("addIssueLabels", new Error("Linear is down"));

    const failed = await file(id);
    expect(failed).toMatchObject({ status: 502, body: { code: "filing_failed" } });
    const back = (await get(id)).shard!;
    expect(back.status).toBe("review");
    expect(back.error).toContain("Linear is down");
    expect(back.drafts.map((d) => d.filed?.identifier)).toEqual(["ENG-1", "ENG-2"]);

    state.linear.failures.delete("addIssueLabels");
    const retried = await file(id);
    expect(retried.status).toBe(200);
    expect(view(retried.body).shard).toMatchObject({ status: "filed", error: null });
    // Nothing was filed or related twice.
    expect(state.linear.created).toHaveLength(2);
    const [first, second] = await Promise.all([
      state.linear.getIssue("ENG-1"),
      state.linear.getIssue("ENG-2"),
    ]);
    expect([...state.linear.blocks.entries()]).toEqual([[second.id, [first.id]]]);
  });
});
