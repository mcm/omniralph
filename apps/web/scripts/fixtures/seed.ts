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
  DESIRED_AGENT_VERSION_KEY,
  encrypt,
  feedback,
  findings,
  agentAudit,
  agents,
  agentRepoPins,
  chatConnections,
  chatRequestDrafts,
  chatThreadRuns,
  chatThreads,
  chatWebMessages,
  inboxItemStates,
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
  WEB_CHAT_CONNECTION_NAME,
  webChatChannelId,
  webChatExternalThreadId,
  webhookEvents,
  workItemMatches,
  workItemShareLinks,
  type Database,
} from "@omniralph/db";
import { getBuiltinPlaybook, playbookRequirements } from "@omniralph/tasks";
import {
  CHAT_ASK_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  REVIEW_DEPTHS,
  type ReviewDepth,
} from "@omniralph/shared";
import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import {
  FIXTURE_EMAILS,
  FIXTURE_IDS,
  FIXTURE_INBOX_KEYS,
  FIXTURE_SANDBOX_LINEAR_TOKEN,
  FIXTURE_SHARE_TOKENS,
  fixedJobId,
  fixtureId,
  laneId,
  storyAttemptId,
  storyId,
} from "./ids";

/** Fake, fixed `ENCRYPTION_KEY` the fixture credentials are encrypted with (hex of "fixture…"). */
export const FIXTURE_ENCRYPTION_KEY = Buffer.from("fixture-key-not-a-secret-32bytes").toString(
  "hex",
);
/** Fake, fixed `AUTH_SECRET` for running the panel against the fixtures. */
export const FIXTURE_AUTH_SECRET = "fixture-auth-secret-not-a-secret";

/** The agent version the organization wants (a concrete version: no npm lookup). */
export const FIXTURE_DESIRED_VERSION = "1.8.0";

/**
 * Heartbeat of the online agents. Far in the future so they stay online
 * (heartbeat under a minute old) however long after seeding the panel renders.
 */
const ONLINE_HEARTBEAT = new Date("2099-01-01T00:00:00Z");

/**
 * An online agent: the frozen heartbeat (claims and Repos read it) and announced online
 * (`live_online`, which Fleet's status reads), so Fleet shows its intended states instead of
 * "Offline" while the agent runs work.
 */
