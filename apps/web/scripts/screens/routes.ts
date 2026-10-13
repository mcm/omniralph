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
/** Built-in definitions: their route segment encodes the colon of `builtin:`. */
const builtinAgent = encodeURIComponent("builtin:reviewer");
const builtinTask = encodeURIComponent("builtin:review-pr");

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
  { name: "analytics", path: "/analytics", page: "(app)/analytics/page.tsx", auth: "signed-in" },
  { name: "jobs", path: "/jobs", page: "(app)/jobs/page.tsx", auth: "signed-in" },
  { name: "harnesses", path: "/harnesses", page: "(app)/harnesses/page.tsx", auth: "signed-in" },
  {
    name: "harness-online",
    path: `/harnesses/${ids.harnesses.online}`,
    page: "(app)/harnesses/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "harness-updating",
    path: `/harnesses/${ids.harnesses.updating}`,
    page: "(app)/harnesses/[id]/page.tsx",
    auth: "signed-in",
  },
  { name: "ralph", path: "/ralph", page: "(app)/ralph/page.tsx", auth: "signed-in" },
  {
    name: "ralph-run-running",
    path: `/ralph/${ids.ralphRuns.running}`,
    page: "(app)/ralph/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "ralph-run-waiting",
    path: `/ralph/${ids.ralphRuns.waitingOnManual}`,
    page: "(app)/ralph/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "ralph-run-failed",
    path: `/ralph/${ids.ralphRuns.failed}`,
    page: "(app)/ralph/[id]/page.tsx",
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
    // A run-affecting card's save asks first, listing the changes.
    name: "repository-settings-confirm",
    path: `/repositories/${ids.repositories.controlPanel}/settings`,
    page: "(app)/repositories/[id]/settings/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#ralph-verify-commands", value: "pnpm typecheck\npnpm test" },
      { action: "fill", selector: "#ralph-setup-command", value: "" },
      { action: "click", selector: 'form[aria-label="Ralph › Verification"] [type="submit"]' },
    ],
    viewportOnly: true,
  },
  {
    // Two dirty cards: the bar at the bottom of the viewport counts them and links to each.
    name: "repository-settings-unsaved",
    path: `/repositories/${ids.repositories.controlPanel}/settings`,
    page: "(app)/repositories/[id]/settings/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#ralph-verify-commands", value: "pnpm typecheck\npnpm test" },
      { action: "fill", selector: "#ralph-fallback-model", value: "sonnet" },
    ],
    viewportOnly: true,
  },
  {
    // Following an in-app link with unsaved changes asks first.
    name: "repository-settings-leave",
    path: `/repositories/${ids.repositories.controlPanel}/settings`,
    page: "(app)/repositories/[id]/settings/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#ralph-fallback-model", value: "sonnet" },
      { action: "click", selector: 'a[href="/settings/profiles"]' },
    ],
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
    name: "settings-agents",
    path: "/settings/agents",
    page: "(app)/settings/agents/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-agent",
    path: `/settings/agents/${builtinAgent}`,
    page: "(app)/settings/agents/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-agent-custom",
    path: `/settings/agents/${ids.definitions.agent}`,
    page: "(app)/settings/agents/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-agent-edit",
    path: `/settings/agents/${ids.definitions.agent}/edit`,
    page: "(app)/settings/agents/[id]/edit/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-agent-new",
    path: "/settings/agents/new",
    page: "(app)/settings/agents/new/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-tasks",
    path: "/settings/tasks",
    page: "(app)/settings/tasks/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-task",
    path: `/settings/tasks/${builtinTask}`,
    page: "(app)/settings/tasks/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-task-custom",
    path: `/settings/tasks/${ids.definitions.task}`,
    page: "(app)/settings/tasks/[id]/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-task-edit",
    path: `/settings/tasks/${ids.definitions.task}/edit`,
    page: "(app)/settings/tasks/[id]/edit/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-task-new",
    path: "/settings/tasks/new",
    page: "(app)/settings/tasks/new/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-chat-accounts",
    path: "/settings/chat-accounts",
    page: "(app)/settings/chat-accounts/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-harnesses",
    path: "/settings/harnesses",
    page: "(app)/settings/harnesses/page.tsx",
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
    name: "settings-profiles",
    path: "/settings/profiles",
    page: "(app)/settings/profiles/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-profiles-unsaved",
    path: "/settings/profiles",
    page: "(app)/settings/profiles/page.tsx",
    auth: "signed-in",
    steps: [{ action: "fill", selector: "#profile-standard-max-tokens", value: "150000" }],
  },
  {
    // A profile's save lists the changes and the repositories using it.
    name: "settings-profiles-confirm",
    path: "/settings/profiles",
    page: "(app)/settings/profiles/page.tsx",
    auth: "signed-in",
    steps: [
      { action: "fill", selector: "#profile-standard-max-tokens", value: "150000" },
      { action: "click", selector: 'form[aria-label="Standard"] [type="submit"]' },
    ],
    viewportOnly: true,
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
