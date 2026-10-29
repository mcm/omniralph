/**
 * Stable IDs of the fixture database, so screenshot routes can name detail
 * pages (e.g. `/runs/${FIXTURE_IDS.ralphRuns.running}`). Every UUID is
 * `<kind>-0000-4000-8000-<n>`: obviously fake, and the same on every seed.
 */

const KINDS = {
  organization: 0x0f1,
  scmConnection: 0x0f2,
  repository: 0x0f3,
  integration: 0x0f4,
  agent: 0x0f5,
  agentAudit: 0x0f7,
  invitation: 0x0f8,
  ralphRun: 0x0f9,
  ralphLane: 0x0fa,
  ralphStory: 0x0fb,
  ralphMessage: 0x0fc,
  job: 0x0fd,
  reviewRun: 0x0fe,
  review: 0x0ff,
  finding: 0x100,
  feedback: 0x101,
  rule: 0x102,
  pin: 0x103,
  playbook: 0x104,
  triageRun: 0x106,
  runActivity: 0x107,
  chatConnection: 0x108,
  chatThread: 0x109,
  chatWebMessage: 0x10a,
  chatThreadRun: 0x10b,
  chatRequestDraft: 0x10c,
  webhookEvent: 0x10d,
} as const;

/** The fixture UUID `n` of a kind of row. */
export function fixtureId(kind: keyof typeof KINDS, n: number): string {
  const prefix = KINDS[kind].toString(16).padStart(8, "0");
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * The job (attempt) `attempt` of the story at `position` of the epic run numbered `run` in
 * the seed: fixed, so attempt pages can be named.
 */
export function storyAttemptId(run: number, position: number, attempt: number): string {
  return fixtureId("job", 0x10000 + run * 0x100 + position * 0x10 + attempt);
}

/** The fixture ID of the story at `position` of the epic run numbered `run` in the seed. */
export function storyId(run: number, position: number): string {
  return fixtureId("ralphStory", run * 100 + position);
}

/** The ralph lane of the run numbered `run` in the seed. */
export function laneId(run: number): string {
  return fixtureId("ralphLane", run);
}

/** A job with a fixed ID (`0x20000` up): attempts of triage, ask and request runs. */
export function fixedJobId(n: number): string {
  return fixtureId("job", 0x20000 + n);
}
const job = fixedJobId;

export const FIXTURE_IDS = {
  users: {
    admin: "fixture-user-admin",
    member: "fixture-user-member",
  },
  organizations: {
    main: fixtureId("organization", 1),
    /**
     * A second organization both users belong to ("All organizations", the switcher). Its
     * Inbox is empty and its Backlog isn't (board InboxEmpty: the empty Inbox shows Up next).
     */
    sandbox: fixtureId("organization", 2),
  },
  scmConnections: {
    github: fixtureId("scmConnection", 1),
    gitlab: fixtureId("scmConnection", 2),
    /** The sandbox organization's GitHub connection. */
    sandboxGithub: fixtureId("scmConnection", 3),
  },
  repositories: {
    controlPanel: fixtureId("repository", 1),
    agent: fixtureId("repository", 2),
    platformApi: fixtureId("repository", 3),
    /** Reviews, Coding and Ask off, and no work item match. */
    docs: fixtureId("repository", 4),
    /** Disconnected: hidden from the list, its history kept. */
    legacy: fixtureId("repository", 5),
    /** The sandbox organization's one repo (Coding on, matching its SBX team). */
    sandboxPlayground: fixtureId("repository", 6),
  },
  integrations: {
    linear: fixtureId("integration", 1),
    /** The sandbox organization's Linear workspace (`FIXTURE_SANDBOX_LINEAR_TOKEN`). */
    sandboxLinear: fixtureId("integration", 2),
  },
  agents: {
    online: fixtureId("agent", 1),
    offline: fixtureId("agent", 2),
    outdated: fixtureId("agent", 3),
    updating: fixtureId("agent", 4),
    revoked: fixtureId("agent", 5),
  },
  /** Epic runs (`ralph_runs` of mode `epic`). */
  ralphRuns: {
    /** Stories in every status, one with three attempts, a transcript and a diff. */
    running: fixtureId("ralphRun", 1),
    waitingOnManual: fixtureId("ralphRun", 2),
    completed: fixtureId("ralphRun", 3),
    failed: fixtureId("ralphRun", 4),
    stopped: fixtureId("ralphRun", 5),
    /** Asks which repo to build in (routing found none). */
    pending: fixtureId("ralphRun", 6),
    /** Its GitHub pull request waits on a person, with the AI review's open findings. */
    pullRequestWaiting: fixtureId("ralphRun", 7),
    /** Its GitLab merge request waits on a person, with a clean AI review. */
    mergeRequestWaiting: fixtureId("ralphRun", 8),
  },
  /** Request runs (`ralph_runs` of mode `request`), one per status. */
  requestRuns: {
    queued: fixtureId("ralphRun", 21),
    running: fixtureId("ralphRun", 22),
    waiting: fixtureId("ralphRun", 23),
    /** Started from the admin's control panel chat. */
    completed: fixtureId("ralphRun", 24),
    failed: fixtureId("ralphRun", 25),
    stopped: fixtureId("ralphRun", 26),
  },
  /** Stories of the running epic. */
  stories: {
    /** Completed after three attempts, with a commit (the Diff tab). */
    severalAttempts: storyId(1, 1),
    /** Its attempt is running, with a transcript. */
    running: storyId(1, 2),
  },
  /** Attempts with a transcript (`run_activities`). */
  attempts: {
    /** The third and last attempt of `stories.severalAttempts`. */
    completedWithTranscript: storyAttemptId(1, 1, 3),
    /** The running attempt of `stories.running`. */
    runningWithTranscript: storyAttemptId(1, 2, 1),
  },
  triageRuns: {
    /** An epic PRD with stories and an open question, after a reply. */
    completed: fixtureId("triageRun", 1),
    failed: fixtureId("triageRun", 2),
    running: fixtureId("triageRun", 3),
    /** FIX-101's PRD with no open questions, nothing started since: "PRD ready". */
    prdReady: fixtureId("triageRun", 4),
    queued: fixtureId("triageRun", 5),
    stopped: fixtureId("triageRun", 6),
  },
  /** Review runs (PR/MR reviews), by what they review. */
  reviewRuns: {
    /** PR #421 of `ralphRuns.pullRequestWaiting`: the featured review. */
    pullRequest: fixtureId("reviewRun", 1),
    /** MR !58 of `ralphRuns.mergeRequestWaiting`. */
    mergeRequest: fixtureId("reviewRun", 2),
  },
  /** Ask runs (`chat_thread_runs` of kind `query`), one per status. */
  askRuns: {
    /** Om's answer in `askChats.controlPanel`. */
    completed: fixtureId("chatThreadRun", 1),
    /** Om's answer in `askChats.requestDraft`, which drafted a request. */
    drafted: fixtureId("chatThreadRun", 2),
    running: fixtureId("chatThreadRun", 3),
    queued: fixtureId("chatThreadRun", 4),
    failed: fixtureId("chatThreadRun", 5),
    stopped: fixtureId("chatThreadRun", 6),
    skipped: fixtureId("chatThreadRun", 7),
  },
  /** A custom playbook (built-ins are read-only). */
  playbooks: {
    custom: fixtureId("playbook", 1),
  },
  reviews: {
    /** Completed, with findings in every severity and status (open, dismissed, restored, …). */
    featured: fixtureId("review", 1),
  },
  /** The admin's web chats (Ask). */
  askChats: {
    /** About the control panel, with a question and Om's answer. */
    controlPanel: fixtureId("chatThread", 1),
    /** Om answered with a drafted Request (Start request, Add to backlog, Not now). */
    requestDraft: fixtureId("chatThread", 2),
    /** Om is answering (streaming). */
    answering: fixtureId("chatThread", 3),
    /** Waiting for an agent to take the question. */
    waiting: fixtureId("chatThread", 4),
    /** Older questions whose ask runs failed, were stopped and were skipped. */
    older: fixtureId("chatThread", 5),
  },
  requestDrafts: {
    /** Pending, in `askChats.requestDraft`. */
    pending: fixtureId("chatRequestDraft", 1),
  },
  /** Attempts other than story attempts. */
  jobs: {
    failedTriage: job(1),
    prdReadyTriage: job(2),
  },
  /**
   * What each Inbox item is about (main organization). The sandbox organization has none.
   */
  inbox: {
    manualStory: storyId(2, 1),
    stoppedEpic: fixtureId("ralphRun", 5),
    prdReady: fixtureId("triageRun", 4),
    pullRequest: laneId(7),
    mergeRequest: laneId(8),
    failedRun: fixtureId("ralphRun", 4),
    offlineAgent: fixtureId("agent", 2),
    /** The run whose question (which repo?) is open. */
    question: fixtureId("ralphRun", 6),
    /** The failed triage run, snoozed by both users. */
    snoozed: fixtureId("triageRun", 2),
  },
  /** The settings delivery log (`webhook_events`) of the GitHub connection, one per outcome. */
  webhookEvents: {
    startedRun: fixtureId("webhookEvent", 1),
    updatedRun: fixtureId("webhookEvent", 2),
    ignored: fixtureId("webhookEvent", 3),
    failed: fixtureId("webhookEvent", 4),
    duplicate: fixtureId("webhookEvent", 5),
    /** A replay of `failed`, which started a run. */
    replay: fixtureId("webhookEvent", 6),
  },
} as const;

/** Inbox item keys the seed fixes (`packages/db/src/inbox.ts` derives them). */
export const FIXTURE_INBOX_KEYS = {
  manualStory: `manual_story:${FIXTURE_IDS.inbox.manualStory}`,
  pullRequest: `pr:${FIXTURE_IDS.inbox.pullRequest}:changes_requested`,
  mergeRequest: `pr:${FIXTURE_IDS.inbox.mergeRequest}:approved`,
  prdReady: `prd_ready:${FIXTURE_IDS.inbox.prdReady}:${FIXTURE_IDS.jobs.prdReadyTriage}`,
  /** Snoozed by both users until a day after seeding. */
  snoozed: `failed:${FIXTURE_IDS.inbox.snoozed}:${FIXTURE_IDS.jobs.failedTriage}`,
} as const;

/**
 * The sandbox organization's Linear access token: the fixture gateway
 * (`src/lib/linear/fixture-gateway.ts`) answers with the sandbox workspace for it.
 */
export const FIXTURE_SANDBOX_LINEAR_TOKEN = "fixture-linear-sandbox-token-not-real";

/**
 * Review links of FIX-101 (`/share/{token}`): 43-character tokens like real ones. The
 * protected one opens with `FIXTURE_SHARE_PASSWORD`.
 */
export const FIXTURE_SHARE_TOKENS = {
  open: "fixture-share-open-token-not-a-secret-00000",
  protected: "fixture-share-lock-token-not-a-secret-00000",
} as const;
export const FIXTURE_SHARE_PASSWORD = "fixture-password";

/** Sign in as these with the dev sign-in (`/sign-in/dev?email=…`). */
export const FIXTURE_EMAILS = {
  admin: "admin@fixtures.example",
  member: "member@fixtures.example",
} as const;
