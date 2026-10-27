import { FIXTURE_IDS, FIXTURE_SHARE_TOKENS, fixtureId } from "../fixtures/ids";

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
  // Public review links (no session): open, asking for a password, and gone.
  {
    name: "share-review",
    path: `/share/${FIXTURE_SHARE_TOKENS.open}`,
    page: "(public)/share/[token]/page.tsx",
    auth: "signed-out",
  },
  {
    name: "share-review-password",
    path: `/share/${FIXTURE_SHARE_TOKENS.protected}`,
    page: "(public)/share/[token]/page.tsx",
    auth: "signed-out",
  },
  {
    name: "share-review-gone",
    path: "/share/fixture-share-unknown-token-not-a-secret-0",
    page: "(public)/share/[token]/page.tsx",
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
  // The Backlog (the fixture Linear workspace's FIX items), and one item open beside it.
  { name: "backlog", path: "/backlog", page: "(app)/backlog/page.tsx", auth: "signed-in" },
  {
    name: "backlog-item",
    path: "/backlog/linear-fixture-issue-fix-101",
    page: "(app)/backlog/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "run-epic-running",
    path: `/runs/${ids.ralphRuns.running}`,
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "run-epic-failed",
    path: `/runs/${ids.ralphRuns.failed}`,
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    // The running epic's first story as its own view (the phone step page).
    name: "run-epic-step",
    path: `/runs/${ids.ralphRuns.running}/steps/${fixtureId("ralphStory", 100)}`,
    page: "(app)/runs/[id]/steps/[stepId]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "runs-reviews",
    path: `/runs?kind=review&repository=${ids.repositories.controlPanel}`,
    page: "(app)/runs/page.tsx",
    auth: "signed-in",
  },
  {
    // The featured review's pass (every severity and finding status) on its Findings tab.
    name: "run-review",
    path: `/runs/${fixtureId("reviewRun", 1)}?step=${ids.reviews.featured}&tab=findings`,
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "run-triage-completed",
    path: `/runs/${ids.triageRuns.completed}`,
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "run-triage-failed",
    path: `/runs/${ids.triageRuns.failed}`,
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "run-triage-running",
    path: `/runs/${ids.triageRuns.running}`,
    page: "(app)/runs/[id]/page.tsx",
    auth: "signed-in",
  },
  { name: "repos", path: "/repos", page: "(app)/repos/page.tsx", auth: "signed-in" },
  {
    name: "repo",
    path: `/repos/${ids.repositories.controlPanel}`,
    page: "(app)/repos/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "repo-coding",
    path: `/repos/${ids.repositories.controlPanel}?section=coding`,
    page: "(app)/repos/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    // A staged Reviews change: the save bar lists it with its effect.
    name: "repo-reviews-unsaved",
    path: `/repos/${ids.repositories.controlPanel}`,
    page: "(app)/repos/[id]/page.tsx",
    auth: "signed-in",
    steps: [{ action: "click", selector: 'section#reviews input[type="checkbox"]' }],
    viewportOnly: true,
  },
  {
    // The organization's agents that can be pinned.
    name: "repo-agents-menu",
    path: `/repos/${ids.repositories.controlPanel}?section=agents`,
    page: "(app)/repos/[id]/page.tsx",
    auth: "signed-in",
    steps: [{ action: "click", selector: 'button[aria-label="Pin agent"]' }],
    viewportOnly: true,
  },
  {
    name: "repo-rules",
    path: `/repos/${ids.repositories.controlPanel}?section=rules`,
    page: "(app)/repos/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    // The add-repo sheet's connections and their health.
    name: "repos-add",
    path: "/repos",
    page: "(app)/repos/page.tsx",
    auth: "signed-in",
    steps: [{ action: "click", selector: 'button[aria-label="Add repo"]' }],
    viewportOnly: true,
  },
  {
    // A connection's picker (with fixture credentials, its error state).
    name: "repos-add-github",
    path: `/repos?add=github&connection=${ids.scmConnections.github}`,
    page: "(app)/repos/page.tsx",
    auth: "signed-in",
    viewportOnly: true,
  },
  {
    name: "repos-add-gitlab",
    path: `/repos?add=gitlab&connection=${ids.scmConnections.gitlab}`,
    page: "(app)/repos/page.tsx",
    auth: "signed-in",
    viewportOnly: true,
  },
  { name: "analytics", path: "/analytics", page: "(app)/analytics/page.tsx", auth: "signed-in" },
  { name: "fleet", path: "/fleet", page: "(app)/fleet/page.tsx", auth: "signed-in" },
  {
    name: "fleet-agent",
    path: `/fleet/${ids.agents.online}`,
    page: "(app)/fleet/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    // The enroll sheet's first step.
    name: "fleet-enroll",
    path: "/fleet",
    page: "(app)/fleet/page.tsx",
    auth: "signed-in",
    steps: [{ action: "click", selector: ".or-fleet__head button" }],
    viewportOnly: true,
  },
  {
    // The version policy sheet, pinning a version.
    name: "fleet-version-policy",
    path: "/fleet",
    page: "(app)/fleet/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "click", selector: ".or-fleet__edit" },
      { action: "click", selector: '[role="radio"]:nth-child(2)' },
    ],
    viewportOnly: true,
  },
  {
    name: "fleet-agent-updating",
    path: `/fleet/${ids.agents.updating}`,
    page: "(app)/fleet/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "fleet-agent-revoked",
    path: `/fleet/${ids.agents.revoked}`,
    page: "(app)/fleet/[id]/page.tsx",
    auth: "signed-in",
  },
  // Settings (2.0): the section nav beside each page.
  { name: "settings", path: "/settings", page: "(app)/settings/page.tsx", auth: "signed-in" },
  ...(
    [
      ["general", "general"],
      ["members", "members"],
      ["profile", "profile"],
      ["linked-accounts", "linked-accounts"],
      ["add-connection", "connections/new"],
      ["advanced-routing", "advanced/routing"],
      ["advanced-playbooks", "advanced/playbooks"],
      ["advanced-chat", "advanced/chat"],
    ] as const
  ).map(([name, route]): ScreenRoute => ({
    name: `settings-${name}`,
    path: `/settings/${route}`,
    page: `(app)/settings/${route}/page.tsx`,
    auth: "signed-in",
  })),
  {
    name: "settings-advanced-playbook",
    path: "/settings/advanced/playbooks/builtin%3Aimplement-story",
    page: "(app)/settings/advanced/playbooks/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-connection-linear",
    path: `/settings/connections/linear/${ids.integrations.linear}`,
    page: "(app)/settings/connections/[provider]/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-integrations",
    path: "/settings/integrations",
    page: "(app)/(legacy-settings)/settings/integrations/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-advanced-routing-edit",
    path: "/settings/advanced/routing",
    page: "(app)/settings/advanced/routing/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "click", selector: ".or-routing__add" },
      { action: "click", selector: ".or-routing-builder__add-condition" },
      { action: "click", selector: ".or-routing-builder__add-group" },
      {
        action: "fill",
        selector: ".or-sheet input[aria-label='Value']",
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
