/**
 * The fixture organization: realistic, entirely fake data for rendering every
 * signed-in screen of the control panel (`pnpm --filter @omniralph/web fixtures:up`).
 * No real secrets, tokens or people: emails are `@fixtures.example`, hosts are
 * `*.fixtures.example`, external IDs start with `fixture`.
 *
 * Timestamps are relative to `now`, so analytics windows are never empty; reseed
 * to refresh them. Seeding replaces the previous fixture rows (by their fixed IDs).
 */
import {
  appSettings,
  DEFAULT_RALPH_SETTINGS,
  DESIRED_HARNESS_VERSION_KEY,
  encrypt,
  feedback,
  findings,
  harnessAudit,
  harnesses,
  harnessHostTools,
  harnessRepoPins,
  hostTools,
  integrations,
  jobs,
  organizationEmailDomains,
  organizationInvitations,
  organizationMembers,
  organizations,
  playbooks,
  ralphLanes,
  ralphMessages,
  ralphRuns,
  ralphStories,
  repositories,
  routingRules,
  reviewRuns,
  reviews,
  rules,
  scmConnections,
  runActivities,
  triageRuns,
  users,
  type Database,
} from "@omniralph/db";
import { getBuiltinPlaybook, playbookRequirements } from "@omniralph/tasks";
import { REVIEW_DEPTHS, type ReviewDepth } from "@omniralph/shared";
import { inArray, sql } from "drizzle-orm";
import { FIXTURE_EMAILS, FIXTURE_IDS, fixtureId } from "./ids";

/** Fake, fixed `ENCRYPTION_KEY` the fixture credentials are encrypted with (hex of "fixture…"). */
export const FIXTURE_ENCRYPTION_KEY = Buffer.from("fixture-key-not-a-secret-32bytes").toString(
  "hex",
);
/** Fake, fixed `AUTH_SECRET` for running the panel against the fixtures. */
export const FIXTURE_AUTH_SECRET = "fixture-auth-secret-not-a-secret";

/** The harness version the organization wants (a concrete version: no npm lookup). */
export const FIXTURE_DESIRED_VERSION = "1.8.0";

/**
 * Heartbeat of the online harnesses. Far in the future so they stay online
 * (heartbeat under a minute old) however long after seeding the panel renders.
 */
