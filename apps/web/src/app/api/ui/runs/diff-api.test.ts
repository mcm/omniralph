import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  ensureLane,
  organizations,
  ralphRuns,
  updateStory,
  upsertScmConnection,
  upsertStories,
  type Database,
  type NewTrackerRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { CommitDiff } from "@omniralph/scm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { storyDiffSchema, type StoryDiff } from "@/lib/api/runs";
import { assertRole, type Role } from "@/lib/auth/roles";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  scm: undefined as unknown as FakeScmAdapter,
  /** The connection each `scmAdapterFor` call was for. */
  connections: [] as string[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/scm/adapters", () => ({
  scmAdapterFor: (_db: Database, connection: { id: string }) => {
    state.connections.push(connection.id);
    return state.scm.asAdapter();
  },
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const diffRoute = await import("@/app/api/ui/runs/[id]/steps/[stepId]/diff/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };
const SHA = "c0ffee".padEnd(40, "0");

/** `GET /api/ui/runs/{id}/steps/{stepId}/diff`. */
async function diffRequest(id: string, stepId: string) {
  const response = await diffRoute.GET(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({ id, stepId }),
  });
  return {
    status: response.status,
    body: (await response.json()) as StoryDiff & { error?: string },
  };
}

function commitDiff(fullPath: string, sha = SHA): CommitDiff {
  return {
    sha,
    url: `https://code.example.com/${fullPath}/commit/${sha}`,
    files: [
      {
        path: "src/importer.ts",
        previousPath: null,
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export const importer = true;",
        truncated: false,
      },
    ],
    truncated: false,
  };
}

describe.skipIf(!databaseAvailable)("GET /api/ui/runs/{id}/steps/{stepId}/diff", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let gitlabId: string;
  let githubId: string;
  let api: string;
  let web: string;
  let otherRepo: string;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Globex" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    const gitlab = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: {},
    }))!;
    const github = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "app",
      baseUrl: "https://api.github.com",
      externalId: "6",
      credentials: {},
    }))!;
    gitlabId = gitlab.id;
    githubId = github.id;
    api = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    web = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    const otherConnection = (await upsertScmConnection(db, {
      organizationId: otherOrgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "7",
      credentials: {},
    }))!;
    otherRepo = (
      await connectRepository(db, {
        connectionId: otherConnection.id,
        provider: "gitlab",
        externalId: "3",
        fullPath: "globex/api",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(ralphRuns);
    state.user = member;
    state.orgId = orgId;
    state.scm = new FakeScmAdapter("gitlab");
    state.connections = [];
  });

  async function newRun(overrides: Partial<NewTrackerRalphRunInput> = {}) {
    session += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      trackerIssueId: `issue-${session}`,
      trackerIdentifier: `ENG-${session}`,
      trackerTitle: `Epic ${session}`,
      trackerUrl: null,
      trackerSessionId: `session-${session}`,
      kind: "children",
      repositoryId: api,
      branch: `eng-${session}`,
      baseBranch: "main",
      ...overrides,
    });
    return run;
  }

  async function story(runId: string, commitSha: string | null, laneId?: string) {
    const [created] = await upsertStories(db, runId, [
      { trackerIssueId: `s-${runId}`, identifier: "ENG-41", title: "Build the importer", laneId },
    ]);
    if (commitSha) await updateStory(db, created!.id, { commitSha });
    return created!;
  }

  it("returns the diff of a story's commit in the run's repository", async () => {
    const run = await newRun();
    const built = await story(run.id, SHA);
    state.scm.commitDiffs.set(`acme/api@${SHA}`, commitDiff("acme/api"));

    const { status, body } = await diffRequest(run.id, built.id);
    expect(status).toBe(200);
    expect(storyDiffSchema.parse(body)).toEqual({ ...commitDiff("acme/api"), provider: "gitlab" });
    expect(state.connections).toEqual([gitlabId]);
    expect(state.scm.commitDiffCalls).toEqual([
      { repo: { fullPath: "acme/api", externalId: "1" }, sha: SHA, options: { maxFiles: 100 } },
    ]);
  });

  it("reads a story of another lane in that lane's repository", async () => {
    const run = await newRun();
    const lane = await ensureLane(db, {
      runId: run.id,
      repositoryId: web,
      branch: "eng-web",
      baseBranch: "main",
    });
    const built = await story(run.id, SHA, lane.id);
    state.scm.commitDiffs.set(`acme/web@${SHA}`, commitDiff("acme/web"));

    const { status, body } = await diffRequest(run.id, built.id);
    expect(status).toBe(200);
    expect(body).toMatchObject({ provider: "github", url: commitDiff("acme/web").url });
    expect(state.connections).toEqual([githubId]);
  });

  it("answers 409 when the code host doesn't have the commit yet", async () => {
    const run = await newRun();
    const built = await story(run.id, SHA);
    expect(await diffRequest(run.id, built.id)).toEqual({
      status: 409,
      body: expect.objectContaining({ error: "This commit isn't on GitLab yet." }),
    });

    const lane = await ensureLane(db, {
      runId: run.id,
      repositoryId: web,
      branch: "eng-web",
      baseBranch: "main",
    });
    const onGitHub = (
      await upsertStories(db, run.id, [
        { trackerIssueId: "s-web", identifier: "ENG-42", title: "Web", laneId: lane.id },
      ])
    ).find((s) => s.identifier === "ENG-42");
    await updateStory(db, onGitHub!.id, { commitSha: SHA });
    expect(await diffRequest(run.id, onGitHub!.id)).toMatchObject({
      status: 409,
      body: { error: "This commit isn't on GitHub yet." },
    });
  });

  it("404s on a story without a commit, a step of no story and a request run", async () => {
    const run = await newRun();
    const unbuilt = await story(run.id, null);
    expect(await diffRequest(run.id, unbuilt.id)).toMatchObject({
      status: 404,
      body: { error: "That story has no commit." },
    });
    for (const stepId of ["not-a-step", crypto.randomUUID()]) {
      expect(await diffRequest(run.id, stepId)).toMatchObject({ status: 404 });
    }
    const request = await newRun({ mode: "request", kind: "single" });
    expect(await diffRequest(request.id, unbuilt.id)).toMatchObject({ status: 404 });
    expect(state.scm.commitDiffCalls).toEqual([]);
  });

  it("404s on a run outside the user's memberships and on unknown runs", async () => {
    const other = await newRun({ organizationId: otherOrgId, repositoryId: otherRepo });
    const built = await story(other.id, SHA);
    state.scm.commitDiffs.set(`globex/api@${SHA}`, commitDiff("globex/api"));
    for (const id of [other.id, crypto.randomUUID(), "not-a-uuid"]) {
      expect(await diffRequest(id, built.id)).toMatchObject({
        status: 404,
        body: { error: "That run doesn't exist." },
      });
    }
    expect(state.scm.commitDiffCalls).toEqual([]);
  });
});
