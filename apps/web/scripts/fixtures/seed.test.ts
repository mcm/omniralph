import {
  chatRequestDrafts,
  chatWebMessages,
  closeDb,
  createDb,
  decrypt,
  feedback,
  findInboxItem,
  findings,
  agents,
  agentRepoPins,
  getRunIndexEntry,
  inboxItemStates,
  integrations,
  jobs,
  listAttemptTranscript,
  listInboxItems,
  listRoutingRules,
  listRunIndex,
  listWebChats,
  listWebMessages,
  listTriageRuns,
  organizationMembers,
  playbooks,
  ralphRuns,
  ralphStories,
  repositories,
  reviewRuns,
  reviews,
  rules,
  RUN_KINDS,
  RUN_STATUS_MAP,
  scmConnections,
  users,
  WEBHOOK_EVENT_OUTCOMES,
  webhookEvents,
  workItemMatches,
  type Database,
} from "@omniralph/db";
import { createTestDatabase, type TestDatabase } from "@omniralph/db/testing";
import { Playbook, TaskRequirements } from "@omniralph/tasks";
import { TriageRunResult } from "@omniralph/shared";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_ONLINE_WINDOW_MS } from "@/lib/agents/display";
import { storedPlaybookInput } from "@/lib/playbooks";
import { fixtureLinearGateway } from "@/lib/linear/fixture-gateway";
import { linearRoutingRulesSchema } from "@/lib/linear/routing-fields";
import { loadFleet } from "@/lib/fleet/load";
import { loadStoryDiff } from "@/lib/runs/diff";
import { fixtureDiffAdapterFor } from "@/lib/scm/fixture-diff";
import { loadOrganizationBacklog } from "@/lib/work-items/backlog";
import { getWorkItemTracker } from "@/lib/work-items/get-tracker";
import {
  FIXTURE_IDS,
  FIXTURE_INBOX_KEYS,
  FIXTURE_METADATA_NAMES,
  FIXTURE_SANDBOX_LINEAR_TOKEN,
} from "./ids";
import { FIXTURE_ENCRYPTION_KEY, seedFixtures } from "./seed";

vi.mock("server-only", () => ({}));
// The story diff answers through the API's errors, whose module reads the session.
vi.mock("@/lib/auth/session", () => ({}));

/**
 * The names users never see (DESIGN.md's Copy rule), as a Postgres regex over whole words:
 * "Ralph" and "harness".
 */
const OLD_NAMES_PATTERN = `\\m(ralph\\M|harness)`;

/** Tables seeded for the main organization only, counted before and after a reseed. */
const COUNTED_TABLES = [
  "users",
  "organizations",
  "organization_members",
  "repositories",
  "work_item_matches",
  "integrations",
  "agents",
  "ralph_runs",
  "ralph_lanes",
  "ralph_stories",
  "jobs",
  "run_activities",
  "review_runs",
  "reviews",
  "findings",
  "triage_runs",
  "chat_threads",
  "chat_thread_runs",
  "chat_web_messages",
  "chat_request_drafts",
  "inbox_item_states",
  "webhook_events",
];