const ONLINE_HEARTBEAT = new Date("2099-01-01T00:00:00Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const { users: U, organizations: O, repositories: R, harnesses: H, ralphRuns: RR } = FIXTURE_IDS;

/** A fake 40-character commit SHA derived from `n`. */
function sha(n: number): string {
  return (n * 2654435761).toString(16).padStart(8, "0").repeat(5).slice(0, 40);
}

/** Seeds the fixture organizations into `db`, replacing an earlier seed. */
export async function seedFixtures(db: Database, now = new Date()): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const key = FIXTURE_ENCRYPTION_KEY;

  await db.transaction(async (tx) => {
    await clearFixtures(tx);

    // ── People and organizations ─────────────────────────────────────────
    await tx.insert(users).values([
      {
        id: U.admin,
        name: "Ada Admin",
        email: FIXTURE_EMAILS.admin,
        emailVerified: ago(90 * DAY),
        createdAt: ago(90 * DAY),
      },
      {
        id: U.member,
        name: "Max Member",
        email: FIXTURE_EMAILS.member,
        emailVerified: ago(60 * DAY),
        createdAt: ago(60 * DAY),
      },
    ]);
    await tx.insert(organizations).values([
      { id: O.main, name: "Fixture Labs", createdBy: U.admin, createdAt: ago(90 * DAY) },
      { id: O.sandbox, name: "Fixture Sandbox", createdBy: U.admin, createdAt: ago(30 * DAY) },
    ]);
    await tx.insert(organizationMembers).values([
      { organizationId: O.main, userId: U.admin, role: "admin", createdAt: ago(90 * DAY) },
      { organizationId: O.main, userId: U.member, role: "member", createdAt: ago(60 * DAY) },
      { organizationId: O.sandbox, userId: U.admin, role: "admin", createdAt: ago(30 * DAY) },
    ]);
    await tx
      .update(users)
      .set({ activeOrganizationId: O.main })
      .where(inArray(users.id, [U.admin, U.member]));
    await tx
      .insert(organizationEmailDomains)
      .values({ organizationId: O.main, domain: "fixtures.example" });
    await tx.insert(organizationInvitations).values({
      id: fixtureId("invitation", 1),
      organizationId: O.main,
      email: "invitee@fixtures.example",
      role: "member",
      invitedBy: U.admin,
      expiresAt: new Date(now.getTime() + 6 * DAY),
      createdAt: ago(DAY),
    });
    // A custom playbook (built-ins can't be edited), cloned from the built-in review playbook.
    const { id: _id, name: _name, role, ...reviewPr } = getBuiltinPlaybook("builtin:review-pr")!;
    await tx.insert(playbooks).values({
      id: FIXTURE_IDS.playbooks.custom,
      organizationId: O.main,
      name: "Strict review",
      role,
      definition: reviewPr,
      requirements: {
        ...playbookRequirements({
          ...reviewPr,
          id: FIXTURE_IDS.playbooks.custom,
          name: "Strict review",
          role,
        }),
      },
      createdBy: U.admin,
      updatedBy: U.admin,
    });
    await tx.insert(appSettings).values({
      organizationId: O.main,
      key: DESIRED_HARNESS_VERSION_KEY,
      value: FIXTURE_DESIRED_VERSION,
      updatedBy: U.admin,
    });

    // ── Code hosts, repositories, Linear ─────────────────────────────────
    await tx.insert(scmConnections).values([
      {
        id: FIXTURE_IDS.scmConnections.github,
        organizationId: O.main,
        provider: "github",
        name: "fixture-labs",
        baseUrl: "https://api.github.com",
        externalId: "fixture-installation-1",
        encryptedCredentials: encrypt("{}", key),
        createdBy: U.admin,
        createdAt: ago(80 * DAY),
      },
      {
        id: FIXTURE_IDS.scmConnections.gitlab,
        organizationId: O.main,
        provider: "gitlab",
        name: "Fixture GitLab",
        baseUrl: "https://gitlab.fixtures.example",
        externalId: "fixture-labs",
        encryptedCredentials: encrypt(
          JSON.stringify({
            token: "fixture-gitlab-token-not-real",
            webhookSecret: "fixture-webhook-secret-not-real",
          }),
          key,
        ),
        botUsername: "fixture-bot",
        health: {
          checkedAt: ago(5 * HOUR).toISOString(),
          tokenExpiresAt: new Date(now.getTime() + 12 * DAY).toISOString().slice(0, 10),
          problems: [
            {
              code: "token_expiring",
              message: "The bot token expires in 12 days. Rotate it before then.",
            },
          ],
        },
        createdBy: U.admin,
        createdAt: ago(70 * DAY),
      },
    ]);
    const githubRepo = (fullPath: string, n: number) => ({
      organizationId: O.main,
      provider: "github" as const,
      externalId: `fixture-repo-${n}`,
      fullPath,
      connectionId: FIXTURE_IDS.scmConnections.github,
      createdAt: ago((80 - n) * DAY),
    });
    await tx.insert(repositories).values([
      {
        ...githubRepo("fixture-labs/control-panel", 1),
        id: R.controlPanel,
        reviewDepth: "standard",
        ralphEnabled: true,
        pathExcludes: ["**/*.snap", "pnpm-lock.yaml"],
        customInstructions: "Prefer server components; flag any client-side secret.",
        ralphSettings: {
          ...DEFAULT_RALPH_SETTINGS,
          verifyCommands: ["pnpm typecheck", "pnpm lint", "pnpm test"],
          setupCommand: "pnpm install --frozen-lockfile",
        },
      },
      {
        ...githubRepo("fixture-labs/harness", 2),
        id: R.harness,
        reviewDepth: "deep",
        ralphEnabled: true,
        triggers: { onOpen: true, onPush: false, drafts: false },
      },
      {
        id: R.platformApi,
        organizationId: O.main,
        provider: "gitlab",
        externalId: "fixture-project-301",
        fullPath: "fixture-labs/platform/api",
        connectionId: FIXTURE_IDS.scmConnections.gitlab,
        reviewDepth: "quick",
        webhookId: "fixture-hook-301",
        createdAt: ago(60 * DAY),
      },
      { ...githubRepo("fixture-labs/docs", 4), id: R.docs, enabled: false },
      {
        ...githubRepo("fixture-labs/legacy-dashboard", 5),
        id: R.legacy,
        enabled: false,
        disconnectedAt: ago(20 * DAY),
      },
    ]);
    // Settings › Routing: labels, then project, then team. "legacy-api" isn't in the fixture
    // Linear workspace: the Routing page shows it as stale.
    await tx.insert(routingRules).values([
      {
        organizationId: O.main,
        position: 0,
        repositoryId: R.controlPanel,
        query: {
          combinator: "and",
          rules: [{ field: "labels", operator: "containsAny", value: ["backend", "legacy-api"] }],
        },
      },
      {
        organizationId: O.main,
        position: 1,
        repositoryId: R.harness,
        query: {
          combinator: "and",
          rules: [{ field: "project", operator: "=", value: "Harness" }],
        },
      },
      {
        organizationId: O.main,
        position: 2,
        repositoryId: R.controlPanel,
        query: { combinator: "and", rules: [{ field: "team", operator: "=", value: "FIX" }] },
      },
    ]);
    await tx.insert(integrations).values({
      id: FIXTURE_IDS.integrations.linear,
      organizationId: O.main,
      provider: "linear",
      externalId: "fixture-linear-workspace",
      name: "Fixture Labs",
      encryptedCredentials: encrypt(
        JSON.stringify({ accessToken: "fixture-linear-token-not-real" }),
        key,
      ),
      installedByUserId: U.admin,
      createdAt: ago(75 * DAY),
    });

    // ── Harnesses ─────────────────────────────────────────────────────────
    const allTypes = ["query", "review", "coding"];
    const installables = [{ name: "@omniralph/code-graph", version: "0.4.1" }];
    const models = [
      { value: "default", displayName: "Default (recommended)" },
      { value: "opus", displayName: "Opus" },
      { value: "sonnet", displayName: "Sonnet" },
      { value: "haiku", displayName: "Haiku" },
    ];
    await tx.insert(harnesses).values([
      {
        id: H.online,
        organizationId: O.main,
        name: "build-01",
        maxConcurrency: 4,
        acceptedTaskTypes: allTypes,
        poolLimits: { long: 2 },
        reportedVersion: FIXTURE_DESIRED_VERSION,
        reportedInstallables: installables,
        reportedModels: models,
        selfUpdate: "supported",
        updateState: {
          state: "idle",
          version: null,
          previous: "1.7.0",
          startsSincePending: 0,
          error: null,
        },
        lastHeartbeatAt: ONLINE_HEARTBEAT,
        enrolledBy: U.admin,
        createdAt: ago(60 * DAY),
      },
      {
        id: H.offline,
        organizationId: O.main,
        name: "build-02",
        maxConcurrency: 2,
        acceptedTaskTypes: ["query", "review"],
        reportedVersion: FIXTURE_DESIRED_VERSION,
        selfUpdate: "supported",
        lastHeartbeatAt: ago(3 * DAY + 4 * HOUR),
        enrolledBy: U.admin,
        createdAt: ago(50 * DAY),
      },
      {
        id: H.outdated,
        organizationId: O.main,
        name: "ada-laptop",
        maxConcurrency: 1,
        acceptedTaskTypes: allTypes,
        reportedVersion: "1.6.2",
        selfUpdate: "unsupported",
        lastHeartbeatAt: ONLINE_HEARTBEAT,
        enrolledBy: U.admin,
        createdAt: ago(40 * DAY),
      },
      {
        id: H.updating,
        organizationId: O.main,
        name: "build-03",
        maxConcurrency: 2,
        acceptedTaskTypes: allTypes,
        reportedVersion: "1.7.0",
        selfUpdate: "supported",
        updateState: {
          state: "installing",
          version: FIXTURE_DESIRED_VERSION,
          previous: "1.7.0",
          startsSincePending: 0,
          error: null,
        },
        failedVersions: ["1.7.1"],
        lastHeartbeatAt: ONLINE_HEARTBEAT,
        enrolledBy: U.admin,
        createdAt: ago(30 * DAY),
      },
      {
        id: H.revoked,
        organizationId: O.main,
        name: "old-runner",
        reportedVersion: "1.2.0",
        lastHeartbeatAt: ago(45 * DAY),
        revokedAt: ago(44 * DAY),
        enrolledBy: U.admin,
        createdAt: ago(85 * DAY),
      },
      ...poolHarnesses(allTypes, now),
    ]);
    // The control panel is pinned to harnesses in every state, one of them revoked.
    await tx.insert(harnessRepoPins).values(
      [H.online, H.offline, H.updating, H.revoked].map((harnessId, i) => ({
        id: fixtureId("pin", i + 1),
        harnessId,
        repositoryId: R.controlPanel,
        createdAt: ago((10 - i) * DAY),
      })),
    );
    const opengrep = fixtureId("hostTool", 1);
    await tx.insert(hostTools).values([
      { id: opengrep, organizationId: O.main, name: "opengrep", description: "Static analysis." },
      { id: fixtureId("hostTool", 2), organizationId: O.main, name: "terraform" },
    ]);
    await tx.insert(harnessHostTools).values([
      {
        harnessId: H.online,
        hostToolId: opengrep,
        discoveredPath: "/usr/local/bin/opengrep",
        reportedAt: ago(MINUTE),
      },
      {
        harnessId: H.outdated,
        hostToolId: opengrep,
        configuredPath: "/opt/opengrep/bin/opengrep",
        configuredPathExists: false,
        reportedAt: ago(2 * HOUR),
      },
    ]);
    const audit: (typeof harnessAudit.$inferInsert)[] = [];
    for (const [i, harnessId] of Object.values(H).entries()) {
      audit.push({
        id: fixtureId("harnessAudit", i * 10 + 1),
        harnessId,
        event: "enroll",
        ip: "192.0.2.10",
        createdAt: ago((60 - i * 5) * DAY),
      });
      audit.push({
        id: fixtureId("harnessAudit", i * 10 + 2),
        harnessId,
        event: "token_refresh",
        ip: "192.0.2.10",
        createdAt: ago((i + 1) * HOUR),
      });
    }
    audit.push({
      id: fixtureId("harnessAudit", 100),
      harnessId: H.revoked,
      event: "revoke",
      detail: { by: U.admin },
      createdAt: ago(44 * DAY),
    });
    audit.push({
      id: fixtureId("harnessAudit", 101),
      harnessId: H.revoked,
      event: "auth_failed",
      ip: "198.51.100.7",
      detail: { reason: "revoked" },
      createdAt: ago(43 * DAY),
    });
    await tx.insert(harnessAudit).values(audit);

    await seedRalph(tx, now);
    await seedReviews(tx, now);
    await seedOtherJobs(tx, now);
    await seedTriage(tx, now);
  });
}

