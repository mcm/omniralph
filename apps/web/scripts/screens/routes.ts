import { FIXTURE_IDS } from "../fixtures/ids";

/**
 * One screen `verify:screens` captures. `page` is the `page.tsx` it renders
 * (relative to `src/app`), so a test can check every page is listed.
 */
export interface ScreenRoute {
  /** File-name-safe name of the screenshot, e.g. `ralph-run-running`. */
  name: string;
  /** The URL path (and query) to open. */
  path: string;
  page: string;
  /** `signed-out` screens are captured without a session. */
  auth: "signed-in" | "signed-out";
  /** Interactions before the screenshot, in order (to capture a state, e.g. an open dialog). */
  steps?: readonly ScreenStep[];
  /** Screenshot only the viewport (e.g. an open dialog), not the full page. */
  viewportOnly?: boolean;
}

/** One interaction: type into a field, or click an element (CSS selectors). */
export type ScreenStep =
  { action: "fill"; selector: string; value: string } | { action: "click"; selector: string };

const ids = FIXTURE_IDS;

/**
 * Every screen of the panel, with fixture IDs (`scripts/fixtures/ids.ts`) for
 * dynamic segments. A page may appear more than once to cover its states.
 */
export const SCREEN_ROUTES: readonly ScreenRoute[] = [
  // Signed-out shells.
  { name: "sign-in", path: "/sign-in", page: "(auth)/sign-in/page.tsx", auth: "signed-out" },
  { name: "privacy", path: "/privacy", page: "(legal)/privacy/page.tsx", auth: "signed-out" },
  { name: "terms", path: "/terms", page: "(legal)/terms/page.tsx", auth: "signed-out" },
  {
    name: "access-denied",
    path: "/access-denied",
    page: "(auth)/access-denied/page.tsx",
    auth: "signed-out",
  },
  // The onboarding and chat-link shells redirect to sign-in without a
  // session, so they are captured signed in (still outside the app shell).
  {
    name: "onboarding",
    path: "/onboarding",
    page: "(auth)/onboarding/page.tsx",
    auth: "signed-in",
  },
  {
    name: "chat-link",
    path: "/chat/link?state=fixture-unknown-state",
    page: "(auth)/chat/link/page.tsx",
    auth: "signed-in",
  },

  // The app.
  { name: "home", path: "/", page: "(app)/page.tsx", auth: "signed-in" },
  { name: "runs", path: "/runs", page: "(app)/runs/page.tsx", auth: "signed-in" },
  { name: "analytics", path: "/analytics", page: "(app)/analytics/page.tsx", auth: "signed-in" },
  { name: "jobs", path: "/jobs", page: "(app)/jobs/page.tsx", auth: "signed-in" },
  {
    // A `#job-<id>` link to a failed job: the highlight covers the job and its reason row.
    name: "jobs-targeted",
    path: "/jobs?status=failed",
    page: "(app)/jobs/page.tsx",
    auth: "signed-in",
    steps: [{ action: "click", selector: 'tr[data-has-error] a[href^="#job-"]' }],
    // What the link shows: the page scrolled to the row (a full page would draw the
    // sticky header over it).
    viewportOnly: true,
  },
  { name: "agents", path: "/agents", page: "(app)/agents/page.tsx", auth: "signed-in" },
  {
    name: "agent-online",
    path: `/agents/${ids.agents.online}`,
    page: "(app)/agents/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "agent-updating",
    path: `/agents/${ids.agents.updating}`,
    page: "(app)/agents/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "agent-revoked",
    path: `/agents/${ids.agents.revoked}`,
    page: "(app)/agents/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "agent-settings",
    path: `/agents/${ids.agents.online}/settings`,
    page: "(app)/agents/[id]/settings/page.tsx",
    auth: "signed-in",
  },
  {
    // One save for every setting of the agent, confirmed with the change list.
    name: "agent-settings-confirm",
    path: `/agents/${ids.agents.online}/settings`,
    page: "(app)/agents/[id]/settings/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#limit-short", value: "2" },
      { action: "click", selector: "#desired-version-source-override" },
      { action: "fill", selector: "#desired-version", value: "1.4.0" },
      { action: "click", selector: '#agent-settings [type="submit"]' },
    ],
    viewportOnly: true,
  },
  {
    name: "agent-settings-revoked",
    path: `/agents/${ids.agents.revoked}/settings`,
    page: "(app)/agents/[id]/settings/page.tsx",
    auth: "signed-in",
  },
  {
    name: "agent-installables",
    path: `/agents/${ids.agents.online}/installables`,
    page: "(app)/agents/[id]/installables/page.tsx",
    auth: "signed-in",
  },
  {
    name: "agent-host-tools",
    path: `/agents/${ids.agents.online}/host-tools`,
    page: "(app)/agents/[id]/host-tools/page.tsx",
    auth: "signed-in",
  },
  {
    // The save footer counts the changed paths.
    name: "agent-host-tools-unsaved",
    path: `/agents/${ids.agents.online}/host-tools`,
    page: "(app)/agents/[id]/host-tools/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: '[id^="host-tool-path-"]', value: "/opt/semgrep/bin/semgrep" },
    ],
    viewportOnly: true,
  },
  { name: "triage", path: "/triage", page: "(app)/triage/page.tsx", auth: "signed-in" },
  {
    name: "triage-run-completed",
    path: `/triage/${ids.triageRuns.completed}`,
    page: "(app)/triage/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "triage-run-failed",
    path: `/triage/${ids.triageRuns.failed}`,
    page: "(app)/triage/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "triage-run-running",
    path: `/triage/${ids.triageRuns.running}`,
    page: "(app)/triage/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repositories",
    path: "/repositories",
    page: "(app)/repositories/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repositories-github",
    path: `/repositories/github/${ids.scmConnections.github}`,
    page: "(app)/repositories/github/[connectionId]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repositories-gitlab",
    path: `/repositories/gitlab/${ids.scmConnections.gitlab}`,
    page: "(app)/repositories/gitlab/[connectionId]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repository-reviews",
    path: `/repositories/${ids.repositories.controlPanel}/reviews`,
    page: "(app)/repositories/[id]/reviews/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repository-rules",
    path: `/repositories/${ids.repositories.controlPanel}/rules`,
    page: "(app)/repositories/[id]/rules/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repository-settings",
    path: `/repositories/${ids.repositories.controlPanel}/settings`,
    page: "(app)/repositories/[id]/settings/page.tsx",
    auth: "signed-in",
  },
  {
    // Failed validation: the save footer counts the fields that need attention.
    name: "repository-settings-invalid",
    path: `/repositories/${ids.repositories.controlPanel}/settings`,
    page: "(app)/repositories/[id]/settings/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#path-excludes", value: "!*.snap" },
      { action: "click", selector: '#review-settings [type="submit"]' },
    ],
    viewportOnly: true,
  },
  {
    name: "repository-agents",
    path: `/repositories/${ids.repositories.controlPanel}/agents`,
    page: "(app)/repositories/[id]/agents/page.tsx",
    auth: "signed-in",
  },
  {
    // Pinned agents are picked from a searchable list.
    name: "repository-agents-picker",
    path: `/repositories/${ids.repositories.controlPanel}/agents`,
    page: "(app)/repositories/[id]/agents/page.tsx",
    auth: "signed-in",
    steps: [{ action: "click", selector: "#pinned-agents" }],
    viewportOnly: true,
  },
  { name: "reviews", path: "/reviews", page: "(app)/reviews/page.tsx", auth: "signed-in" },
  {
    name: "review",
    path: `/reviews/${ids.reviews.featured}`,
    page: "(app)/reviews/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-chat-accounts",
    path: "/settings/chat-accounts",
    page: "(app)/settings/chat-accounts/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-agent-defaults",
    path: "/settings/agent-defaults",
    page: "(app)/settings/agent-defaults/page.tsx",
    auth: "signed-in",
  },
  {
    // Defaults and the agent version save together, confirmed with the change list.
    name: "settings-agent-defaults-confirm",
    path: "/settings/agent-defaults",
    page: "(app)/settings/agent-defaults/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#default-max-concurrency", value: "4" },
      { action: "fill", selector: "#desired-version", value: "1.4.0" },
      { action: "click", selector: '#agent-defaults [type="submit"]' },
    ],
    viewportOnly: true,
  },
  {
    name: "settings-agent-defaults-host-tools",
    path: "/settings/agent-defaults/host-tools",
    page: "(app)/settings/agent-defaults/host-tools/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-integrations",
    path: "/settings/integrations",
    page: "(app)/settings/integrations/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-organization",
    path: "/settings/organization",
    page: "(app)/settings/organization/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-routing",
    path: "/settings/routing",
    page: "(app)/settings/routing/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-routing-edit",
    path: "/settings/routing",
    page: "(app)/settings/routing/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "click", selector: ".routing-add-rule" },
      { action: "click", selector: ".routing-add-rule" },
      { action: "click", selector: "li[aria-label='Rule 4'] .routing-add-condition" },
      { action: "click", selector: "li[aria-label='Rule 4'] .routing-add-group" },
      {
        action: "fill",
        selector: "li[aria-label='Rule 4'] input[aria-label='Value']",
        value: "docs",
      },
    ],
  },
];

/**
 * Whether a route matches a `--routes` glob, by name or path: `*` matches
 * within a path segment, `**` across them. Several globs may be
 * comma-separated; a route matches any of them.
 */
export function routeMatches(route: ScreenRoute, globs: string): boolean {
  const pathname = route.path.split("?")[0]!;
  return globs
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .some((glob) => {
      const regex = globToRegExp(glob);
      return regex.test(route.name) || regex.test(pathname);
    });
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
