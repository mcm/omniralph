import { FIXTURE_IDS, fixtureId } from "../fixtures/ids";

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