/** How many pool harnesses fill the organization out to about 30, for the long pickers. */
const POOL_HARNESSES = 25;

/** Pool harnesses (`pool-01`…): mostly online, some offline, with varied task types. */
function poolHarnesses(allTypes: string[], now: Date): (typeof harnesses.$inferInsert)[] {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const taskTypes = [allTypes, ["query", "review"], ["coding"], ["review"]];
  return Array.from({ length: POOL_HARNESSES }, (_, i) => ({
    id: fixtureId("harness", 100 + i),
    organizationId: O.main,
    name:
      i === 7
        ? "pool-08-gpu-runner-in-the-eu-west-datacenter"
        : `pool-${String(i + 1).padStart(2, "0")}`,
    maxConcurrency: 2,
    acceptedTaskTypes: taskTypes[i % taskTypes.length],
    reportedVersion: FIXTURE_DESIRED_VERSION,
    selfUpdate: "supported" as const,
    lastHeartbeatAt: i % 5 === 4 ? ago((i + 1) * HOUR) : ONLINE_HEARTBEAT,
    enrolledBy: U.admin,
    createdAt: ago((20 - (i % 20)) * DAY),
  }));
}

/** Deletes an earlier seed (organizations cascade to almost everything). */
async function clearFixtures(tx: Tx): Promise<void> {
  // Audit rows outlive their harness (`set null`), so they go by their own IDs.
  await tx.delete(harnessAudit).where(inArray(harnessAudit.harnessId, Object.values(H)));
  await tx
    .delete(harnessAudit)
    .where(sql`${harnessAudit.id}::text like ${`${fixtureId("harnessAudit", 0).slice(0, 8)}-%`}`);
  await tx.delete(organizations).where(inArray(organizations.id, Object.values(O)));
  await tx.delete(users).where(inArray(users.id, Object.values(U)));
}

// ── Ralph ───────────────────────────────────────────────────────────────────

type StoryStatus = (typeof ralphStories.$inferInsert)["status"];

interface StorySpec {
  title: string;
  status: StoryStatus;
  attempts?: number;
  rounds?: number;
  lastFeedback?: string;
  /** The last attempt's result status (`ralph.story` coding run), when it ran. */
  result?: "complete" | "incomplete" | "blocked" | "failed";
  /** The last attempt is still running. */
  running?: boolean;
  followUps?: { title: string; description: string; manual: boolean }[];
  elsewhere?: string;
}

interface RunSpec {
  id: string;
  n: number;
  identifier: string;
  title: string;
  status: (typeof ralphRuns.$inferInsert)["status"];
  repositoryId: string | null;
  createdDaysAgo: number;
  stories: StorySpec[];
  kind?: "children" | "prd" | "single";
  error?: string;
  progress?: string;
  waitingOn?: (typeof ralphRuns.$inferInsert)["waitingOn"];
  guidance?: { text: string; at: string }[];
  lane?: Partial<typeof ralphLanes.$inferInsert>;
  pendingElicitation?: (typeof ralphRuns.$inferInsert)["pendingElicitation"];
}

let jobCounter = 0;
/** The next fixture job ID (reset per seed). */
const nextJobId = () => fixtureId("job", ++jobCounter);