const ONLINE = { lastHeartbeatAt: ONLINE_HEARTBEAT, liveOnline: true } as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const { users: U, organizations: O, repositories: R, agents: H, ralphRuns: RR } = FIXTURE_IDS;

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
    // No saved theme (System): a capture's emulated color scheme decides the theme.
    await tx.insert(users).values([
      {
        id: U.admin,
        name: "Ada Admin",
        email: FIXTURE_EMAILS.admin,
        emailVerified: ago(90 * DAY),
        theme: null,
        createdAt: ago(90 * DAY),
      },
      {
        id: U.member,
        name: "Max Member",
        email: FIXTURE_EMAILS.member,
        emailVerified: ago(60 * DAY),
        theme: null,
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
      { organizationId: O.sandbox, userId: U.member, role: "member", createdAt: ago(25 * DAY) },
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
      key: DESIRED_AGENT_VERSION_KEY,
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
        codingEnabled: true,
        pathExcludes: ["**/*.snap", "pnpm-lock.yaml"],
        customInstructions: "Prefer server components; flag any client-side secret.",
        codingInstructions: "NEVER use `git merge` in this repo, ALWAYS rebase.",
        historyRewrite: "always",
      },
      {
        ...githubRepo("fixture-labs/agent", 2),
        id: R.agent,
        reviewDepth: "deep",
        codingEnabled: true,
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
      // Reviews, Coding and Ask all off, and no work item match.
      {
        ...githubRepo("fixture-labs/docs", 4),
        id: R.docs,
        reviewsEnabled: false,
        askEnabled: false,
      },
      {
        ...githubRepo("fixture-labs/legacy-dashboard", 5),
        id: R.legacy,
        reviewsEnabled: false,
        disconnectedAt: ago(20 * DAY),
      },
    ]);
    // Work item matches: Coding on needs one. The GitLab API has one with Coding off; docs none.
    const match = (repositoryId: string, team: string, project: string | null) => ({
      repositoryId,
      organizationId: O.main,
      tracker: "linear" as const,
      team,
      project,
      createdBy: U.admin,
      updatedBy: U.admin,
    });
    await tx
      .insert(workItemMatches)
      .values([
        match(R.controlPanel, "FIX", "Control panel"),
        match(R.agent, "FIX", "Agent"),
        match(R.platformApi, "OPS", null),
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
        repositoryId: R.agent,
        query: {
          combinator: "and",
          rules: [{ field: "project", operator: "=", value: "Agent" }],
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

    await seedSandbox(tx, now);

    // Review links of FIX-101 (`/share/{token}`): one open, one with a password
    // (`FIXTURE_SHARE_PASSWORD`, hashed as `hashSharePassword` does with a fixed salt).
    const shareLink = (token: string, passwordHash: string | null) => ({
      organizationId: O.main,
      tracker: "linear" as const,
      externalId: "fixture-issue-fix-101",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      passwordHash,
      createdBy: U.admin,
      createdAt: ago(2 * DAY),
      expiresAt: new Date(now.getTime() + 28 * DAY),
    });
    await tx
      .insert(workItemShareLinks)
      .values([
        shareLink(FIXTURE_SHARE_TOKENS.open, null),
        shareLink(
          FIXTURE_SHARE_TOKENS.protected,
          "scrypt$16384$8$1$Zml4dHVyZS1zYWx0LTE2Yg$UBIBm0nyx-3K5SHS2qQ-b8Pdb7UkQr_faf443N28XrA",
        ),
      ]);

    // ── Agents ─────────────────────────────────────────────────────────
    const allTypes = ["query", "review", "coding"];
    const installables = [{ name: "@omniralph/code-graph", version: "0.4.1" }];
    const models = [
      { value: "default", displayName: "Default (recommended)" },
      { value: "opus", displayName: "Opus" },
      { value: "sonnet", displayName: "Sonnet" },
      { value: "haiku", displayName: "Haiku" },
    ];
    await tx.insert(agents).values([
      {
        id: H.online,
        organizationId: O.main,
        name: "build-01",
        reportedHostTools: [
          {
            name: "opengrep",
            path: "/usr/local/bin/opengrep",
            source: "discovered",
            problem: null,
          },
          { name: "terraform", path: null, source: null, problem: null },
        ],
        reportedMaxConcurrency: 4,
        reportedAcceptedTaskTypes: allTypes,
        reportedPoolLimits: { short: 4, long: 2 },
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
        ...ONLINE,
        enrolledBy: U.admin,
        createdAt: ago(60 * DAY),
      },
      {
        id: H.offline,
        organizationId: O.main,
        name: "build-02",
        reportedMaxConcurrency: 2,
        reportedAcceptedTaskTypes: ["query", "review"],
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
        // Its configured path doesn't exist: no fallback to `PATH`.
        reportedHostTools: [{ name: "opengrep", path: null, source: null, problem: "missing" }],
        reportedMaxConcurrency: 1,
        reportedAcceptedTaskTypes: allTypes,
        reportedVersion: "1.6.2",
        selfUpdate: "unsupported",
        ...ONLINE,
        enrolledBy: U.admin,
        createdAt: ago(40 * DAY),
      },
      {
        id: H.updating,
        organizationId: O.main,
        name: "build-03",
        reportedMaxConcurrency: 2,
        reportedAcceptedTaskTypes: allTypes,
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
        ...ONLINE,
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
      ...poolAgents(allTypes, now),
    ]);
    // The control panel is pinned to agents in every state, one of them revoked.
    await tx.insert(agentRepoPins).values(
      [H.online, H.offline, H.updating, H.revoked].map((agentId, i) => ({
        id: fixtureId("pin", i + 1),
        agentId: agentId,
        repositoryId: R.controlPanel,
        createdAt: ago((10 - i) * DAY),
      })),
    );
    const audit: (typeof agentAudit.$inferInsert)[] = [];
    for (const [i, agentId] of Object.values(H).entries()) {
      audit.push({
        id: fixtureId("agentAudit", i * 10 + 1),
        agentId: agentId,
        event: "enroll",
        ip: "192.0.2.10",
        createdAt: ago((60 - i * 5) * DAY),
      });
      audit.push({
        id: fixtureId("agentAudit", i * 10 + 2),
        agentId: agentId,
        event: "token_refresh",
        ip: "192.0.2.10",
        createdAt: ago((i + 1) * HOUR),
      });
    }
    audit.push({
      id: fixtureId("agentAudit", 100),
      agentId: H.revoked,
      event: "revoke",
      detail: { by: U.admin },
      createdAt: ago(44 * DAY),
    });
    audit.push({
      id: fixtureId("agentAudit", 101),
      agentId: H.revoked,
      event: "auth_failed",
      ip: "198.51.100.7",
      detail: { reason: "revoked" },
      createdAt: ago(43 * DAY),
    });
    await tx.insert(agentAudit).values(audit);

    await seedAsk(tx, now);
    await seedRalph(tx, now);
    await seedRequests(tx, now);
    await seedReviews(tx, now);
    await seedOtherJobs(tx, now);
    await seedTriage(tx, now);
    await seedInboxStates(tx, now);
    await seedWebhookEvents(tx, now);
  });
}

/**
 * The sandbox organization: a GitHub connection with one repo (Coding on) and its own Linear
 * workspace (`FIXTURE_SANDBOX_LINEAR_TOKEN`), but no agents and no runs. Its Inbox is empty and
 * its Backlog isn't, so the empty Inbox shows Up next (board InboxEmpty).
 */
async function seedSandbox(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const key = FIXTURE_ENCRYPTION_KEY;
  await tx.insert(scmConnections).values({
    id: FIXTURE_IDS.scmConnections.sandboxGithub,
    organizationId: O.sandbox,
    provider: "github",
    name: "fixture-sandbox",
    baseUrl: "https://api.github.com",
    externalId: "fixture-installation-2",
    encryptedCredentials: encrypt("{}", key),
    createdBy: U.admin,
    createdAt: ago(29 * DAY),
  });
  await tx.insert(repositories).values({
    id: R.sandboxPlayground,
    organizationId: O.sandbox,
    provider: "github",
    externalId: "fixture-repo-6",
    fullPath: "fixture-sandbox/playground",
    connectionId: FIXTURE_IDS.scmConnections.sandboxGithub,
    codingEnabled: true,
    createdAt: ago(28 * DAY),
  });
  await tx.insert(workItemMatches).values({
    repositoryId: R.sandboxPlayground,
    organizationId: O.sandbox,
    tracker: "linear",
    team: "SBX",
    project: null,
    createdBy: U.admin,
    updatedBy: U.admin,
  });
  await tx.insert(integrations).values({
    id: FIXTURE_IDS.integrations.sandboxLinear,
    organizationId: O.sandbox,
    provider: "linear",
    externalId: "fixture-linear-sandbox-workspace",
    name: "Fixture Sandbox",
    encryptedCredentials: encrypt(
      JSON.stringify({ accessToken: FIXTURE_SANDBOX_LINEAR_TOKEN }),
      key,
    ),
    installedByUserId: U.admin,
    createdAt: ago(28 * DAY),
  });
}

/** How many pool agents fill the organization out to about 30, for the long pickers. */
const POOL_AGENTS = 25;

/** Pool agents (`pool-01`…): mostly online, some offline, with varied task types. */
function poolAgents(allTypes: string[], now: Date): (typeof agents.$inferInsert)[] {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const taskTypes = [allTypes, ["query", "review"], ["coding"], ["review"]];
  return Array.from({ length: POOL_AGENTS }, (_, i) => ({
    id: fixtureId("agent", 100 + i),
    organizationId: O.main,
    name:
      i === 7
        ? "pool-08-gpu-runner-in-the-eu-west-datacenter"
        : `pool-${String(i + 1).padStart(2, "0")}`,
    reportedMaxConcurrency: 2,
    reportedAcceptedTaskTypes: taskTypes[i % taskTypes.length],
    reportedVersion: FIXTURE_DESIRED_VERSION,
    selfUpdate: "supported" as const,
    ...(i % 5 === 4 ? { lastHeartbeatAt: ago((i + 1) * HOUR) } : ONLINE),
    enrolledBy: U.admin,
    createdAt: ago((20 - (i % 20)) * DAY),
  }));
}

/** Deletes an earlier seed (organizations cascade to almost everything). */
async function clearFixtures(tx: Tx): Promise<void> {
  // Audit rows outlive their agent (`set null`), so they go by their own IDs.
  await tx.delete(agentAudit).where(inArray(agentAudit.agentId, Object.values(H)));
  await tx
    .delete(agentAudit)
    .where(sql`${agentAudit.id}::text like ${`${fixtureId("agentAudit", 0).slice(0, 8)}-%`}`);
  await tx.delete(organizations).where(inArray(organizations.id, Object.values(O)));
  await tx.delete(users).where(inArray(users.id, Object.values(U)));
}

// ── Ask ─────────────────────────────────────────────────────────────────────

/** The web chat connection of the main organization (one per organization). */
const WEB_CHAT_CONNECTION_ID = fixtureId("chatConnection", 1);

interface AskSpec {
  runId: string;
  /** The ask run's attempt (`chat.ask` job). */
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "skipped";
  question: string;
  /** Om's reply: its Markdown, and whether it is still streaming. */
  answer?: { markdown: string; streaming?: boolean; draftId?: string };
  error?: string;
}

interface ChatSpec {
  id: string;
  repositoryId: string | null;
  startedAgo: number;
  asks: AskSpec[];
}

/**
 * The admin's web chats: answered, answered with a drafted Request, being answered, waiting
 * for an agent, and older questions whose ask runs failed, were stopped and were skipped.
 */
async function seedAsk(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const C = FIXTURE_IDS.askChats;
  const A = FIXTURE_IDS.askRuns;
  await tx.insert(chatConnections).values({
    id: WEB_CHAT_CONNECTION_ID,
    organizationId: O.main,
    platform: "web",
    externalId: O.main,
    name: WEB_CHAT_CONNECTION_NAME,
    encryptedCredentials: null,
    createdAt: ago(10 * DAY),
  });
  const chats: ChatSpec[] = [
    {
      id: C.controlPanel,
      repositoryId: R.controlPanel,
      startedAgo: 2 * HOUR,
      asks: [
        {
          runId: A.completed,
          jobId: fixedJobId(101),
          status: "completed",
          question: "Where does the sign-in form post to?",
          answer: {
            markdown:
              "The sign-in form posts to `/api/auth/signin/email`, which sends the magic link. " +
              "The dev sign-in (`/sign-in/dev`) skips the email in development.",
          },
        },
      ],
    },
    {
      id: C.requestDraft,
      repositoryId: R.controlPanel,
      startedAgo: 50 * MINUTE,
      asks: [
        {
          runId: A.drafted,
          jobId: fixedJobId(102),
          status: "completed",
          question: "Can members export the Runs list?",
          answer: {
            markdown:
              "Not yet: the Runs list has no export. It needs a code change, so I drafted a " +
              "request for it.",
            draftId: FIXTURE_IDS.requestDrafts.pending,
          },
        },
      ],
    },
    {
      id: C.answering,
      repositoryId: R.agent,
      startedAgo: 3 * MINUTE,
      asks: [
        {
          runId: A.running,
          jobId: fixedJobId(103),
          status: "running",
          question: "Which agents can run reviews?",
          answer: {
            markdown: "Agents take reviews when `review` is one of their accepted task types.",
            streaming: true,
          },
        },
      ],
    },
    {
      id: C.waiting,
      repositoryId: null,
      startedAgo: MINUTE,
      asks: [
        {
          runId: A.queued,
          jobId: fixedJobId(104),
          status: "queued",
          question: "What does the GitLab token warning mean?",
        },
      ],
    },
    {
      id: C.older,
      repositoryId: R.platformApi,
      startedAgo: 6 * DAY,
      asks: [
        {
          runId: A.failed,
          jobId: fixedJobId(105),
          status: "failed",
          question: "How does the API paginate merge requests?",
          error: "The agent lost its session (exit code 137).",
        },
        {
          runId: A.stopped,
          jobId: fixedJobId(106),
          status: "canceled",
          question: "Can you check the pagination again?",
        },
        {
          runId: A.skipped,
          jobId: fixedJobId(107),
          status: "skipped",
          question: "Can you check the pagination again?",
        },
      ],
    },
  ];

  const repoPath: Record<string, string> = {
    [R.controlPanel]: "fixture-labs/control-panel",
    [R.agent]: "fixture-labs/agent",
    [R.platformApi]: "fixture-labs/platform/api",
  };
  let messageN = 0;
  for (const chat of chats) {
    const started = ago(chat.startedAgo);
    const last = chat.asks.length - 1;
    await tx.insert(chatThreads).values({
      id: chat.id,
      organizationId: O.main,
      connectionId: WEB_CHAT_CONNECTION_ID,
      platform: "web",
      externalThreadId: webChatExternalThreadId(O.main, chat.id),
      channelId: webChatChannelId(O.main),
      startedByExternalUserId: U.admin,
      startedByUserId: U.admin,
      title: chat.asks[0]!.question,
      repositoryId: chat.repositoryId,
      branch: chat.repositoryId ? "main" : null,
      createdAt: started,
      updatedAt: new Date(started.getTime() + (last * 10 + 1) * MINUTE),
    });
    for (const [i, ask] of chat.asks.entries()) {
      const askedAt = new Date(started.getTime() + i * 10 * MINUTE);
      const answeredAt = new Date(askedAt.getTime() + MINUTE);
      const done = ask.status !== "queued" && ask.status !== "running";
      const repositoryId = chat.repositoryId ?? R.controlPanel;
      await tx.insert(jobs).values({
        id: ask.jobId,
        organizationId: O.main,
        type: CHAT_ASK_JOB_TYPE,
        taskType: "query",
        taskId: "builtin:ask-about-code",
        payload: {
          trigger: {
            kind: "chat.request",
            context: { repository: repoPath[repositoryId], question: ask.question },
          },
        },
        status: ask.status,
        repositoryId,
        agentId: ask.status === "queued" ? null : H.online,
        deliveryCount: ask.status === "queued" ? 0 : 1,
        cancelRequested: ask.status === "canceled",
        leaseExpiresAt: ask.status === "running" ? new Date(now.getTime() + 10 * MINUTE) : null,
        result:
          ask.status === "completed"
            ? {
                outcome: "answered",
                answer: ask.answer?.markdown ?? null,
                references: [],
                usage: { inputTokens: 31_000, outputTokens: 1_200 },
                durationMs: 55_000,
              }
            : null,
        error: ask.error ?? null,
        createdAt: askedAt,
        startedAt: ask.status === "queued" ? null : new Date(askedAt.getTime() + 5_000),
        finishedAt: done ? answeredAt : null,
      });
      await tx.insert(chatThreadRuns).values({
        id: ask.runId,
        organizationId: O.main,
        chatThreadId: chat.id,
        kind: "query",
        jobId: ask.jobId,
        createdAt: askedAt,
      });
      await tx.insert(chatWebMessages).values({
        id: fixtureId("chatWebMessage", ++messageN),
        organizationId: O.main,
        threadId: chat.id,
        author: "user",
        userId: U.admin,
        markdown: ask.question,
        createdAt: askedAt,
        updatedAt: askedAt,
      });
      if (!ask.answer) continue;
      if (ask.answer.draftId) {
        await tx.insert(chatRequestDrafts).values({
          id: ask.answer.draftId,
          organizationId: O.main,
          threadId: chat.id,
          requestedByUserId: U.admin,
          requestedByExternalUserId: U.admin,
          repositoryId,
          title: "Export the Runs list as CSV",
          request: [
            "Add an **Export** action to the Runs list that downloads the filtered runs as CSV:",
            "one row per run with its kind, status, repo, start time and duration.",
          ].join("\n"),
          status: "pending",
          messageId: fixtureId("chatWebMessage", messageN + 1),
          expiresAt: new Date(now.getTime() + 6 * DAY),
          createdAt: answeredAt,
          updatedAt: answeredAt,
        });
      }
      await tx.insert(chatWebMessages).values({
        id: fixtureId("chatWebMessage", ++messageN),
        organizationId: O.main,
        threadId: chat.id,
        author: "om",
        markdown: ask.answer.markdown,
        status: ask.answer.streaming ? "streaming" : "complete",
        cardRef: ask.answer.draftId ? { kind: "request_draft", draftId: ask.answer.draftId } : null,
        threadRunId: ask.runId,
        createdAt: answeredAt,
        updatedAt: answeredAt,
      });
    }
  }
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

/** The PR of `ralphRuns.pullRequestWaiting`, which the featured review reviewed. */
const FEATURED_PR = 421;
/** The GitLab MR of `ralphRuns.mergeRequestWaiting`, which the second review reviewed. */
const MERGE_REQUEST_IID = 58;

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
                "Invitations sent from onboarding don't appear under Settings › Members.",
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
      repositoryId: R.agent,
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
      lane: { prNumber: 87, prUrl: "https://github.com/fixture-labs/agent/pull/87" },
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
      repositoryId: R.agent,
      // Within the Inbox's 14 days: "Stopped" under Needs you.
      createdDaysAgo: 3,
      error: "Stopped by Ada Admin.",
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
      title: "Document the agent install on Windows",
      status: "pending",
      repositoryId: null,
      createdDaysAgo: 0,
      kind: "single",
      pendingElicitation: { kind: "repository", repositoryIds: [R.controlPanel, R.agent] },
      stories: [],
    },
    {
      // Done; its PR waits on a person, who asked for changes. The AI review has open findings.
      id: RR.pullRequestWaiting,
      n: 7,
      identifier: "FIX-160",
      title: "Show agent capacity on Fleet",
      status: "completed",
      repositoryId: R.controlPanel,
      createdDaysAgo: 1,
      lane: {
        prNumber: FEATURED_PR,
        prUrl: `https://github.com/fixture-labs/control-panel/pull/${FEATURED_PR}`,
        prReviewState: "changes_requested",
        prStateUpdatedAt: ago(3 * HOUR),
        reviewRounds: 1,
      },
      stories: [
        { title: "Report slots per agent", status: "completed", attempts: 1, result: "complete" },
        {
          title: "Show free slots in the agent panel",
          status: "completed",
          attempts: 2,
          result: "complete",
        },
      ],
    },
    {
      // Done; its GitLab MR waits on a person to merge it after approving. The AI review is clean.
      id: RR.mergeRequestWaiting,
      n: 8,
      identifier: "FIX-170",
      title: "Retry failed deliveries from the log",
      status: "completed",
      repositoryId: R.platformApi,
      createdDaysAgo: 2,
      kind: "single",
      lane: {
        prNumber: MERGE_REQUEST_IID,
        prUrl: `https://gitlab.fixtures.example/fixture-labs/platform/api/-/merge_requests/${MERGE_REQUEST_IID}`,
        prReviewState: "approved",
        prStateUpdatedAt: ago(5 * HOUR),
      },
      stories: [
        {
          title: "Retry failed deliveries from the log",
          status: "completed",
          attempts: 1,
          result: "complete",
        },
      ],
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
      agentId: run.repositoryId ? H.online : null,
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

    const lane = laneId(run.n);
    await tx.insert(ralphLanes).values({
      id: lane,
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
      const ralphStoryId = storyId(run.n, position);
      let lastJobId: string | null = null;
      const attempts = story.attempts ?? 0;
      // The story first, so its attempts link to it; its last attempt is set after them.
      await tx.insert(ralphStories).values({
        id: ralphStoryId,
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
        laneId: story.elsewhere ? null : lane,
        elsewhere: story.elsewhere ?? null,
        createdAt: created,
      });
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const id = storyAttemptId(run.n, position, attempt);
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
          agentId: H.online,
          targetAgentId: H.online,
          ralphRunId: run.id,
          ralphStoryId,
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
      if (lastJobId) {
        await tx
          .update(ralphStories)
          .set({ lastJobId })
          .where(sql`${ralphStories.id} = ${ralphStoryId}`);
      }
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
        agentId: H.online,
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
    // A finished run ends after its last attempt, so its Activity reads in order.
    if (!active) {
      await tx
        .update(ralphRuns)
        .set({ updatedAt: at(minute + 5) })
        .where(sql`${ralphRuns.id} = ${run.id}`);
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

  // Transcripts: the last of three attempts at a story, and a running attempt.
  const { completedWithTranscript, runningWithTranscript } = FIXTURE_IDS.attempts;
  const transcript: [string, "thought" | "action", string, string | null][] = [
    [completedWithTranscript, "thought", "The last attempt failed the email domain check.", null],
    [completedWithTranscript, "action", "Read", "src/lib/invitations/email-domain.ts"],
    [completedWithTranscript, "thought", "Domains are compared case-sensitively.", null],
    [completedWithTranscript, "action", "Edit", "src/lib/invitations/email-domain.ts"],
    [completedWithTranscript, "action", "Bash", "pnpm turbo run typecheck lint test"],
    [completedWithTranscript, "thought", "The gates pass. Committing the story.", null],
    [runningWithTranscript, "thought", "Looking for the existing GitLab connection form.", null],
    [runningWithTranscript, "action", "Grep", "GitLabConnectionForm"],
    [runningWithTranscript, "action", "Read", "src/screens/settings/add-connection-settings.tsx"],
  ];
  const attemptStart = new Map<string, Date>();
  for (const id of [completedWithTranscript, runningWithTranscript]) {
    const [row] = await tx
      .select({ startedAt: jobs.startedAt })
      .from(jobs)
      .where(sql`${jobs.id} = ${id}`);
    attemptStart.set(id, row!.startedAt!);
  }
  await tx.insert(runActivities).values(
    transcript.map(([jobId, type, body, parameter], i) => ({
      id: fixtureId("runActivity", 100 + i),
      jobId,
      organizationId: O.main,
      type,
      body,
      parameter,
      createdAt: new Date(attemptStart.get(jobId)!.getTime() + (i + 1) * 40_000),
    })),
  );
}

// ── Requests ────────────────────────────────────────────────────────────────

interface RequestSpec {
  id: string;
  n: number;
  identifier: string;
  title: string;
  status: (typeof ralphRuns.$inferInsert)["status"];
  repositoryId: string;
  /** Its one attempt's status (`ralph.request` job). */
  attempt: "queued" | "running" | "completed" | "failed" | "canceled";
  createdAgo: number;
  /** Started from a web chat (origin `chat`) rather than a Linear mention. */
  chatThreadId?: string;
  lane?: Partial<typeof ralphLanes.$inferInsert>;
  error?: string;
}

/** Request runs (a mention's or a chat's one change), one in every status. */
async function seedRequests(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const Q = FIXTURE_IDS.requestRuns;
  const requests: RequestSpec[] = [
    {
      id: Q.queued,
      n: 21,
      identifier: "FIX-201",
      title: "Rename the Retry button on failed syncs",
      status: "pending",
      repositoryId: R.controlPanel,
      attempt: "queued",
      createdAgo: 2 * MINUTE,
    },
    {
      id: Q.running,
      n: 22,
      identifier: "FIX-202",
      title: "Fix the flaky heartbeat test",
      status: "running",
      repositoryId: R.agent,
      attempt: "running",
      createdAgo: 12 * MINUTE,
    },
    {
      id: Q.waiting,
      n: 23,
      identifier: "FIX-203",
      title: "Address the review comments on the claim query",
      status: "waiting",
      repositoryId: R.controlPanel,
      attempt: "completed",
      createdAgo: 5 * HOUR,
      lane: {
        prNumber: 430,
        prUrl: "https://github.com/fixture-labs/control-panel/pull/430",
        prDraft: true,
      },
    },
    {
      id: Q.completed,
      n: 24,
      identifier: "FIX-204",
      title: "Point the sign-in docs at the email route",
      status: "completed",
      repositoryId: R.controlPanel,
      attempt: "completed",
      createdAgo: 90 * MINUTE,
      chatThreadId: FIXTURE_IDS.askChats.controlPanel,
      lane: {
        prNumber: 431,
        prUrl: "https://github.com/fixture-labs/control-panel/pull/431",
        prClosed: true,
        prMerged: true,
        mergeSha: sha(431),
      },
    },
    {
      id: Q.failed,
      n: 25,
      identifier: "FIX-205",
      title: "Bump the GitLab client's retry limit",
      status: "failed",
      repositoryId: R.platformApi,
      attempt: "failed",
      createdAgo: 2 * DAY,
      error: "The request ran out of attempts: `pnpm test` timed out twice.",
    },
    {
      id: Q.stopped,
      n: 26,
      identifier: "FIX-206",
      title: "Try a smaller review model",
      status: "stopped",
      repositoryId: R.agent,
      attempt: "canceled",
      createdAgo: 4 * DAY,
      error: "Stopped by Max Member.",
    },
  ];
  for (const request of requests) {
    const created = ago(request.createdAgo);
    const fromChat = !!request.chatThreadId;
    const active = request.status === "pending" || request.status === "running";
    const finishedAt = new Date(created.getTime() + 20 * MINUTE);
    await tx.insert(ralphRuns).values({
      id: request.id,
      organizationId: O.main,
      origin: fromChat ? "chat" : "linear",
      chatThreadId: request.chatThreadId ?? null,
      ...(!fromChat && {
        linearIssueId: `fixture-linear-issue-${request.identifier}`,
        linearIdentifier: request.identifier,
        linearUrl: `https://linear.app/fixture-labs/issue/${request.identifier}`,
        linearAgentSessionId: `fixture-agent-session-${request.n}`,
      }),
      linearTitle: request.title,
      kind: "single",
      mode: "request",
      repositoryId: request.repositoryId,
      routedBy: fromChat ? "your selection" : "team `FIX`",
      agentId: request.attempt === "queued" ? null : H.online,
      status: request.status,
      iterations: 1,
      error: request.error ?? null,
      createdAt: created,
      updatedAt: active ? ago(MINUTE) : finishedAt,
    });
    await tx.insert(ralphLanes).values({
      id: laneId(request.n),
      runId: request.id,
      repositoryId: request.repositoryId,
      branch: `omniralph/${request.identifier.toLowerCase()}`,
      baseBranch: "main",
      createdAt: created,
      ...request.lane,
    });
    const done = request.attempt !== "queued" && request.attempt !== "running";
    await tx.insert(jobs).values({
      id: fixedJobId(200 + request.n),
      organizationId: O.main,
      type: RALPH_REQUEST_JOB_TYPE,
      taskType: "coding",
      taskId: "builtin:handle-request",
      payload: {
        trigger: {
          kind: fromChat ? "chat.request" : "linear.mention",
          context: { request: request.title },
        },
      },
      status: request.attempt,
      repositoryId: request.repositoryId,
      agentId: request.attempt === "queued" ? null : H.online,
      targetAgentId: H.online,
      ralphRunId: request.id,
      deliveryCount: request.attempt === "queued" ? 0 : 1,
      cancelRequested: request.attempt === "canceled",
      leaseExpiresAt: request.attempt === "running" ? new Date(now.getTime() + 10 * MINUTE) : null,
      result:
        request.attempt === "completed"
          ? {
              summary: `Done: ${request.title}.`,
              error: null,
              sessionId: `fixture-session-request-${request.n}`,
              commitSha: sha(request.n),
              pushed: true,
              usage: { inputTokens: 64_000, outputTokens: 4_800 },
              durationMs: 14 * MINUTE,
            }
          : null,
      error: request.attempt === "failed" ? "`pnpm test` timed out after 20 minutes." : null,
      createdAt: created,
      startedAt: request.attempt === "queued" ? null : new Date(created.getTime() + 30_000),
      finishedAt: done ? finishedAt : null,
    });
    if (fromChat) {
      await tx.insert(chatThreadRuns).values({
        id: fixtureId("chatThreadRun", request.n),
        organizationId: O.main,
        chatThreadId: request.chatThreadId!,
        kind: "coding",
        ralphRunId: request.id,
        createdAt: created,
      });
    }
  }
}

// ── Reviews ─────────────────────────────────────────────────────────────────

const PR_TITLES = [
  "Add rate limiting to the webhook endpoints",
  "Refactor the job claim query",
  "Fix flaky agent heartbeat test",
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
    path: "src/screens/repos/repos-view.tsx",
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
  [R.agent]: "deep",
  [R.platformApi]: "quick",
  [R.legacy]: "standard",
};

async function seedReviews(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const repos = [R.controlPanel, R.agent, R.platformApi, R.legacy];
  const agentCycle = [H.online, H.online, H.updating, H.outdated, H.offline];

  let findingN = 0;
  let feedbackN = 0;
  // Spread over 40 days (a few fall outside the 30-day default window), newest first.
  const COUNT = 48;
  for (let i = 0; i < COUNT; i++) {
    const n = i + 1;
    const featured = n === 1;
    // The first two review the PR and the MR waiting in the Inbox.
    const mergeRequest = n === 2;
    const repositoryId = featured
      ? R.controlPanel
      : mergeRequest
        ? R.platformApi
        : repos[i % repos.length]!;
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
    const prNumber = featured
      ? FEATURED_PR
      : mergeRequest
        ? MERGE_REQUEST_IID
        : 300 + ((i * 7) % 60);
    const agentId = status === "queued" ? null : agentCycle[i % agentCycle.length]!;
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
      error: status === "failed" ? "The agent lost its session (exit code 137)." : null,
      createdAt,
      // A finished run last changed when its job finished, so the Inbox's "Failed … ago"
      // matches the attempt's date in Activity.
      updatedAt: done ? new Date(createdAt.getTime() + 4 * MINUTE) : createdAt,
    });
    await tx.insert(jobs).values({
      id: jobId,
      organizationId: O.main,
      type: "review.task",
      taskType: "review",
      taskId: "builtin:review-pr",
      payload: { prNumber },
      reviewRunId,
      status:
        status === "budget_exhausted" ? "completed" : status === "skipped" ? "skipped" : status,
      repositoryId,
      agentId: agentId,
      deliveryCount: agentId ? 1 : 0,
      leaseExpiresAt: status === "running" ? new Date(now.getTime() + 5 * MINUTE) : null,
      error: status === "failed" ? "The agent lost its session (exit code 137)." : null,
      result:
        done && status !== "failed"
          ? { usage: { inputTokens: tokensIn, outputTokens: tokensOut } }
          : null,
      createdAt,
      startedAt: agentId ? new Date(createdAt.getTime() + 20_000) : null,
      finishedAt: done ? new Date(createdAt.getTime() + 4 * MINUTE) : null,
    });
    await tx.insert(reviews).values({
      id: reviewId,
      reviewRunId,
      taskId: "builtin:review-pr",
      repositoryId,
      prNumber,
      prTitle: featured
        ? "Show agent capacity on Fleet"
        : mergeRequest
          ? "Retry failed deliveries from the log"
          : PR_TITLES[i % PR_TITLES.length]!,
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
      agentId: agentId,
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
          ? "The agent lost its session (exit code 137)."
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
        summary: "Om ran out of its token budget before the PRD was done. Retry the triage.",
        error: "Om ran out of its token budget before the PRD was done. Retry the triage.",
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
    {
      // FIX-101 (on the Backlog) as a PRD with no open questions, not started since.
      id: T.prdReady,
      organizationId: O.main,
      linearIssueId: "fixture-issue-fix-101",
      linearAgentSessionId: "fixture-session-triage-4",
      trigger: "label",
      status: "completed",
      lastResult: {
        summary: "Rewrote **FIX-101** as a PRD (size M). It's ready to start.",
        error: null,
        outcome: {
          outcome: "prd",
          size: "M",
          title: "Export runs as CSV",
          description: [
            "## Introduction",
            "",
            "Members want the Runs list in a spreadsheet: one row per run, with its repo, status and duration.",
          ].join("\n"),
          openQuestions: [],
          stories: [
            {
              title: "Export the filtered list",
              body: "As a member, I want to download the runs I filtered as CSV.\n\n## Acceptance Criteria\n\n- [ ] The Runs list has an Export action",
              priority: 2,
              dependsOn: [],
              manual: false,
            },
          ],
          subIssueUpdates: [],
        },
        usage,
        durationMs: 2 * MINUTE + 40_000,
      },
      createdAt: ago(6 * HOUR),
      updatedAt: ago(6 * HOUR - 4 * MINUTE),
    },
    {
      // Waiting for an agent: FIX-102 shows as being triaged on the Backlog.
      id: T.queued,
      organizationId: O.main,
      linearIssueId: "fixture-issue-fix-102",
      linearAgentSessionId: "fixture-session-triage-5",
      trigger: "mention",
      status: "queued",
      createdAt: ago(MINUTE),
      updatedAt: ago(MINUTE),
    },
    {
      id: T.stopped,
      organizationId: O.main,
      linearIssueId: "fixture-issue-triage-6",
      linearAgentSessionId: "fixture-session-triage-6",
      trigger: "label",
      status: "stopped",
      createdAt: ago(3 * DAY),
      updatedAt: ago(3 * DAY - 2 * MINUTE),
    },
  ]);

  const firstJob = nextJobId();
  const replyJob = nextJobId();
  const failedJob = FIXTURE_IDS.jobs.failedTriage;
  const runningJob = nextJobId();
  const prdReadyJob = FIXTURE_IDS.jobs.prdReadyTriage;
  const queuedJob = fixedJobId(3);
  const stoppedJob = fixedJobId(4);
  const query = {
    organizationId: O.main,
    type: "triage.run",
    taskType: "query",
  } as const;
  await tx.insert(jobs).values([
    {
      ...query,
      id: firstJob,
      triageRunId: T.completed,
      payload: triagePayload(T.completed, "FIX-310", "CSV export of findings", { branch: "main" }),
      status: "completed",
      repositoryId: R.controlPanel,
      agentId: H.online,
      deliveryCount: 1,
      createdAt: ago(2 * DAY + 30 * MINUTE),
      startedAt: ago(2 * DAY + 29 * MINUTE),
      finishedAt: ago(2 * DAY + 25 * MINUTE),
    },
    {
      ...query,
      id: replyJob,
      triageRunId: T.completed,
      payload: triagePayload(T.completed, "FIX-310", "CSV export of findings", {
        branch: "main",
        reply: "Make it an epic: the docs need their own story.",
      }),
      status: "completed",
      repositoryId: R.controlPanel,
      agentId: H.online,
      deliveryCount: 1,
      createdAt: ago(2 * DAY - 35 * MINUTE),
      startedAt: ago(2 * DAY - 36 * MINUTE),
      finishedAt: ago(2 * DAY - 40 * MINUTE),
    },
    {
      ...query,
      id: failedJob,
      triageRunId: T.failed,
      payload: triagePayload(T.failed, "FIX-322", "Faster agent startup"),
      // Its result had no PRD, so applying it failed the job (as `applyTriageJob` does).
      status: "failed",
      error: "Om ran out of its token budget before the PRD was done. Retry the triage.",
      agentId: H.online,
      deliveryCount: 1,
      createdAt: ago(5 * HOUR),
      startedAt: ago(5 * HOUR - MINUTE),
      finishedAt: ago(5 * HOUR - 10 * MINUTE),
    },
    {
      ...query,
      id: runningJob,
      triageRunId: T.running,
      payload: triagePayload(T.running, "FIX-331", "GitLab merge request templates", {
        branch: "main",
      }),
      status: "running",
      repositoryId: R.controlPanel,
      agentId: H.online,
      deliveryCount: 1,
      leaseExpiresAt: new Date(now.getTime() + 10 * MINUTE),
      createdAt: ago(4 * MINUTE),
      startedAt: ago(3 * MINUTE),
    },
    {
      ...query,
      id: prdReadyJob,
      triageRunId: T.prdReady,
      payload: triagePayload(T.prdReady, "FIX-101", "Export runs as CSV", { branch: "main" }),
      status: "completed",
      repositoryId: R.controlPanel,
      agentId: H.online,
      deliveryCount: 1,
      createdAt: ago(6 * HOUR),
      startedAt: ago(6 * HOUR - 20_000),
      finishedAt: ago(6 * HOUR - 4 * MINUTE),
    },
    {
      ...query,
      id: queuedJob,
      triageRunId: T.queued,
      payload: triagePayload(T.queued, "FIX-102", "Explain why a review was skipped"),
      status: "queued",
      createdAt: ago(MINUTE),
    },
    {
      ...query,
      id: stoppedJob,
      triageRunId: T.stopped,
      payload: triagePayload(T.stopped, "FIX-340", "Group findings by file"),
      status: "canceled",
      agentId: H.online,
      deliveryCount: 1,
      cancelRequested: true,
      createdAt: ago(3 * DAY),
      startedAt: ago(3 * DAY - 10_000),
      finishedAt: ago(3 * DAY - 2 * MINUTE),
    },
  ]);
  await tx
    .update(triageRuns)
    .set({ currentJobId: runningJob })
    .where(sql`${triageRuns.id} = ${T.running}`);
  await tx
    .update(triageRuns)
    .set({ currentJobId: queuedJob })
    .where(sql`${triageRuns.id} = ${T.queued}`);

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
      targetAgentId: H.online,
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
      error: "No agent claimed the job within 24 hours.",
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
      repositoryId: R.agent,
      agentId: H.offline,
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
      agentId: H.online,
      targetAgentId: H.online,
      createdAt: ago(5 * HOUR),
      startedAt: ago(5 * HOUR),
      finishedAt: ago(5 * HOUR - MINUTE),
    },
  ]);
}

// ── Inbox: Done and Snooze ──────────────────────────────────────────────────

/** Both users snoozed the failed triage run until a day after seeding. */
async function seedInboxStates(tx: Tx, now: Date): Promise<void> {
  await tx.insert(inboxItemStates).values(
    [U.admin, U.member].map((userId) => ({
      userId,
      organizationId: O.main,
      itemKey: FIXTURE_INBOX_KEYS.snoozed,
      state: "snoozed" as const,
      snoozedUntil: new Date(now.getTime() + DAY),
      updatedAt: new Date(now.getTime() - HOUR),
    })),
  );
}

// ── Webhook deliveries ──────────────────────────────────────────────────────

/** The delivery log: every outcome on the GitHub connection (and a replay), and a few others. */
async function seedWebhookEvents(tx: Tx, now: Date): Promise<void> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const W = FIXTURE_IDS.webhookEvents;
  const github = { organizationId: O.main, provider: "github" as const };
  const pullRequest = (action: string, number: number) => ({
    action,
    number,
    pull_request: { number, title: "Show agent capacity on Fleet", draft: false },
    repository: { full_name: "fixture-labs/control-panel" },
  });
  await tx.insert(webhookEvents).values([
    {
      ...github,
      id: W.startedRun,
      scmConnectionId: FIXTURE_IDS.scmConnections.github,
      repositoryId: R.controlPanel,
      deliveryId: "fixture-delivery-1",
      event: "pull_request.opened",
      payload: pullRequest("opened", FEATURED_PR),
      outcome: "started_run",
      runId: FIXTURE_IDS.reviewRuns.pullRequest,
      runKind: "review",
      receivedAt: ago(3 * HOUR),
    },
    {
      ...github,
      id: W.updatedRun,
      scmConnectionId: FIXTURE_IDS.scmConnections.github,
      repositoryId: R.controlPanel,
      deliveryId: "fixture-delivery-2",
      event: "pull_request_review.submitted",
      payload: pullRequest("submitted", FEATURED_PR),
      outcome: "updated_run",
      runId: RR.pullRequestWaiting,
      runKind: "epic",
      receivedAt: ago(3 * HOUR - 20 * MINUTE),
    },
    {
      ...github,
      id: W.ignored,
      scmConnectionId: FIXTURE_IDS.scmConnections.github,
      repositoryId: R.docs,
      deliveryId: "fixture-delivery-3",
      event: "pull_request.opened",
      payload: { ...pullRequest("opened", 12), repository: { full_name: "fixture-labs/docs" } },
      outcome: "ignored",
      reasonCode: "repository_disabled",
      reason: "Reviews are off for fixture-labs/docs.",
      receivedAt: ago(2 * HOUR),
    },
    {
      ...github,
      id: W.failed,
      scmConnectionId: FIXTURE_IDS.scmConnections.github,
      repositoryId: R.agent,
      deliveryId: "fixture-delivery-4",
      event: "pull_request.synchronize",
      payload: {
        ...pullRequest("synchronize", 88),
        repository: { full_name: "fixture-labs/agent" },
      },
      outcome: "failed",
      reasonCode: "handler_failed",
      reason: "The database didn't answer in time.",
      receivedAt: ago(90 * MINUTE),
    },
    {
      ...github,
      id: W.duplicate,
      scmConnectionId: FIXTURE_IDS.scmConnections.github,
      repositoryId: R.controlPanel,
      deliveryId: "fixture-delivery-1",
      event: "pull_request.opened",
      payload: pullRequest("opened", FEATURED_PR),
      outcome: "duplicate",
      receivedAt: ago(3 * HOUR - MINUTE),
    },
    {
      ...github,
      id: W.replay,
      scmConnectionId: FIXTURE_IDS.scmConnections.github,
      repositoryId: R.agent,
      deliveryId: "fixture-delivery-4",
      event: "pull_request.synchronize",
      // Over the size limit: kept without its body.
      payload: null,
      payloadTruncated: true,
      outcome: "started_run",
      runId: fixtureId("reviewRun", 5),
      runKind: "review",
      replayOfId: W.failed,
      replayedBy: U.admin,
      receivedAt: ago(80 * MINUTE),
    },
    {
      organizationId: O.main,
      provider: "gitlab",
      id: fixtureId("webhookEvent", 7),
      scmConnectionId: FIXTURE_IDS.scmConnections.gitlab,
      repositoryId: R.platformApi,
      deliveryId: "fixture-delivery-gitlab-1",
      event: "merge_request.open",
      payload: {
        object_kind: "merge_request",
        object_attributes: { iid: MERGE_REQUEST_IID, action: "open" },
      },
      outcome: "started_run",
      runId: FIXTURE_IDS.reviewRuns.mergeRequest,
      runKind: "review",
      receivedAt: ago(5 * HOUR),
    },
    {
      organizationId: O.main,
      provider: "linear",
      id: fixtureId("webhookEvent", 8),
      integrationId: FIXTURE_IDS.integrations.linear,
      deliveryId: "fixture-delivery-linear-1",
      event: "AgentSessionEvent.created",
      payload: { type: "AgentSessionEvent", action: "created" },
      outcome: "started_run",
      runId: RR.running,
      runKind: "epic",
      receivedAt: ago(2 * DAY),
    },
    {
      organizationId: O.main,
      provider: "linear",
      id: fixtureId("webhookEvent", 9),
      integrationId: FIXTURE_IDS.integrations.linear,
      deliveryId: "fixture-delivery-linear-2",
      event: "Issue.update",
      payload: { type: "Issue", action: "update" },
      outcome: "ignored",
      reasonCode: "no_run",
      reason: "No run is working on this work item.",
      receivedAt: ago(40 * MINUTE),
    },
  ]);
}
