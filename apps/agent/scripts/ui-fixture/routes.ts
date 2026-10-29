/**
 * Every screen of the agent page that `verify:screens` captures against the fixture
 * (`fixture.ts`), with the same fields as the panel's `apps/web/scripts/screens/routes.ts`.
 * `serve.ts` hands them to `verify:screens`, which captures them like the panel's.
 */
import { FIXTURE_ATTEMPTS, FIXTURE_INSTALLS, FIXTURE_MISSING_HOST_TOOL } from "./fixture.js";

export interface AgentScreenRoute {
  /** File-name-safe name of the screenshot; every one starts with `agent-`. */
  name: string;
  /** The URL path to open. */
  path: string;
  /** The page component it renders (relative to `apps/agent/ui/src`). */
  page: string;
  /**
   * CSS selectors to wait for, in order: the page renders nothing while its data loads (no
   * skeleton), so each names content that only shows once it has.
   */
  waitFor: readonly string[];
  /** Interactions before the screenshot, in order. */
  steps?: readonly (
    | { action: "fill"; selector: string; value: string }
    | { action: "click"; selector: string }
  )[];
  /** Screenshot only the viewport (e.g. an open sheet). */
  viewportOnly?: boolean;
  /** Only these viewports. */
  viewports?: readonly ("desktop" | "rail" | "phone")[];
  /**
   * A detail view (an attempt): its header must hold a toolbar of icon buttons, and its phone
   * Details load collapsed (`verify:screens`' Decided checks).
   */
  detail?: true;
}

/** The section nav, with the state's problem dot (Host tools: terraform is missing). */
const NAV = ".or-subnav";
/**
 * A shown row of a `DataTable` with `text`: its table and its cards (phone) are both in the
 * page, and the width decides which one shows.
 */
const row = (text: string) => `:is(.or-tbl__row, .or-cardrow):has-text("${text}"):visible`;
/** Opens the attempt's Log (collapsed by default). */
const OPEN_LOG = { action: "click", selector: ".or-more-info__summary" } as const;

export const AGENT_SCREEN_ROUTES: readonly AgentScreenRoute[] = [
  // `/`: Overview beside the nav when both fit; the section list alone on a phone.
  {
    name: "agent-index",
    path: "/",
    page: "shell.tsx",
    waitFor: [NAV, ".agent-topbar__facts"],
  },
  {
    name: "agent-overview",
    path: "/overview",
    page: "pages/overview/overview-page.tsx",
    waitFor: ['[aria-label="Summary"]', '[aria-label="Running now"]', '[aria-label="Recent work"]'],
  },
  {
    name: "agent-attempt-running",
    detail: true,
    path: `/attempts/${FIXTURE_ATTEMPTS.runningStory}`,
    page: "pages/overview/attempt-page.tsx",
    waitFor: ['[aria-label="Transcript"]', ".or-more-info__summary"],
    // The live tail: the transcript so far and the attempt's log lines.
    steps: [OPEN_LOG],
  },
  {
    name: "agent-attempt-failed",
    detail: true,
    path: `/attempts/${FIXTURE_ATTEMPTS.failedStory}`,
    page: "pages/overview/attempt-page.tsx",
    waitFor: ['[aria-label="Transcript"]', ".or-more-info__summary"],
  },
  {
    name: "agent-logs",
    path: "/logs",
    page: "pages/logs/logs-page.tsx",
    waitFor: [".agent-logs__list"],
  },
  {
    name: "agent-capacity",
    path: "/capacity",
    page: "pages/capacity/capacity-page.tsx",
    waitFor: [".agent-checks"],
  },
  {
    name: "agent-packages",
    path: "/packages",
    page: "pages/packages/packages-page.tsx",
    waitFor: [row("@acme/deploy-tools"), row("@acme/lint-rules")],
  },
  {
    name: "agent-packages-install-failed",
    path: `/packages/history/${FIXTURE_INSTALLS.failed}`,
    page: "pages/packages/packages-page.tsx",
    waitFor: [".agent-install-output .agent-output"],
    viewportOnly: true,
  },
  {
    name: "agent-host-tools",
    path: "/host-tools",
    page: "pages/host-tools/host-tools-page.tsx",
    waitFor: [row(FIXTURE_MISSING_HOST_TOOL), ".agent-paths"],
  },
  {
    name: "agent-version",
    path: "/version",
    page: "pages/version/version-page.tsx",
    waitFor: ['[aria-label="Version summary"]', '[aria-label="Failed versions"]'],
  },
  {
    name: "agent-claude",
    path: "/claude",
    page: "pages/claude/claude-page.tsx",
    waitFor: [".agent-claude__headline", '[aria-label="Models"]'],
  },
  {
    name: "agent-storage",
    path: "/storage",
    page: "pages/storage/storage-page.tsx",
    waitFor: ['[aria-label="Free space"]', row("Repo cache"), row("acme/docs-site")],
  },
  {
    name: "agent-not-found",
    path: "/no-such-page",
    page: "pages/routes.tsx",
    waitFor: [".or-empty__title"],
  },
];