async function seedRalph(tx: Tx, now: Date): Promise<void> {
  jobCounter = 0;
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const runs: RunSpec[] = [
    {
      id: RR.running,
      n: 1,
      identifier: "FIX-100",
      title: "Rebuild the onboarding flow",
      status: "running",
      repositoryId: R.controlPanel,
      createdDaysAgo: 2,
      kind: "prd",
      guidance: [
        {
          text: "Keep the existing invitation emails; only the screens change.",
          at: ago(DAY).toISOString(),
        },
      ],
      progress: [
        "## Codebase Patterns",
        '- Server components load data; views are `"use client"`.',
        "",
        "## FIX-101: Add the organization step",
        "- Added `OrganizationStep` and its server action.",
        "- **Learnings:** the onboarding layout already guards sign-in.",
        "---",
        "## FIX-102: Invite teammates from onboarding",
        "- Reused `createInvitation`; three attempts to get the email domain check right.",
        "---",
      ].join("\n"),
      lane: {
        prNumber: 412,
        prUrl: "https://github.com/fixture-labs/control-panel/pull/412",
        reviewRounds: 1,
        ciFixRounds: 1,
      },
      stories: [
        {
          title: "Add the organization step",
          status: "completed",
          attempts: 1,
          result: "complete",
        },
        {
          title: "Invite teammates from onboarding",
          status: "completed",
          attempts: 3,
          result: "complete",
          followUps: [
            {
              title: "Show pending invitations on the members page",
              description:
                "Invitations sent from onboarding don't appear under Settings › Organization.",
              manual: false,
            },
          ],
        },
        {
          title: "Connect a code host from onboarding",
          status: "running",
          attempts: 1,
          running: true,
        },
        {
          title: "Polish the onboarding UI in a review loop",
          status: "blocked",
          attempts: 1,
          rounds: 2,
          result: "blocked",
          lastFeedback: "Round 2 critique scored 27/40; filed 2 follow-ups for the P1 findings.",
          followUps: [
            {
              title: "Fix low-contrast helper text on the organization step",
              description: "- [ ] AA contrast in both themes",
              manual: false,
            },
            {
              title: "Stack the onboarding steps at 390px",
              description: "- [ ] No horizontal scroll at 390px",
              manual: false,
            },
          ],
        },
        { title: "Fix low-contrast helper text on the organization step", status: "pending" },
        { title: "Stack the onboarding steps at 390px", status: "pending" },
        {
          title: "Migrate legacy onboarding analytics",
          status: "exhausted",
          attempts: 3,
          result: "incomplete",
          lastFeedback:
            "`pnpm test` failed: 2 snapshot mismatches in onboarding-analytics.test.ts.",
        },
        { title: "Drop the old welcome page", status: "canceled" },
        {
          title: "Update the marketing site's sign-up link",
          status: "manual",
          elsewhere: "Belongs in fixture-labs/website, which Omniralph doesn't have.",
        },
      ],
    },
    {
      id: RR.waitingOnManual,
      n: 2,
      identifier: "FIX-120",
      title: "Rotate the webhook signing secrets",
      status: "waiting",
      repositoryId: R.harness,
      createdDaysAgo: 4,
      progress: "## FIX-121: Accept both secrets during rotation\n- Done.\n---",
      waitingOn: {
        blockers: [],
        manual: [
          {
            id: "fixture-linear-issue-122",
            identifier: "FIX-122",
            title: "Set the new secret in the GitHub App settings",
          },
        ],
      },
      lane: { prNumber: 87, prUrl: "https://github.com/fixture-labs/harness/pull/87" },
      stories: [
        {
          title: "Accept both secrets during rotation",
          status: "completed",
          attempts: 1,
          result: "complete",
        },
        { title: "Set the new secret in the GitHub App settings", status: "manual" },
        { title: "Remove the old secret", status: "pending" },
      ],
    },
    {
      id: RR.completed,
      n: 3,
      identifier: "FIX-90",
      title: "Add pagination to the jobs page",
      status: "completed",
      repositoryId: R.controlPanel,
      createdDaysAgo: 12,
      progress:
        "## FIX-91: Paginate jobs\n- Done.\n---\n## FIX-92: Keep filters across pages\n- Done.\n---",
      lane: {
        prNumber: 398,
        prUrl: "https://github.com/fixture-labs/control-panel/pull/398",
        prClosed: true,
        prMerged: true,
        mergeSha: sha(398),
        reviewRounds: 2,
        cleanup: {
          status: "done",
          at: ago(11 * DAY).toISOString(),
          mergedSha: sha(398),
          questions: [],
        },
      },
      stories: [
        { title: "Paginate the jobs page", status: "completed", attempts: 1, result: "complete" },
        {
          title: "Keep filters across pages",
          status: "completed",
          attempts: 2,
          result: "complete",
        },
      ],
    },
    {
      id: RR.failed,
      n: 4,
      identifier: "FIX-130",
      title: "Upgrade the GitLab client",
      status: "failed",
      repositoryId: R.platformApi,
      createdDaysAgo: 8,
      kind: "single",
      error: "The story ran out of attempts: the integration tests need a GitLab instance.",
      stories: [
        {
          title: "Upgrade the GitLab client",
          status: "exhausted",
          attempts: 3,
          result: "failed",
          lastFeedback: "Integration tests time out connecting to gitlab.fixtures.example.",
        },
      ],
    },
    {
      id: RR.stopped,
      n: 5,
      identifier: "FIX-140",
      title: "Experiment: streaming review summaries",
      status: "stopped",
      repositoryId: R.harness,
      createdDaysAgo: 20,
      stories: [
        {
          title: "Stream summaries to the sticky comment",
          status: "completed",
          attempts: 1,
          result: "complete",
        },
        { title: "Measure the latency win", status: "pending" },
      ],
    },
    {
      id: RR.pending,
      n: 6,
      identifier: "FIX-150",
      title: "Document the harness install on Windows",
      status: "pending",
      repositoryId: null,
      createdDaysAgo: 0,
      kind: "single",
      pendingElicitation: { kind: "repository", repositoryIds: [R.controlPanel, R.harness] },
      stories: [],
    },
  ];

  let runningJobId: string | null = null;
  for (const run of runs) {
    const created = ago(run.createdDaysAgo * DAY + run.n * HOUR);
    const at = (minutes: number) => new Date(created.getTime() + minutes * MINUTE);
    const active = run.status === "running" || run.status === "waiting" || run.status === "pending";
    await tx.insert(ralphRuns).values({
      id: run.id,
      organizationId: O.main,
      linearIssueId: `fixture-linear-issue-${run.identifier}`,
      linearIdentifier: run.identifier,
      linearTitle: run.title,
      linearUrl: `https://linear.app/fixture-labs/issue/${run.identifier}`,
      linearAgentSessionId: `fixture-agent-session-${run.n}`,
      kind: run.kind ?? "children",
      repositoryId: run.repositoryId,
      routedBy: run.repositoryId ? "team `FIX`" : null,
      harnessId: run.repositoryId ? H.online : null,
      status: run.status,
      waitingOn: run.waitingOn ?? null,
      guidance: run.guidance ?? [],
      progress: run.progress ?? "",
      pendingElicitation: run.pendingElicitation ?? null,
      iterations: run.stories.reduce((sum, s) => sum + (s.attempts ?? 0), 0),
      error: run.error ?? null,
      createdAt: created,
      updatedAt: active ? ago(10 * MINUTE) : at(run.stories.length * 45 + 30),
    });
    if (!run.repositoryId) continue;

    const laneId = fixtureId("ralphLane", run.n);
    await tx.insert(ralphLanes).values({
      id: laneId,
      runId: run.id,
      repositoryId: run.repositoryId,
      branch: `omniralph/${run.identifier.toLowerCase()}`,
      baseBranch: "main",
      createdAt: created,
      ...run.lane,
    });

    let minute = 5;
    for (const [position, story] of run.stories.entries()) {
      const identifier = `${run.identifier.split("-")[0]}-${Number(run.identifier.split("-")[1]) + position + 1}`;
      let lastJobId: string | null = null;
      const attempts = story.attempts ?? 0;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const id = nextJobId();
        const last = attempt === attempts;
        const running = last && story.running === true;
        const resultStatus = last ? story.result : "incomplete";
        const status = running ? "running" : resultStatus === "failed" ? "failed" : "completed";
        const startedAt = at(minute);
        const finishedAt = at(minute + 25 + attempt * 3);
        minute += 40;
        await tx.insert(jobs).values({
          id,
          organizationId: O.main,
          type: "ralph.story",
          taskType: "coding",
          taskId: "builtin:implement-story",
          payload: {
            trigger: {
              kind: "linear.delegated",
              context: { story: { identifier, title: story.title }, attempt },
            },
          },
          status,
          repositoryId: run.repositoryId,
          harnessId: H.online,
          targetHarnessId: H.online,
          ralphRunId: run.id,
          deliveryCount: 1,
          leaseExpiresAt: running ? new Date(now.getTime() + 10 * MINUTE) : null,
          result:
            running || !resultStatus
              ? null
              : {
                  status: resultStatus,
                  summary:
                    resultStatus === "complete"
                      ? `Implemented ${identifier}: ${story.title}.`
                      : (story.lastFeedback ?? "Quality gates failed."),
                  commitSha: resultStatus === "complete" ? sha(run.n * 100 + position) : undefined,
                  followUps: last ? (story.followUps ?? []) : [],
                  feedback:
                    resultStatus === "complete" ? null : (story.lastFeedback ?? "Gates failed."),
                  usage: {
                    inputTokens: 180_000 + position * 23_000 + attempt * 9_000,
                    outputTokens: 14_000 + position * 2_100,
                  },
                  durationMs: (25 + attempt * 3) * MINUTE,
                },
          error: status === "failed" ? "The session failed: integration tests timed out." : null,
          createdAt: startedAt,
          startedAt,
          finishedAt: running ? null : finishedAt,
        });
        lastJobId = id;
        if (running) runningJobId = id;
      }
      await tx.insert(ralphStories).values({
        id: fixtureId("ralphStory", run.n * 100 + position),
        runId: run.id,
        linearIssueId: `fixture-linear-issue-${identifier}`,
        identifier,
        title: story.title,
        position,
        status: story.status,
        attempts: story.running ? attempts - 1 : attempts,
        rounds: story.rounds ?? 0,
        roundMetrics: story.rounds
          ? {
              name: "critique score",
              direction: "higher",
              target: 32,
              values: [
                { round: 1, value: 22, at: at(60).toISOString() },
                { round: 2, value: 27, at: at(120).toISOString() },
              ],
            }
          : null,
        lastFeedback: story.lastFeedback ?? null,
        commitSha: story.status === "completed" ? sha(run.n * 100 + position) : null,
        lastJobId,
        laneId: story.elsewhere ? null : laneId,
        elsewhere: story.elsewhere ?? null,
        createdAt: created,
      });
    }

    if (run.status === "completed") {
      await tx.insert(jobs).values({
        id: nextJobId(),
        organizationId: O.main,
        type: "ralph.describe-pr",
        taskType: "query",
        taskId: "builtin:describe-pr",
        payload: {},
        status: "completed",
        repositoryId: run.repositoryId,
        harnessId: H.online,
        ralphRunId: run.id,
        result: {
          outcome: "answered",
          answer: null,
          structured: { title: run.title, body: "Fixture PR description." },
          references: [],
          usage: { inputTokens: 22_000, outputTokens: 1_800 },
          durationMs: 180_000,
        },
        createdAt: at(minute),
        startedAt: at(minute),
        finishedAt: at(minute + 3),
      });
    }
  }

  // Messages for the running run: one delivered to the live session, one pending request.
  await tx.insert(ralphMessages).values([
    {
      id: fixtureId("ralphMessage", 1),
      runId: RR.running,
      jobId: runningJobId,
      kind: "guidance",
      text: "Use the GitLab connection form we already have; don't build a new one.",
      trigger: "linear.mention",
      author: "Ada Admin",
      createdAt: new Date(now.getTime() - 20 * MINUTE),
      deliveredAt: new Date(now.getTime() - 19 * MINUTE),
    },
    {
      id: fixtureId("ralphMessage", 2),
      runId: RR.running,
      kind: "request",
      text: "Also add a skip link to the onboarding header.",
      trigger: "linear.mention",
      author: "Max Member",
      createdAt: new Date(now.getTime() - 5 * MINUTE),
    },
  ]);
}

