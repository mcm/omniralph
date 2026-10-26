// Repos for the Repos screen's tests, as `GET /api/ui/repositories` and `/{id}` answer them.
import { TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type {
  RepositoryDetail,
  RepositoryListItem,
  ReviewDepthOption,
} from "@/lib/api/repositories";

export const BETA_ID = "22222222-2222-4222-8222-222222222222";
export const REPO_PORTAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const REPO_WEB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const REPO_BETA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

const ACME = { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" as const };
const BETA = { id: BETA_ID, name: "Beta", role: "member" as const };

/** Acme's GitLab `managed-services/customer-portal`: Reviews and Ask on, Coding off, idle. */
export function portalRow(overrides: Partial<RepositoryListItem> = {}): RepositoryListItem {
  return {
    id: REPO_PORTAL,
    organization: ACME,
    provider: "gitlab",
    fullPath: "managed-services/customer-portal",
    name: "customer-portal",
    group: "managed-services",
    webUrl: "https://gitlab.com/managed-services/customer-portal",
    reviewsEnabled: true,
    codingEnabled: false,
    askEnabled: true,
    status: { running: 0, problems: [] },
    ...overrides,
  };
}

/** Acme's GitHub `acme/web`: everything on, two runs running. */
export function webRow(overrides: Partial<RepositoryListItem> = {}): RepositoryListItem {
  return portalRow({
    id: REPO_WEB,
    provider: "github",
    fullPath: "acme/web",
    name: "web",
    group: "acme",
    webUrl: "https://github.com/acme/web",
    reviewsEnabled: true,
    codingEnabled: true,
    askEnabled: true,
    status: { running: 2, problems: [] },
    ...overrides,
  });
}

/** Beta's GitHub `beta/api` (the user is a member there): everything off, no group. */
export function betaRow(overrides: Partial<RepositoryListItem> = {}): RepositoryListItem {
  return portalRow({
    id: REPO_BETA,
    organization: BETA,
    provider: "github",
    fullPath: "api",
    name: "api",
    group: null,
    webUrl: "https://github.com/api",
    reviewsEnabled: false,
    codingEnabled: false,
    askEnabled: false,
    ...overrides,
  });
}

/** Every review depth, as the detail lists them (`REVIEW_DEPTHS`). */
export const DEPTHS: ReviewDepthOption[] = [
  {
    id: "quick",
    label: "Quick",
    summary: "Reads only the change and flags clear problems. Fastest and cheapest.",
    details: {
      model: "Haiku 5.5",
      tokenCap: "60k per review",
      reads: "The diff only",
      comments: "Inline findings plus a summary",
      typicalTime: "Shortest",
    },
  },
  {
    id: "standard",
    label: "Standard",
    summary: "Reads the change and the code around it. The default.",
    details: {
      model: "Sonnet 5.5",
      tokenCap: "200k per review",
      reads: "The diff and nearby files",
      comments: "Inline findings plus a summary",
      typicalTime: "Baseline",
    },
  },
  {
    id: "deep",
    label: "Deep",
    summary: "Explores the repo to check the change against the code it touches.",
    details: {
      model: "Opus 5.5",
      tokenCap: "500k per review",
      reads: "The diff and the whole repo",
      comments: "Inline findings plus a summary",
      typicalTime: "About 2× Standard",
    },
  },
];

/** The detail of `row` (the portal by default), as an admin of its organization sees it. */
export function repoDetail(
  row: RepositoryListItem = portalRow(),
  overrides: Partial<RepositoryDetail> & {
    defaultBranch?: string | null;
  } = {},
): RepositoryDetail {
  const { defaultBranch = "main", ...rest } = overrides;
  return {
    repository: {
      id: row.id,
      organization: row.organization,
      provider: row.provider,
      fullPath: row.fullPath,
      name: row.name,
      group: row.group,
      webUrl: row.webUrl,
      defaultBranch,
    },
    canEdit: row.organization.role === "admin",
    status: row.status,
    reviews: {
      enabled: row.reviewsEnabled,
      triggers: { onOpen: true, onPush: true, drafts: false },
      depth: "standard",
      pathExcludes: [],
      reviewerInstructions: "",
    },
    depths: DEPTHS,
    coding: {
      enabled: row.codingEnabled,
      workItemMatch: null,
      codingInstructions: "",
      openPullRequestEarly: false,
      historyRewrite: "when-asked",
      respondToReviewsAndCi: true,
      roundLimits: { review: 3, fix: 3 },
      routingRules: [],
    },
    trackers: [],
    ask: { enabled: row.askEnabled },
    agents: { pinned: [], pinnable: [] },
    playbooks: {
      bindings: {
        review: ["builtin:review"],
        correlation: "builtin:correlate",
        story: "builtin:implement-story",
        request: "builtin:handle-request",
      },
      choices: { review: [], correlation: [], story: [], request: [] },
    },
    history: { reviews: null, coding: null, ask: null, agents: null, playbooks: null },
    ...rest,
  };
}