describe("seedFixtures", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await seedFixtures(db);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const values = <T>(rows: T[], key: keyof T) => new Set(rows.map((r) => r[key]));

  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        COUNTED_TABLES.map(async (table) => {
          const result = await db.execute<{ n: number }>(
            sql`select count(*)::int as n from ${sql.identifier(table)}`,
          );
          return [table, result.rows[0]!.n] as const;
        }),
      ),
    );

  it("replaces the previous seed on a reseed, without duplicates", async () => {
    const before = await counts();
    await seedFixtures(db);
    expect(await counts()).toEqual(before);
    expect(before.jobs).toBeGreaterThan(0);
  });

  it("is re-runnable with the same IDs", async () => {
    await seedFixtures(db);
    const runs = await db.select({ id: ralphRuns.id }).from(ralphRuns);
    expect(new Set(runs.map((r) => r.id))).toEqual(
      new Set([...Object.values(FIXTURE_IDS.ralphRuns), ...Object.values(FIXTURE_IDS.requestRuns)]),
    );
    const [review] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, FIXTURE_IDS.reviews.featured));
    expect(review?.status).toBe("completed");
  });

  it("has web chats for the admin, one with a question and Om's answer", async () => {
    const page = await listWebChats(db, {
      userId: FIXTURE_IDS.users.admin,
      organizationIds: [FIXTURE_IDS.organizations.main],
    });
    expect(new Set(page.chats.map((chat) => chat.id))).toEqual(
      new Set(Object.values(FIXTURE_IDS.askChats)),
    );
    expect(page.chats.find((chat) => chat.id === FIXTURE_IDS.askChats.controlPanel)).toMatchObject({
      repositoryId: FIXTURE_IDS.repositories.controlPanel,
      branch: "main",
    });
    const { messages } = await listWebMessages(db, FIXTURE_IDS.askChats.controlPanel, {
      limit: 100,
    });
    expect(messages.map((message) => message.author)).toEqual(["user", "om"]);
  });

  it("has a web chat whose answer is a drafted Request", async () => {
    const [draft] = await db
      .select()
      .from(chatRequestDrafts)
      .where(eq(chatRequestDrafts.id, FIXTURE_IDS.requestDrafts.pending));
    expect(draft).toMatchObject({ threadId: FIXTURE_IDS.askChats.requestDraft, status: "pending" });
    expect(draft!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const [card] = await db
      .select()
      .from(chatWebMessages)
      .where(
        and(
          eq(chatWebMessages.threadId, FIXTURE_IDS.askChats.requestDraft),
          eq(chatWebMessages.author, "om"),
        ),
      );
    expect(card?.cardRef).toEqual({ kind: "request_draft", draftId: draft!.id });
  });

  it("has an admin and a member in both organizations, with no saved theme", async () => {
    for (const organizationId of Object.values(FIXTURE_IDS.organizations)) {
      const members = await db
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId));
      expect(new Set(members.map((m) => m.userId)), organizationId).toEqual(
        new Set(Object.values(FIXTURE_IDS.users)),
      );
      expect(values(members, "role")).toEqual(new Set(["admin", "member"]));
    }
    const people = await db.select().from(users);
    expect(people.every((u) => u.email?.endsWith("@fixtures.example"))).toBe(true);
    expect(people.every((u) => u.activeOrganizationId === FIXTURE_IDS.organizations.main)).toBe(
      true,
    );
    expect(people.map((u) => u.theme)).toEqual([null, null]);
  });

  const inbox = (organizationId: string, userId: string = FIXTURE_IDS.users.admin) =>
    listInboxItems(db, {
      organizationIds: [organizationId],
      userId,
      onlineWindowMs: AGENT_ONLINE_WINDOW_MS,
    });

  it("has an Inbox item of every needs-you kind and problem the boards show", async () => {
    const items = await inbox(FIXTURE_IDS.organizations.main);
    const I = FIXTURE_IDS.inbox;
    const about = (kind: string) => items.filter((item) => item.facts.kind === kind);
    expect(about("manual_story").map((i) => i.key)).toContain(FIXTURE_INBOX_KEYS.manualStory);
    expect(about("stopped_epic").map((i) => i.run?.id)).toContain(I.stoppedEpic);
    expect(about("prd_ready").map((i) => i.key)).toContain(FIXTURE_INBOX_KEYS.prdReady);
    expect(about("failed_run").map((i) => i.run?.id)).toContain(I.failedRun);
    expect(about("question").map((i) => i.run?.id)).toContain(I.question);
    expect(
      about("agent_offline").map((i) => i.facts.kind === "agent_offline" && i.facts.agent.id),
    ).toContain(I.offlineAgent);
    expect(items.some((item) => item.tab === "running")).toBe(true);

    // A pull request and a merge request waiting on a person, each with its AI review.
    const pullRequests = new Map(about("pr_waiting").map((item) => [item.key, item.facts]));
    expect(pullRequests.get(FIXTURE_INBOX_KEYS.pullRequest)).toMatchObject({
      lane: {
        repositoryId: FIXTURE_IDS.repositories.controlPanel,
        reviewState: "changes_requested",
      },
      review: { runId: FIXTURE_IDS.reviewRuns.pullRequest, status: "completed" },
    });
    expect(pullRequests.get(FIXTURE_INBOX_KEYS.mergeRequest)).toMatchObject({
      lane: { repositoryId: FIXTURE_IDS.repositories.platformApi, reviewState: "approved" },
      review: { runId: FIXTURE_IDS.reviewRuns.mergeRequest, status: "completed" },
    });
    const prFacts = pullRequests.get(FIXTURE_INBOX_KEYS.pullRequest);
    expect(prFacts?.kind === "pr_waiting" && prFacts.review?.openFindings.critical).toBe(1);
  });

  it("has an item both users snoozed: hidden from their Inbox, still found by its key", async () => {
    for (const userId of Object.values(FIXTURE_IDS.users)) {
      const keys = (await inbox(FIXTURE_IDS.organizations.main, userId)).map((i) => i.key);
      expect(keys, userId).not.toContain(FIXTURE_INBOX_KEYS.snoozed);
      const [state] = await db
        .select()
        .from(inboxItemStates)
        .where(
          and(
            eq(inboxItemStates.userId, userId),
            eq(inboxItemStates.itemKey, FIXTURE_INBOX_KEYS.snoozed),
          ),
        );
      expect(state?.state).toBe("snoozed");
      expect(state!.snoozedUntil!.getTime()).toBeGreaterThan(Date.now());
    }
    const item = await findInboxItem(db, {
      organizationIds: [FIXTURE_IDS.organizations.main],
      onlineWindowMs: AGENT_ONLINE_WINDOW_MS,
      key: FIXTURE_INBOX_KEYS.snoozed,
    });
    expect(item?.run?.id).toBe(FIXTURE_IDS.inbox.snoozed);
  });

  const backlog = async (organizationId: string) =>
    loadOrganizationBacklog({
      db,
      organizationId,
      tracker: await getWorkItemTracker({
        db,
        organizationId,
        key: FIXTURE_ENCRYPTION_KEY,
        createGateway: fixtureLinearGateway,
      }),
    });

  it("has Backlog items Ready to start and Needs refining, with a PRD and a repo", async () => {
    const { entries } = await backlog(FIXTURE_IDS.organizations.main);
    const workspace = fixtureLinearGateway();
    for (const group of ["ready", "refine"] as const) {
      const routed = entries.filter((e) => e.row.group === group && e.row.repository);
      const withPrd = routed.filter((e) =>
        [...workspace.issues.values()].some(
          (issue) => issue.identifier === e.row.identifier && issue.description.startsWith("# PRD"),
        ),
      );
      expect(withPrd.length, group).toBeGreaterThan(0);
    }
    expect(entries.find((e) => e.row.identifier === "FIX-101")?.row.size).toBe("M");
  });

  it("has a second organization whose Inbox is empty and whose Backlog isn't (Up next)", async () => {
    for (const userId of Object.values(FIXTURE_IDS.users)) {
      expect(await inbox(FIXTURE_IDS.organizations.sandbox, userId), userId).toEqual([]);
    }
    const { entries } = await backlog(FIXTURE_IDS.organizations.sandbox);
    expect(new Set(entries.map((e) => e.row.group))).toEqual(new Set(["ready", "refine"]));
    expect(entries.every((e) => e.row.identifier.startsWith("SBX-"))).toBe(true);
    expect(
      [...fixtureLinearGateway(FIXTURE_SANDBOX_LINEAR_TOKEN).issues.values()].length,
    ).toBeGreaterThan(0);
  });

  it("has runs of every kind in every status", async () => {
    const { runs } = await listRunIndex(db, {
      organizationIds: [FIXTURE_IDS.organizations.main],
      limit: 1000,
    });
    for (const kind of RUN_KINDS) {
      expect(new Set(runs.filter((r) => r.kind === kind).map((r) => r.status)), kind).toEqual(
        new Set(Object.values(RUN_STATUS_MAP[kind])),
      );
    }
  });

  it("has a story with several attempts, attempts with a transcript and a story diff", async () => {
    const attempts = await db
      .select()
      .from(jobs)
      .where(eq(jobs.ralphStoryId, FIXTURE_IDS.stories.severalAttempts));
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    for (const attempt of Object.values(FIXTURE_IDS.attempts)) {
      const { events } = await listAttemptTranscript(db, attempt);
      expect(events.length, attempt).toBeGreaterThan(0);
    }
    const [running] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, FIXTURE_IDS.attempts.runningWithTranscript));
    expect(running?.status).toBe("running");

    const run = await getRunIndexEntry(db, FIXTURE_IDS.ralphRuns.running);
    const diff = await loadStoryDiff(
      db,
      run!,
      FIXTURE_IDS.stories.severalAttempts,
      fixtureDiffAdapterFor,
    );
    expect(diff.provider).toBe("github");
    expect(diff.files.length).toBeGreaterThan(0);
    expect(diff.url).toMatch(/^https:\/\/github\.com\/fixture-labs\/control-panel\/commit\//);
  });

  it("seeds the names verify:screens looks for as bare metadata", async () => {
    const column = async (query: ReturnType<typeof sql>) =>
      (await db.execute<{ name: string }>(query)).rows.map((row) => row.name);
    expect(await column(sql`select name from organizations`)).toEqual(
      expect.arrayContaining([...FIXTURE_METADATA_NAMES.organizations]),
    );
    expect(await column(sql`select full_path as name from repositories`)).toEqual(
      expect.arrayContaining([...FIXTURE_METADATA_NAMES.repositories]),
    );
    expect(await column(sql`select name from agents`)).toEqual(
      expect.arrayContaining([...FIXTURE_METADATA_NAMES.agents]),
    );
  });

  it("has repos with Reviews, Coding and Ask each on and off", async () => {
    const repos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.organizationId, FIXTURE_IDS.organizations.main));
    for (const key of ["reviewsEnabled", "codingEnabled", "askEnabled"] as const) {
      expect(values(repos, key), key).toEqual(new Set([true, false]));
    }
    const matches = await db.select().from(workItemMatches);
    const matched = new Set(matches.map((m) => m.repositoryId));
    // Coding on needs a work item match.
    expect(repos.filter((r) => r.codingEnabled).every((r) => matched.has(r.id))).toBe(true);
    const docs = repos.find((r) => r.id === FIXTURE_IDS.repositories.docs);
    expect(docs).toMatchObject({ codingEnabled: false });
    expect(matched.has(docs!.id)).toBe(false);
  });

  it("has webhook deliveries with every outcome, and a replay", async () => {
    const rows = await db.select().from(webhookEvents);
    expect(values(rows, "outcome")).toEqual(new Set(WEBHOOK_EVENT_OUTCOMES));
    const github = rows.filter((r) => r.scmConnectionId === FIXTURE_IDS.scmConnections.github);
    expect(values(github, "outcome")).toEqual(new Set(WEBHOOK_EVENT_OUTCOMES));
    expect(rows.find((r) => r.id === FIXTURE_IDS.webhookEvents.replay)?.replayOfId).toBe(
      FIXTURE_IDS.webhookEvents.failed,
    );
  });

  it('says neither "Ralph" nor "harness" anywhere a user could see it', async () => {
    // Every text and JSON column of every table; only job types (never shown) may name the
    // old engine.
    const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type in ('text', 'jsonb', 'ARRAY', 'character varying')
        and not (table_name = 'jobs' and column_name = 'type')`);
    expect(columns.rows.length).toBeGreaterThan(50);
    const found: string[] = [];
    for (const { table_name, column_name } of columns.rows) {
      const result = await db.execute<{ value: string }>(sql`
        select ${sql.identifier(column_name)}::text as value from ${sql.identifier(table_name)}
        where ${sql.identifier(column_name)}::text ~* ${OLD_NAMES_PATTERN}`);
      for (const row of result.rows) found.push(`${table_name}.${column_name}: ${row.value}`);
    }
    // And the work items the fixture Linear workspaces show.
    const pattern = /\b(ralph\b|harness)/i;
    for (const workspace of [
      fixtureLinearGateway(),
      fixtureLinearGateway(FIXTURE_SANDBOX_LINEAR_TOKEN),
    ]) {
      for (const issue of workspace.issues.values()) {
        for (const text of [issue.title, issue.description]) {
          if (pattern.test(text)) found.push(`${issue.identifier}: ${text}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("connects GitHub, GitLab and Linear with fake credentials", async () => {
    const connections = await db.select().from(scmConnections);
    expect(values(connections, "provider")).toEqual(new Set(["github", "gitlab"]));
    const [linear] = await db.select().from(integrations);
    for (const row of [...connections, linear!]) {
      expect(row.externalId).toMatch(/^fixture/);
      const plain = decrypt(row.encryptedCredentials, FIXTURE_ENCRYPTION_KEY);
      for (const secret of Object.values(JSON.parse(plain) as Record<string, string>)) {
        expect(secret).toMatch(/^fixture-.*-not-real$/);
      }
    }
  });

  it("has agents online, offline, outdated and revoked", async () => {
    const rows = await db.select().from(agents);
    const now = Date.now();
    const online = rows.filter(
      (h) => !h.revokedAt && h.lastHeartbeatAt && now - h.lastHeartbeatAt.getTime() < 60_000,
    );
    expect(online.length).toBeGreaterThan(0);
    expect(rows.some((h) => h.lastHeartbeatAt && now - h.lastHeartbeatAt.getTime() > DAY)).toBe(
      true,
    );
    expect(online.some((h) => h.reportedVersion !== "1.8.0")).toBe(true);
    expect(rows.some((h) => h.revokedAt)).toBe(true);
    // Enough for the pinned-agent picker to need its search.
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });

  it("shows Fleet each agent's intended state, so no online agent reads Offline", async () => {
    const H = FIXTURE_IDS.agents;
    const { agents: rows } = await loadFleet(db, [
      { id: FIXTURE_IDS.organizations.main, name: "Fixture Labs", role: "admin" },
    ]);
    const kind = (id: string) => rows.find((row) => row.id === id)?.status.kind;
    expect(kind(H.online)).toBe("running");
    expect(kind(H.outdated)).not.toBe("offline");
    expect(kind(H.updating)).not.toBe("offline");
    expect(kind(H.offline)).toBe("offline");
    expect(kind(H.revoked)).toBe("revoked");
    expect(rows.find((row) => row.id === H.offline)!.status.label).toBe("Offline 3d");
    // Offline is only for agents whose heartbeat is really old.
    for (const row of rows.filter((r) => r.status.kind === "offline")) {
      expect(Date.now() - Date.parse(row.lastHeartbeatAt!)).toBeGreaterThan(AGENT_ONLINE_WINDOW_MS);
    }
  });

  it("pins the control panel to a revoked agent among others", async () => {
    const pins = await db
      .select({ revokedAt: agents.revokedAt })
      .from(agentRepoPins)
      .innerJoin(agents, eq(agents.id, agentRepoPins.agentId))
      .where(eq(agentRepoPins.repositoryId, FIXTURE_IDS.repositories.controlPanel));
    expect(pins.length).toBeGreaterThan(1);
    expect(pins.some((pin) => pin.revokedAt)).toBe(true);
  });

  it("has ralph runs and stories in every state, with attempts, progress and follow-ups", async () => {
    const runs = await db.select().from(ralphRuns);
    expect(values(runs, "status")).toEqual(
      new Set(["pending", "running", "waiting", "completed", "failed", "stopped"]),
    );
    const waiting = runs.find((r) => r.status === "waiting");
    expect(waiting?.waitingOn?.manual.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.progress.includes("Learnings"))).toBe(true);

    const stories = await db.select().from(ralphStories);
    expect(values(stories, "status")).toEqual(
      new Set(["pending", "running", "completed", "blocked", "exhausted", "manual", "canceled"]),
    );
    expect(stories.some((s) => s.attempts > 1)).toBe(true);
    const storyJobs = await db.select().from(jobs).where(eq(jobs.type, "ralph.story"));
    expect(
      storyJobs.some((j) => ((j.result?.followUps as unknown[] | undefined)?.length ?? 0) > 0),
    ).toBe(true);
  });

  it("has reviews with open, dismissed and restored findings, rules and every review depth", async () => {
    expect((await db.select().from(reviewRuns)).length).toBeGreaterThan(0);
    const allFindings = await db.select().from(findings);
    expect(values(allFindings, "status")).toContain("open");
    expect(values(allFindings, "status")).toContain("dismissed");
    const restored = await db.select().from(feedback).where(isNotNull(feedback.restoredAt));
    expect(restored.length).toBeGreaterThan(0);
    const allRules = await db.select().from(rules);
    expect(values(allRules, "kind")).toEqual(new Set(["custom", "learned"]));
    const repos = await db
      .select({ reviewDepth: repositories.reviewDepth })
      .from(repositories)
      .where(eq(repositories.organizationId, FIXTURE_IDS.organizations.main));
    expect(values(repos, "reviewDepth")).toEqual(new Set(["quick", "standard", "deep"]));
  });

  it("routes by valid rules: labels, then project, then team", async () => {
    const saved = await listRoutingRules(db, FIXTURE_IDS.organizations.main);
    expect(saved.map((r) => [r.repositoryId, r.query.rules[0]])).toEqual([
      [FIXTURE_IDS.repositories.controlPanel, expect.objectContaining({ field: "labels" })],
      [FIXTURE_IDS.repositories.agent, expect.objectContaining({ field: "project" })],
      [FIXTURE_IDS.repositories.controlPanel, expect.objectContaining({ field: "team" })],
    ]);
    const parsed = linearRoutingRulesSchema.safeParse({
      rules: saved.map((r) => ({ repositoryId: r.repositoryId, query: r.query })),
    });
    expect(parsed.error).toBeUndefined();
  });

  it("has a custom playbook that resolves like the panel's", async () => {
    const [row] = await db.select().from(playbooks);
    expect(row?.id).toBe(FIXTURE_IDS.playbooks.custom);
    const parsed = Playbook.safeParse(storedPlaybookInput(row!));
    expect(parsed.error).toBeUndefined();
    expect(parsed.data?.role).toBe("review");
    expect(TaskRequirements.safeParse(row!.requirements).success).toBe(true);
  });

  it("has triage runs with their jobs and valid results", async () => {
    const page = await listTriageRuns(db, FIXTURE_IDS.organizations.main);
    expect(new Set(page.runs.map((r) => r.run.id))).toEqual(
      new Set(Object.values(FIXTURE_IDS.triageRuns)),
    );
    for (const { run, jobs: runJobs } of page.runs) {
      expect(runJobs.length, run.id).toBeGreaterThan(0);
      if (run.lastResult) expect(TriageRunResult.safeParse(run.lastResult).success).toBe(true);
    }
  });

  it("has jobs in every state", async () => {
    const rows = await db.select().from(jobs);
    expect(values(rows, "status")).toEqual(
      new Set(["queued", "running", "completed", "failed", "canceled", "expired", "skipped"]),
    );
  });

  it("spreads reviews over the analytics window", async () => {
    const rows = await db.select().from(reviews);
    const days = new Set(
      rows
        .filter((r) => Date.now() - r.createdAt.getTime() < 30 * DAY)
        .map((r) => r.createdAt.toISOString().slice(0, 10)),
    );
    expect(days.size).toBeGreaterThan(15);
    expect(rows.some((r) => r.tokensIn > 0)).toBe(true);
  });
});

const DAY = 24 * 60 * 60 * 1000;