// ── Reviews ─────────────────────────────────────────────────────────────────

const PR_TITLES = [
  "Add rate limiting to the webhook endpoints",
  "Refactor the job claim query",
  "Fix flaky harness heartbeat test",
  "Support GitLab merge request drafts",
  "Cache review depths per request",
  "Move analytics queries to the db package",
  "Validate task definitions on save",
  "Bump the Postgres image in tests",
];

const FINDING_TEMPLATES = [
  {
    severity: "critical",
    category: "security",
    title: "SQL built from request input",
    path: "src/lib/jobs/search.ts",
    body: "The status filter is interpolated into raw SQL. Use a bound parameter.",
  },
  {
    severity: "high",
    category: "correctness",
    title: "Lease is never renewed for long jobs",
    path: "src/lib/jobs/claim.ts",
    body: "Jobs longer than the lease are claimed twice.",
  },
  {
    severity: "medium",
    category: "performance",
    title: "N+1 query in the repository list",
    path: "src/app/(app)/repositories/page.tsx",
    body: "Each row loads its connection separately.",
  },
  {
    severity: "low",
    category: "maintainability",
    title: "Duplicated date formatting",
    path: "src/lib/format-date.ts",
    body: "This duplicates `formatDateTime`.",
  },
  {
    severity: "info",
    category: "style",
    title: "Prefer a named export",
    path: "src/components/run-badge.tsx",
    body: "The rest of the folder uses named exports.",
  },
] as const;

