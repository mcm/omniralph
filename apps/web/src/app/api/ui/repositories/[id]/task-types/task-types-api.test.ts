import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  getRepository,
  organizations,
  repositories,
  saveIntegration,
  setAllowedTaskTypeDefaults,
  upsertScmConnection,
  users,
  workItemMatches,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { captureChanges } from "@omniralph/db/changes";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import {
  ADD_WORK_ITEM_MATCH_FIRST,
  TURN_OFF_CODING_FIRST,
} from "@/lib/repositories/work-item-match";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && {
        ...state.user,
        name: null,
        email: null,
        image: null,
        theme: null,
        showAdvanced: false,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));
vi.mock("@/lib/linear/settings-options", () => ({ getLinearSettingsOptions: async () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const taskTypes = await import("@/app/api/ui/repositories/[id]/task-types/route");
const workItemMatch = await import("@/app/api/ui/repositories/[id]/work-item-match/route");
const coding = await import("@/app/api/ui/repositories/[id]/coding/route");
const repositoryDetail = await import("@/app/api/ui/repositories/[id]/route");

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, method: "GET" | "PUT", id: string, body?: unknown) {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const get = (id: string) => call(taskTypes.GET, "GET", id);
const put = (id: string, body: unknown) => call(taskTypes.PUT, "PUT", id, body);
const putMatch = (id: string, match: unknown) => call(workItemMatch.PUT, "PUT", id, { match });
const putCoding = (id: string, codingEnabled: boolean) =>
  call(coding.PUT, "PUT", id, {
    codingEnabled,
    codingInstructions: null,
    openPullRequestEarly: false,
    historyRewrite: "when-asked",
    respondToReviewsAndCi: true,
  });

const MATCH = { tracker: "linear", team: "ENG", project: null, labels: [] };

/** The repository's change events, as saving its switches records them. */
const switchChanges = (repositoryId: string, sections: string[]) => [
  {
    resource: "repository",
    ids: [repositoryId],
    organizationId: state.orgId,
    at: expect.any(Date),
  },
  ...sections.map((section) => ({
    resource: "settings",
    section,
    ids: [repositoryId],
    subjectId: repositoryId,
    organizationId: state.orgId,
    at: expect.any(Date),
  })),
];

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/api/ui/repositories/{id}/task-types", () => {
  let testDb: TestDatabase;
  let db: Database;
  let repo: string;
  let adminId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    state.orgId = org!.id;
    const [admin] = await db
      .insert(users)
      .values({ id: randomUUID(), email: "admin@acme.test" })
      .returning();
    adminId = admin!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: org!.id,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repo = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    await saveIntegration(db, {
      organizationId: org!.id,
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.user = { id: adminId, role: "admin" };
    await db.delete(workItemMatches);
    await db
      .update(repositories)
      .set({ reviewsEnabled: true, codingEnabled: false, askEnabled: true })
      .where(eq(repositories.id, repo));
  });

  it("answers a new repo's switches: Reviews and Ask on, Coding off, also on the repo detail", async () => {
    expect(await get(repo)).toEqual({
      status: 200,
      body: { reviews: true, coding: false, ask: true },
    });
    expect((await call(repositoryDetail.GET, "GET", repo)).body).toMatchObject({
      taskTypes: { reviews: true, coding: false, ask: true },
    });
  });

  it("saves each switch on or off, answers them and publishes the repo's change", async () => {
    const { result, changes } = await captureChanges(() =>
      put(repo, { reviews: false, coding: false, ask: false }),
    );
    expect(result).toEqual({ status: 200, body: { reviews: false, coding: false, ask: false } });
    expect(changes).toEqual(switchChanges(repo, ["repository.reviews", "repository.coding"]));
    expect(await getRepository(db, repo)).toMatchObject({
      reviewsEnabled: false,
      codingEnabled: false,
      askEnabled: false,
    });
    expect((await get(repo)).body).toEqual({ reviews: false, coding: false, ask: false });

    // The organization's task types don't change them.
    try {
      await setAllowedTaskTypeDefaults(db, state.orgId, ["coding"], null);
      expect((await put(repo, { reviews: true, coding: false, ask: true })).body).toEqual({
        reviews: true,
        coding: false,
        ask: true,
      });
      expect((await get(repo)).body).toEqual({ reviews: true, coding: false, ask: true });
    } finally {
      await setAllowedTaskTypeDefaults(db, state.orgId, null, null);
    }
  });

  it("refuses to turn Coding on without a work item match, saving and publishing nothing", async () => {
    const { result, changes } = await captureChanges(() =>
      put(repo, { reviews: false, coding: true, ask: false }),
    );
    expect(result).toEqual({
      status: 409,
      body: { error: ADD_WORK_ITEM_MATCH_FIRST, code: "work_item_match_required" },
    });
    expect(changes).toEqual([]);
    expect((await get(repo)).body).toEqual({ reviews: true, coding: false, ask: true });

    // The coding policy's switch is refused the same way.
    const viaCoding = await captureChanges(() => putCoding(repo, true));
    expect(viaCoding.result).toEqual({
      status: 409,
      body: { error: ADD_WORK_ITEM_MATCH_FIRST, code: "work_item_match_required" },
    });
    expect(viaCoding.changes).toEqual([]);
    expect((await getRepository(db, repo))?.codingEnabled).toBe(false);
  });

  it("turns Coding on for a repo with a work item match, which then can't be removed", async () => {
    expect((await putMatch(repo, MATCH)).status).toBe(200);
    expect(await put(repo, { reviews: true, coding: true, ask: true })).toEqual({
      status: 200,
      body: { reviews: true, coding: true, ask: true },
    });

    const { result, changes } = await captureChanges(() => putMatch(repo, null));
    expect(result).toEqual({
      status: 409,
      body: { error: TURN_OFF_CODING_FIRST, code: "coding_enabled" },
    });
    expect(changes).toEqual([]);
    expect(await db.select().from(workItemMatches)).toHaveLength(1);

    // Switched off (here through the coding policy), the match can go.
    expect((await putCoding(repo, false)).status).toBe(200);
    expect(await putMatch(repo, null)).toMatchObject({ status: 200 });
    expect(await db.select().from(workItemMatches)).toEqual([]);
    expect((await putCoding(repo, true)).status).toBe(409);

    // With a match again, the coding policy turns it on too.
    expect((await putMatch(repo, MATCH)).status).toBe(200);
    expect(await putCoding(repo, true)).toMatchObject({
      status: 200,
      body: { codingEnabled: true },
    });
  });

  it("keeps Coding on for an existing repo without a match until it's switched off", async () => {
    // As production repos are after the switches stop inheriting.
    await setCodingEnabled(db, repo);
    expect(await put(repo, { reviews: false, coding: true, ask: true })).toEqual({
      status: 200,
      body: { reviews: false, coding: true, ask: true },
    });
    expect((await putCoding(repo, true)).status).toBe(200);
    expect(await get(repo)).toMatchObject({ body: { coding: true } });

    expect((await put(repo, { reviews: true, coding: false, ask: true })).status).toBe(200);
    expect(await put(repo, { reviews: true, coding: true, ask: true })).toMatchObject({
      status: 409,
      body: { error: ADD_WORK_ITEM_MATCH_FIRST },
    });
    expect((await get(repo)).body).toEqual({ reviews: true, coding: false, ask: true });
  });

  it("rejects inherit (null), missing, non-boolean and old keys with 400", async () => {
    for (const body of [
      { reviews: null, coding: false, ask: true },
      { reviews: true, coding: false },
      { reviews: "on", coding: false, ask: true },
      { review: true, coding: false, query: true },
      { reviews: true, coding: false, ask: true, query: true },
    ]) {
      const { result, changes } = await captureChanges(() => put(repo, body));
      expect(result.status).toBe(400);
      expect(changes).toEqual([]);
    }
    expect(await put(repo, { reviews: null, coding: false, ask: "yes" })).toMatchObject({
      status: 400,
      body: { fieldErrors: { reviews: "Choose on or off.", ask: "Choose on or off." } },
    });
    expect((await get(repo)).body).toEqual({ reviews: true, coding: false, ask: true });
  });

  it("refuses members, unknown and other organizations' repos", async () => {
    expect((await put(randomUUID(), { reviews: true, coding: false, ask: true })).status).toBe(400);
    expect((await get(randomUUID())).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);

    state.user = { id: adminId, role: "member" };
    const { result, changes } = await captureChanges(() =>
      put(repo, { reviews: false, coding: false, ask: false }),
    );
    expect(result.status).toBe(403);
    expect(changes).toEqual([]);
    expect((await get(repo)).status).toBe(403);

    state.user = { id: adminId, role: "admin" };
    const orgId = state.orgId;
    try {
      const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
      state.orgId = other!.id;
      expect((await put(repo, { reviews: false, coding: false, ask: false })).status).toBe(400);
      expect((await get(repo)).status).toBe(404);
    } finally {
      state.orgId = orgId;
    }
    expect((await get(repo)).body).toEqual({ reviews: true, coding: false, ask: true });
  });
});
