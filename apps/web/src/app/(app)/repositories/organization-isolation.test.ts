// Two organizations, each with a repository, a rule and a review: a member of one never
// sees or changes the other's, and gets a 404 on its URLs.
import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createCustomRule,
  createDb,
  createOrganization,
  createReview,
  findings,
  getRepository,
  getRepositoryReviewSettings,
  getReviewProfile,
  listRepositoryRules,
  runMigrations,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues, RERUN_MODES } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// The signed-in user with their real role in their active organization.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization } = await import("@omniralph/db");
  const current = async (role: Role) => {
    const active = state.userId ? await getActiveOrganization(state.db, state.userId) : null;
    return assertRole(
      state.userId === null
        ? null
        : {
            id: state.userId,
            organization: active ? { id: active.id, name: active.name } : null,
            role: active?.role ?? null,
            name: null,
            email: null,
            image: null,
            theme: null,
          },
      role,
    );
  };
  return {
    requireUser: async (role: Role = "member") => current(role),
    requirePageUser: async (role: Role = "member") => current(role),
  };
});
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
// Views are client components; the tests read the props the pages pass them.
vi.mock("./repositories-view", () => ({ RepositoriesView: () => null }));
vi.mock("./[id]/settings/repository-settings-view", () => ({
  RepositorySettingsView: () => null,
}));
vi.mock("./[id]/rules/rules-view", () => ({ RulesView: () => null }));
vi.mock("./github/[connectionId]/github-repos-view", () => ({ GitHubReposView: () => null }));
vi.mock("./gitlab/[connectionId]/gitlab-projects-view", () => ({
  GitLabProjectsView: () => null,
}));
vi.mock("../reviews/reviews-view", () => ({ ReviewsView: () => null }));
vi.mock("../reviews/[id]/review-detail-view", () => ({ ReviewDetailView: () => null }));
vi.mock("../settings/profiles/profiles-view", () => ({ ProfilesView: () => null }));
vi.mock("@/lib/scm/github-app", () => ({
  getGitHubInstallUrl: async () => null,
  GITHUB_INSTALL_PATH: "/repositories/github/install",
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { default: RepositoriesPage } = await import("./page");
const { default: RepositorySettingsPage } = await import("./[id]/settings/page");
const { default: RepositoryRulesPage } = await import("./[id]/rules/page");
const { default: RepositoryReviewsPage } = await import("./[id]/reviews/page");
const { default: GitHubInstallationPage } = await import("./github/[connectionId]/page");
const { default: GitLabConnectionPage } = await import("./gitlab/[connectionId]/page");
const { default: ReviewsPage } = await import("../reviews/page");
const { default: ReviewPage } = await import("../reviews/[id]/page");
const { default: ProfilesPage } = await import("../settings/profiles/page");
const { setRepositoryEnabled, disconnectRepository } = await import("./actions");
const { updateRalphSettings, updateRepositorySettings } = await import("./[id]/settings/actions");
const { addCustomRule, deleteRule, editRule, setRuleEnabled } =
  await import("./[id]/rules/actions");
const { dismissFinding, restoreFinding } = await import("../reviews/[id]/actions");
const { rerunReview } = await import("../reviews/actions");
const { updateReviewProfile } = await import("../settings/profiles/actions");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

interface Tenant {
  userId: string;
  orgId: string;
  connectionId: string;
  repoId: string;
  ruleId: string;
  reviewId: string;
  findingId: string;
}

/** Next.js `notFound()` throws an error whose digest marks a 404. */
const notFound = { digest: expect.stringContaining("404") };

describe.skipIf(!dockerAvailable)("organization isolation of repositories and reviews", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let a: Tenant;
  let b: Tenant;

  async function tenant(name: string, installationId: string): Promise<Tenant> {
    const [user] = await db
      .insert(users)
      .values({ id: `${name}-admin`, email: `admin@${name}.io` })
      .returning();
    const org = await createOrganization(db, { name, createdBy: user!.id });
    const connection = (await upsertScmConnection(db, {
      organizationId: org.id,
      provider: "github",
      name,
      baseUrl: "https://api.github.com",
      externalId: installationId,
      credentials: {},
    }))!;
    // Both organizations connect the same GitHub repository through their own installation.
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "500",
      fullPath: "shared/app",
    });
    const rule = await createCustomRule(db, {
      repositoryId: repo.id,
      text: `${name} rule`,
      createdBy: user!.id,
    });
    const review = await createReview(db, {
      repositoryId: repo.id,
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
      trigger: "webhook",
      profileId: "standard",
      model: null,
      budget: 1,
    });
    const [finding] = await db
      .insert(findings)
      .values({
        reviewId: review.id,
        path: "a.ts",
        startLine: 1,
        endLine: 1,
        severity: "medium",
        category: "bug",
        title: `${name} finding`,
        body: "x",
        confidence: 0.9,
      })
      .returning();
    return {
      userId: user!.id,
      orgId: org.id,
      connectionId: connection.id,
      repoId: repo.id,
      ruleId: rule.id,
      reviewId: review.id,
      findingId: finding!.id,
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    a = await tenant("alpha", "1");
    b = await tenant("beta", "2");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const noSearch = { searchParams: Promise.resolve({}) };

  it("lists only the active organization's repositories, reviews and profiles", async () => {
    state.userId = a.userId;
    const repos = (await RepositoriesPage(noSearch)).props.repositories as { id: string }[];
    expect(repos.map((r) => r.id)).toEqual([a.repoId]);
    const reviews = (await ReviewsPage(noSearch)).props.reviews as { id: string }[];
    expect(reviews.map((r) => r.id)).toEqual([a.reviewId]);
    const profiles = (await ProfilesPage()).props.profiles as { id: string }[];
    expect(profiles.map((p) => p.id)).toEqual(["quick", "standard", "deep"]);

    const settings = await RepositorySettingsPage(params(a.repoId));
    expect(settings.props.repository.id).toBe(a.repoId);
    const rules = await RepositoryRulesPage(params(a.repoId));
    expect((rules.props.rules as { id: string }[]).map((r) => r.id)).toEqual([a.ruleId]);
    const repoReviews = await RepositoryReviewsPage({ ...params(a.repoId), ...noSearch });
    expect((repoReviews.props.reviews as { id: string }[]).map((r) => r.id)).toEqual([a.reviewId]);
    expect((await ReviewPage(params(a.reviewId))).props.review.id).toBe(a.reviewId);
  });

  it("returns 404 for another organization's repository, review and installation pages", async () => {
    state.userId = a.userId;
    await expect(RepositorySettingsPage(params(b.repoId))).rejects.toMatchObject(notFound);
    await expect(RepositoryRulesPage(params(b.repoId))).rejects.toMatchObject(notFound);
    await expect(RepositoryReviewsPage({ ...params(b.repoId), ...noSearch })).rejects.toMatchObject(
      notFound,
    );
    await expect(ReviewPage(params(b.reviewId))).rejects.toMatchObject(notFound);
    await expect(
      GitHubInstallationPage({ params: Promise.resolve({ connectionId: b.connectionId }) }),
    ).rejects.toMatchObject(notFound);
    await expect(
      GitLabConnectionPage({ params: Promise.resolve({ connectionId: b.connectionId }) }),
    ).rejects.toMatchObject(notFound);
  });

  it("refuses actions on another organization's repositories, rules, findings and reviews", async () => {
    state.userId = a.userId;
    const refused = { ok: false, error: expect.any(String) };
    expect(await setRepositoryEnabled(b.repoId, false)).toEqual(refused);
    expect(await disconnectRepository(b.repoId)).toEqual(refused);
    expect(
      await updateRepositorySettings(b.repoId, {
        profileId: "deep",
        triggers: { onOpen: false, onPush: false, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedHarnessIds: [],
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
      }),
    ).toEqual(refused);
    expect(
      await updateRalphSettings(b.repoId, {
        ralphEnabled: true,
        linearTeamKeys: [],
        linearProjectNames: [],
        linearLabels: [],
        codingPath: "legacy",
        storyTaskId: "builtin:implement-story",
        requestTaskId: "builtin:handle-request",
        ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
      }),
    ).toEqual(refused);
    expect(await getRepository(db, b.repoId)).toMatchObject({
      enabled: true,
      disconnectedAt: null,
      profileId: "standard",
      ralphEnabled: false,
    });

    expect(await addCustomRule(b.repoId, { text: "Sneaky rule" })).toEqual(refused);
    expect(await editRule(b.repoId, b.ruleId, { text: "Edited" })).toEqual(refused);
    expect(await setRuleEnabled(b.repoId, b.ruleId, false)).toEqual(refused);
    expect(await deleteRule(b.repoId, b.ruleId)).toEqual(refused);
    expect((await listRepositoryRules(db, b.repoId)).map((r) => [r.text, r.enabled])).toEqual([
      ["beta rule", true],
    ]);

    expect(await dismissFinding(b.findingId, { reason: "wont_fix" })).toEqual(refused);
    expect(await restoreFinding(b.findingId)).toEqual(refused);
    expect(await rerunReview(b.reviewId, { mode: RERUN_MODES[0], profileId: null })).toEqual({
      ok: false,
      error: "That review doesn't exist.",
    });
  });

  it("edits only the active organization's review profiles", async () => {
    state.userId = a.userId;
    const limits = {
      model: "claude-haiku-5-5",
      maxTokensPerReview: 12_345,
      maxFiles: 3,
      allowRepoExploration: false,
    };
    expect(await updateReviewProfile("deep", limits)).toEqual({ ok: true });
    expect(await getReviewProfile(db, a.orgId, "deep")).toMatchObject({
      maxTokensPerReview: 12_345,
    });
    expect(await getReviewProfile(db, b.orgId, "deep")).toMatchObject({
      maxTokensPerReview: 500_000,
    });

    // Reviews of this organization's repositories use its own copy of the profile.
    expect(
      await updateRepositorySettings(a.repoId, {
        profileId: "deep",
        triggers: { onOpen: true, onPush: true, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedHarnessIds: [],
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
      }),
    ).toEqual({ ok: true });
    expect((await getRepositoryReviewSettings(db, a.repoId))!.profile).toMatchObject({
      organizationId: a.orgId,
      id: "deep",
      maxTokensPerReview: 12_345,
    });
    expect((await getRepository(db, a.repoId))!.profileId).toBe("deep");
  });
});