const REVIEW_STATUSES = [
  "completed",
  "completed",
  "completed",
  "budget_exhausted",
  "completed",
  "failed",
  "completed",
  "skipped",
  "completed",
  "completed",
] as const;

const DEPTH_BY_REPO: Record<string, ReviewDepth> = {
  [R.controlPanel]: "standard",
  [R.harness]: "deep",
  [R.platformApi]: "quick",
  [R.legacy]: "standard",
};

async function seedReviews(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const repos = [R.controlPanel, R.harness, R.platformApi, R.legacy];
  const harnessCycle = [H.online, H.online, H.updating, H.outdated, H.offline];

  let findingN = 0;
  let feedbackN = 0;
  // Spread over 40 days (a few fall outside the 30-day default window), newest first.
  const COUNT = 48;
  for (let i = 0; i < COUNT; i++) {
    const n = i + 1;
    const featured = n === 1;
    const repositoryId = featured ? R.controlPanel : repos[i % repos.length]!;
    const depth = DEPTH_BY_REPO[repositoryId]!;
    const createdAt = ago(Math.floor((i * 40 * DAY) / COUNT) + (i % 5) * HOUR + 2 * HOUR);
    const status =
      i === 2
        ? "running"
        : i === 3
          ? "queued"
          : featured
            ? "completed"
            : REVIEW_STATUSES[i % REVIEW_STATUSES.length]!;
    const done = status !== "running" && status !== "queued";
    const prNumber = 300 + ((i * 7) % 60);
    const harnessId = status === "queued" ? null : harnessCycle[i % harnessCycle.length]!;
    const budget = REVIEW_DEPTHS[depth].maxTokensPerReview;
    const tokensIn =
      !done || status === "skipped"
        ? 0
        : status === "budget_exhausted"
          ? budget
          : Math.round(budget * (0.25 + ((i * 37) % 50) / 100));
    const tokensOut = Math.round(tokensIn * 0.06);
    const head = sha(5000 + n);
    const base = sha(9000 + n);
    const reviewRunId = fixtureId("reviewRun", n);
    const reviewId = fixtureId("review", n);
    const jobId = nextJobId();
    const runStatus = status === "budget_exhausted" ? "completed" : status;

    await tx.insert(reviewRuns).values({
      id: reviewRunId,
      organizationId: O.main,
      repositoryId,
      prNumber,
      headSha: head,
      baseSha: base,
      trigger: i % 6 === 0 ? "mention" : i % 9 === 0 ? "manual" : "webhook",
      mode: i % 4 === 0 ? "full" : "incremental",
      depth,
      prAuthor: "fixture-dev",
      status: runStatus,
      summary:
        done && status !== "skipped"
          ? "Two issues worth fixing before merge; the rest are minor."
          : null,
      error: status === "failed" ? "The harness lost its session (exit code 137)." : null,
      createdAt,
    });
    await tx.insert(jobs).values({
      id: jobId,
      organizationId: O.main,
      type: "review.task",
      taskType: "review",
      taskId: "builtin:review-pr",
      payload: { prNumber },
      status:
        status === "budget_exhausted" ? "completed" : status === "skipped" ? "skipped" : status,
      repositoryId,
      harnessId,
      deliveryCount: harnessId ? 1 : 0,
      leaseExpiresAt: status === "running" ? new Date(now.getTime() + 5 * MINUTE) : null,
      error: status === "failed" ? "The harness lost its session (exit code 137)." : null,
      result:
        done && status !== "failed"
          ? { usage: { inputTokens: tokensIn, outputTokens: tokensOut } }
          : null,
      createdAt,
      startedAt: harnessId ? new Date(createdAt.getTime() + 20_000) : null,
      finishedAt: done ? new Date(createdAt.getTime() + 4 * MINUTE) : null,
    });
    await tx.insert(reviews).values({
      id: reviewId,
      reviewRunId,
      taskId: "builtin:review-pr",
      repositoryId,
      prNumber,
      prTitle: PR_TITLES[i % PR_TITLES.length]!,
      headSha: head,
      baseSha: base,
      trigger: i % 6 === 0 ? "mention" : i % 9 === 0 ? "manual" : "webhook",
      status,
      depth,
      tokensIn,
      tokensOut,
      budget,
      durationMs: done && status !== "skipped" ? 60_000 + ((i * 7919) % 180_000) : null,
      model: done ? REVIEW_DEPTHS[depth].model : null,
      harnessId,
      skippedFiles: featured
        ? [
            { path: "pnpm-lock.yaml", reason: "excluded by path filter" },
            { path: "public/hero.png", reason: "binary file" },
          ]
        : [],
      summary: done && status !== "skipped" ? "Looks solid overall; see the findings." : null,
      scope: done && status !== "skipped" ? { mode: "full", baseSha: base, headSha: head } : null,
      error:
        status === "failed"
          ? "The harness lost its session (exit code 137)."
          : status === "skipped"
            ? "This head was already reviewed."
            : null,
      createdAt,
    });

    if (status !== "completed" && status !== "budget_exhausted") continue;

    // The featured review has every severity and every status; the rest a few findings each.
    const templates = featured
      ? FINDING_TEMPLATES
      : FINDING_TEMPLATES.slice(i % 3, (i % 3) + 1 + (i % 3));
    const statuses = featured
      ? (["open", "dismissed", "dismissed", "open", "resolved"] as const)
      : templates.map(
          (_, k) =>
            (["open", "resolved", "dismissed", "superseded", "open"] as const)[(i + k) % 5]!,
        );
    for (const [k, t] of templates.entries()) {
      const findingId = fixtureId("finding", ++findingN);
      const findingStatus = statuses[k]!;
      await tx.insert(findings).values({
        id: findingId,
        reviewId,
        path: t.path,
        startLine: 10 + k * 17,
        endLine: 14 + k * 17,
        severity: t.severity,
        category: t.category,
        title: t.title,
        body: t.body,
        suggestion: k === 0 ? "Pass the value as a bound parameter instead." : null,
        confidence: 0.55 + ((k * 13) % 45) / 100,
        status: findingStatus,
        sourceTaskIds: ["builtin:review-pr"],
        scmCommentId: `fixture-comment-${findingN}`,
        createdAt,
      });
      const restored = featured && k === 3;
      if (findingStatus === "dismissed" || restored) {
        await tx.insert(feedback).values({
          id: fixtureId("feedback", ++feedbackN),
          findingId,
          userId: k === 2 ? null : U.member,
          scmUsername: k === 2 ? "fixture-dev" : null,
          source: k === 2 ? "scm" : "ui",
          reason: (["false_positive", "wont_fix", "not_relevant", "false_positive"] as const)[
            (i + k) % 4
          ]!,
          note: k === 1 ? "We validate this upstream in the webhook handler." : null,
          restoredAt: restored ? new Date(createdAt.getTime() + 2 * HOUR) : null,
          restoredBy: restored ? U.admin : null,
          createdAt: new Date(createdAt.getTime() + HOUR),
        });
      }
    }
  }

  // Rules: custom, learned from a dismissed finding of the featured review, and disabled.
  await tx.insert(rules).values([
    {
      id: fixtureId("rule", 1),
      repositoryId: R.controlPanel,
      kind: "custom",
      text: "Server actions must call requireUser() before touching the database.",
      createdBy: U.admin,
      createdAt: ago(30 * DAY),
    },
    {
      id: fixtureId("rule", 2),
      repositoryId: R.controlPanel,
      kind: "learned",
      text: "Don't flag string building in Drizzle `sql` templates: values are bound parameters.",
      sourceFindingId: fixtureId("finding", 2),
      createdAt: ago(10 * DAY),
    },
    {
      id: fixtureId("rule", 3),
      repositoryId: R.controlPanel,
      kind: "custom",
      text: "Prefer named exports in components.",
      enabled: false,
      createdBy: U.member,
      createdAt: ago(25 * DAY),
    },
    {
      id: fixtureId("rule", 4),
      repositoryId: R.platformApi,
      kind: "learned",
      text: "Generated GraphQL types under src/gen are never hand-edited.",
      createdAt: ago(15 * DAY),
    },
  ]);
}

