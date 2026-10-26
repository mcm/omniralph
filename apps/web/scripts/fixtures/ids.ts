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
  hostTool: 0x0f6,
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
} as const;

/** The fixture UUID `n` of a kind of row. */
export function fixtureId(kind: keyof typeof KINDS, n: number): string {
  const prefix = KINDS[kind].toString(16).padStart(8, "0");
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const FIXTURE_IDS = {
  users: {
    admin: "fixture-user-admin",
    member: "fixture-user-member",
  },
  organizations: {
    main: fixtureId("organization", 1),
    /** A second organization the admin is a member of (the organization switcher). */
    sandbox: fixtureId("organization", 2),
  },
  scmConnections: {
    github: fixtureId("scmConnection", 1),
    gitlab: fixtureId("scmConnection", 2),
  },
  repositories: {
    controlPanel: fixtureId("repository", 1),
    agent: fixtureId("repository", 2),
    platformApi: fixtureId("repository", 3),
    /** Connected but not enabled. */
    docs: fixtureId("repository", 4),
    /** Disconnected: hidden from the list, its history kept. */
    legacy: fixtureId("repository", 5),
  },
  integrations: { linear: fixtureId("integration", 1) },
  agents: {
    online: fixtureId("agent", 1),
    offline: fixtureId("agent", 2),
    outdated: fixtureId("agent", 3),
    updating: fixtureId("agent", 4),
    revoked: fixtureId("agent", 5),
  },
  ralphRuns: {
    running: fixtureId("ralphRun", 1),
    waitingOnManual: fixtureId("ralphRun", 2),
    completed: fixtureId("ralphRun", 3),
    failed: fixtureId("ralphRun", 4),
    stopped: fixtureId("ralphRun", 5),
    pending: fixtureId("ralphRun", 6),
  },
  triageRuns: {
    /** An epic PRD with stories and an open question, after a reply. */
    completed: fixtureId("triageRun", 1),
    failed: fixtureId("triageRun", 2),
    running: fixtureId("triageRun", 3),
  },
  /** A custom playbook (built-ins are read-only). */
  playbooks: {
    custom: fixtureId("playbook", 1),
  },
  reviews: {
    /** Completed, with findings in every severity and status (open, dismissed, restored, …). */
    featured: fixtureId("review", 1),
  },
} as const;

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