// ── Triage ──────────────────────────────────────────────────────────────────

/** A `triage.run` job's payload, as `enqueueTriage` builds it (trimmed to what the panel reads). */
function triagePayload(
  triageRunId: string,
  identifier: string,
  title: string,
  extra: { branch?: string; reply?: string } = {},
) {
  return {
    trigger: {
      kind: "linear.triage",
      context: {
        triageRunId,
        issue: {
          identifier,
          title,
          description: "",
          stateType: "triage",
          creator: { name: "Fixture Admin" },
          url: `https://linear.app/fixture-labs/issue/${identifier}`,
        },
        repository: extra.branch ? "fixture-labs/control-panel" : null,
        branch: extra.branch ?? null,
        reply: extra.reply ?? null,
      },
    },
    ...(extra.branch ? { repositoryId: R.controlPanel, ref: extra.branch } : {}),
  };
}

async function seedTriage(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const T = FIXTURE_IDS.triageRuns;
  const usage = { inputTokens: 48_210, outputTokens: 6_930 };
  await tx.insert(triageRuns).values([
    {
      id: T.completed,
      organizationId: O.main,
      linearIssueId: "fixture-issue-triage-1",
      linearAgentSessionId: "fixture-session-triage-1",
      trigger: "mention",
      status: "completed",
      lastResult: {
        summary:
          "Rewrote **FIX-310** as an epic PRD (size L) with three stories. One question is open, so it stays in Backlog.",
        error: null,
        outcome: {
          outcome: "prd",
          size: "L",
          title: "Export review findings as CSV",
          description: [
            "## Problem",
            "",
            "Teams copy findings into spreadsheets by hand to track them across releases.",
            "",
            "## Goals",
            "",
            "- Export a review's findings as CSV from its page",
            "- Keep severity, status and file paths",
          ].join("\n"),
          openQuestions: ["Should dismissed findings be part of the export?"],
          stories: [
            {
              title: "Add a CSV export of a review's findings",
              body: "As a reviewer, I want to download a review's findings as CSV.\n\n## Acceptance Criteria\n\n- [ ] The review page has an Export button",
              priority: 2,
              dependsOn: [],
              manual: false,
            },
            {
              title: "Document the export",
              body: "As an admin, I want the export documented.\n\n## Acceptance Criteria\n\n- [ ] The docs describe the columns",
              priority: 3,
              dependsOn: [0],
              manual: false,
            },
            {
              title: "Validate functional requirements",
              body: "Verify the epic meets the PRD.\n\n## Acceptance Criteria\n\n- [ ] All quality gates pass",
              priority: 3,
              dependsOn: [0, 1],
              manual: false,
            },
          ],
          subIssueUpdates: [],
        },
        usage,
        durationMs: 3 * MINUTE + 12_000,
      },
      createdAt: ago(2 * DAY),
      updatedAt: ago(2 * DAY - 40 * MINUTE),
    },
    {
      id: T.failed,
      organizationId: O.main,
      linearIssueId: "fixture-issue-triage-2",
      linearAgentSessionId: "fixture-session-triage-2",
      trigger: "label",
      status: "failed",
      lastResult: {
        summary: "the triage ended without a result (max_turns)",
        error: "the triage ended without a result (max_turns)",
        outcome: null,
        usage: { inputTokens: 91_400, outputTokens: 12_050 },
        durationMs: 9 * MINUTE,
      },
      createdAt: ago(5 * HOUR),
      updatedAt: ago(5 * HOUR - 10 * MINUTE),
    },
    {
      id: T.running,
      organizationId: O.main,
      linearIssueId: "fixture-issue-triage-3",
      linearAgentSessionId: "fixture-session-triage-3",
      trigger: "mention",
      status: "running",
      pendingReply: "Please keep it to the GitHub provider for now.",
      createdAt: ago(4 * MINUTE),
      updatedAt: ago(3 * MINUTE),
    },
  ]);

  const firstJob = nextJobId();
  const replyJob = nextJobId();
  const failedJob = nextJobId();
  const runningJob = nextJobId();
  const query = {
    organizationId: O.main,
    type: "triage.run",
    taskType: "query",
  } as const;
  await tx.insert(jobs).values([
    {
      ...query,
      id: firstJob,
      payload: triagePayload(T.completed, "FIX-310", "CSV export of findings", { branch: "main" }),
      status: "completed",
      repositoryId: R.controlPanel,
      harnessId: H.online,
      deliveryCount: 1,
      createdAt: ago(2 * DAY + 30 * MINUTE),
      startedAt: ago(2 * DAY + 29 * MINUTE),
      finishedAt: ago(2 * DAY + 25 * MINUTE),
    },
    {
      ...query,
      id: replyJob,
      payload: triagePayload(T.completed, "FIX-310", "CSV export of findings", {
        branch: "main",
        reply: "Make it an epic: the docs need their own story.",
      }),
      status: "completed",
      repositoryId: R.controlPanel,
      harnessId: H.online,
      deliveryCount: 1,
      createdAt: ago(2 * DAY - 35 * MINUTE),
      startedAt: ago(2 * DAY - 36 * MINUTE),
      finishedAt: ago(2 * DAY - 40 * MINUTE),
    },
    {
      ...query,
      id: failedJob,
      payload: triagePayload(T.failed, "FIX-322", "Faster harness startup"),
      status: "completed",
      harnessId: H.online,
      deliveryCount: 1,
      createdAt: ago(5 * HOUR),
      startedAt: ago(5 * HOUR - MINUTE),
      finishedAt: ago(5 * HOUR - 10 * MINUTE),
    },
    {
      ...query,
      id: runningJob,
      payload: triagePayload(T.running, "FIX-331", "GitLab merge request templates", {
        branch: "main",
      }),
      status: "running",
      repositoryId: R.controlPanel,
      harnessId: H.online,
      deliveryCount: 1,
      leaseExpiresAt: new Date(now.getTime() + 10 * MINUTE),
      createdAt: ago(4 * MINUTE),
      startedAt: ago(3 * MINUTE),
    },
  ]);
  await tx
    .update(triageRuns)
    .set({ currentJobId: runningJob })
    .where(sql`${triageRuns.id} = ${T.running}`);

  const activities: [string, "thought" | "action", string, string | null][] = [
    [replyJob, "thought", "Reading the issue and the review pages it mentions.", null],
    [replyJob, "action", "Grep", "findings"],
    [replyJob, "action", "Read", "apps/web/src/app/(app)/reviews/[id]/review-detail-view.tsx"],
    [replyJob, "thought", "The reply asks for an epic, so the docs get their own story.", null],
    [runningJob, "thought", "Looking at how merge requests are opened today.", null],
    [runningJob, "action", "Grep", "createMergeRequest"],
  ];
  await tx.insert(runActivities).values(
    activities.map(([jobId, type, body, parameter], i) => ({
      id: fixtureId("runActivity", i + 1),
      jobId,
      organizationId: O.main,
      type,
      body,
      parameter,
      createdAt:
        jobId === runningJob
          ? ago(3 * MINUTE - (i - 3) * 20_000)
          : ago(2 * DAY - 36 * MINUTE - i * 30_000),
    })),
  );
}

// ── Other jobs: every job status ────────────────────────────────────────────

async function seedOtherJobs(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const base = { organizationId: O.main } as const;
  await tx.insert(jobs).values([
    {
      ...base,
      id: nextJobId(),
      type: "repo.sync",
      taskType: "system",
      payload: {},
      status: "queued",
      repositoryId: R.controlPanel,
      targetHarnessId: H.online,
      createdAt: ago(2 * MINUTE),
    },
    {
      ...base,
      id: nextJobId(),
      type: "review.reply",
      taskType: "query",
      payload: { prNumber: 412 },
      status: "canceled",
      repositoryId: R.controlPanel,
      cancelRequested: true,
      createdAt: ago(6 * HOUR),
      finishedAt: ago(6 * HOUR - MINUTE),
    },
    {
      ...base,
      id: nextJobId(),
      type: "review.task",
      taskType: "review",
      payload: { prNumber: 77 },
      status: "expired",
      repositoryId: R.platformApi,
      error: "No harness claimed the job within 24 hours.",
      createdAt: ago(3 * DAY),
      finishedAt: ago(2 * DAY),
    },
    {
      ...base,
      id: nextJobId(),
      type: "worktree.cleanup",
      taskType: "system",
      payload: {},
      status: "failed",
      repositoryId: R.harness,
      harnessId: H.offline,
      error: "git worktree remove: the worktree has uncommitted changes.",
      createdAt: ago(3 * DAY + 2 * HOUR),
      startedAt: ago(3 * DAY + 2 * HOUR),
      finishedAt: ago(3 * DAY + 2 * HOUR - MINUTE),
    },
    {
      ...base,
      id: nextJobId(),
      type: "install",
      taskType: "system",
      payload: { name: "@omniralph/code-graph", version: "0.4.1" },
      // Its MCP server is what the agent editor suggests as @omniralph/code-graph:graph.
      result: {
        name: "@omniralph/code-graph",
        version: "0.4.1",
        changed: true,
        commands: [],
        mcpServers: ["graph"],
        skills: 0,
      },
      status: "completed",
      harnessId: H.online,
      targetHarnessId: H.online,
      createdAt: ago(5 * HOUR),
      startedAt: ago(5 * HOUR),
      finishedAt: ago(5 * HOUR - MINUTE),
    },
  ]);
}
