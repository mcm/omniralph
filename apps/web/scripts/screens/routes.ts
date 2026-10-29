import { FIXTURE_IDS, FIXTURE_INBOX_KEYS, FIXTURE_SHARE_TOKENS, fixtureId } from "../fixtures/ids";
import type { ViewportName } from "./options";

/** The boards of the canvas "Omniralph 2.0 — Primary Screens" (DESIGN.md, "Canvas boards"). */
export const CANVAS_BOARDS = [
  "Main",
  "InboxUVL",
  "InboxEmpty",
  "Runs",
  "Backlog",
  "Repos",
  "Fleet",
  "Ask",
  "Settings",
  "CursorAvatars",
  "MobileInbox",
  "MobileMenu",
  "MobileRun",
  "MobileAsk",
] as const;
export type CanvasBoard = (typeof CANVAS_BOARDS)[number];

/** The boards drawn at phone width: their routes must be captured at `phone`. */
export const PHONE_BOARDS: readonly CanvasBoard[] = [
  "MobileInbox",
  "MobileMenu",
  "MobileRun",
  "MobileAsk",
];

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
  /**
   * A CSS selector to wait for before the steps: content that loads without a skeleton
   * (e.g. Up next in the empty Inbox), so the capture can't race it.
   */
  waitFor?: string;
  /** Screenshot only the viewport (e.g. an open dialog), not the full page. */
  viewportOnly?: boolean;
  /** The canvas board(s) this capture is reviewed against. */
  board?: CanvasBoard | readonly CanvasBoard[];
  /**
   * Signed in as the fixture member instead of the admin, to review admin-only controls in
   * their read-only form. Only for `signed-in` routes.
   */
  as?: "member";
  /** The organization to open it in (the organization cookie); the user's active one if unset. */
  organization?: string;
  /** Only these viewports (a state that exists at some widths only, e.g. the phone menu). */
  viewports?: readonly ViewportName[];
  /**
   * A list screen (Inbox, Runs, Backlog, Repos, Fleet, Ask): its rows are checked for a summary
   * line and for the organization badge (`decided-page.mjs`).
   */
  list?: true;
  /**
   * A detail view (`DETAIL_PAGES`, or an Inbox item): its header must hold a toolbar of icon
   * buttons and a ⋯ menu, its phone Details load collapsed, its header's badges start with the
   * organization under All organizations.
   */
  detail?: true;
  /** The detail shows a needs-you decision, whose labeled buttons may sit in its header. */
  needsYou?: true;
  /** Captured with "All organizations" selected (the organization scope cookie). */
  org?: "all";
}

/** The list screens' pages: every route of one sets `list`. */
export const LIST_PAGES = [
  "(app)/page.tsx",
  "(app)/runs/page.tsx",
  "(app)/backlog/page.tsx",
  "(app)/repos/page.tsx",
  "(app)/fleet/page.tsx",
  "(app)/ask/page.tsx",
] as const;

/** The detail views' pages: every route of one sets `detail` (as do the Inbox's items). */
export const DETAIL_PAGES = [
  "(app)/runs/[id]/page.tsx",
  "(app)/runs/[id]/steps/[stepId]/page.tsx",
  "(app)/backlog/[id]/page.tsx",
  "(app)/repos/[id]/page.tsx",
  "(app)/fleet/[id]/page.tsx",
  "(app)/settings/connections/[provider]/[id]/page.tsx",
  "(app)/settings/advanced/playbooks/[id]/page.tsx",
] as const;

/** Whether a route opens an Inbox item (by its URL, or by clicking its row). */
export function opensInboxItem(route: Pick<ScreenRoute, "page" | "path" | "steps">): boolean {
  return (
    route.page === "(app)/page.tsx" &&
    (/[?&]item=/.test(route.path) ||
      (route.steps ?? []).some((step) => step.selector.startsWith('.or-inbox a[href*="item=')))
  );
}

/** The boards a route names, as a list. */
export function routeBoards(route: ScreenRoute): readonly CanvasBoard[] {
  if (route.board === undefined) return [];
  return typeof route.board === "string" ? [route.board] : route.board;
}

/** Whether `route` is captured at `viewport`. */
export function capturedAt(route: Pick<ScreenRoute, "viewports">, viewport: ViewportName): boolean {
  return route.viewports === undefined || route.viewports.includes(viewport);
}

/** One interaction: type into a field, or click an element (CSS selectors). */
export type ScreenStep =
  | { action: "fill"; selector: string; value: string }
  | { action: "click"; selector: string };

const ids = FIXTURE_IDS;

/** The Inbox with `item` selected on `tab` (`inboxHref` in `src/screens/inbox/url.ts`). */
const inboxItem = (tab: string, item: string) => `/?${new URLSearchParams({ tab, item })}`;
/**
 * Clicks the Inbox row whose item key starts with `prefix`: for kinds whose key carries a
 * time (a stopped epic, a question), so it can't be named up front.
 */
const openInboxRow = (prefix: string): ScreenStep => ({
  action: "click",
  selector: `.or-inbox a[href*="item=${encodeURIComponent(prefix)}"]`,
});
/** Opens the ⋯ "More actions" menu of the detail toolbar. */
const OPEN_MORE_ACTIONS: ScreenStep = {
  action: "click",
  selector: '.or-toolbar__more[aria-label="More actions"]',
};

/**
 * Every screen of the panel, with fixture IDs (`scripts/fixtures/ids.ts`) for
 * dynamic segments. A page may appear more than once to cover its states.
 */
export const SCREEN_ROUTES: readonly ScreenRoute[] = [
  // Signed-out shells.
  {
    name: "sign-in",
    path: "/sign-in",
    page: "(auth)/sign-in/page.tsx",
    auth: "signed-out",
    board: "CursorAvatars",
  },
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

  // The app. The Inbox: each tab, and an item of each needs-you kind open beside the list.
  {
    name: "home",
    path: "/",
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
    board: ["Main", "InboxUVL", "MobileInbox", "CursorAvatars"],
  },
  {
    name: "inbox-problems",
    path: "/?tab=problems",
    page: "(app)/page.tsx",
    auth: "signed-in",
    list: true,
  },
  {
    name: "inbox-running",
    path: "/?tab=running",
    page: "(app)/page.tsx",
    auth: "signed-in",
    list: true,
  },
  {
    name: "inbox-manual-story",
    detail: true,
    needsYou: true,
    path: inboxItem("needs-you", FIXTURE_INBOX_KEYS.manualStory),
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
    board: "Main",
  },
  {
    name: "inbox-stopped-epic",
    detail: true,
    needsYou: true,
    path: "/",
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
    steps: [openInboxRow(`stopped:${ids.inbox.stoppedEpic}:`)],
  },
  {
    name: "inbox-question",
    detail: true,
    needsYou: true,
    path: "/",
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
    steps: [openInboxRow(`question:${ids.inbox.question}:`)],
  },
  {
    name: "inbox-prd-ready",
    detail: true,
    needsYou: true,
    path: inboxItem("needs-you", FIXTURE_INBOX_KEYS.prdReady),
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
  },
  {
    name: "inbox-pull-request",
    detail: true,
    needsYou: true,
    path: inboxItem("needs-you", FIXTURE_INBOX_KEYS.pullRequest),
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
  },
  {
    name: "inbox-merge-request",
    detail: true,
    needsYou: true,
    path: inboxItem("needs-you", FIXTURE_INBOX_KEYS.mergeRequest),
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
  },
  {
    // The sandbox organization has nothing needing you: the empty Inbox with Up next.
    name: "inbox-empty",
    path: "/",
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
    organization: ids.organizations.sandbox,
    waitFor: ".or-upnext",
    board: "InboxEmpty",
  },
  {
    // The phone menu (drawer) with Repos, Fleet and Settings.
    name: "phone-menu",
    path: "/",
    page: "(app)/page.tsx",
    list: true,
    auth: "signed-in",
    steps: [{ action: "click", selector: ".or-topbar__menu" }],
    viewportOnly: true,
    viewports: ["phone"],
    board: "MobileMenu",
  },
  {
    // The Ask panel open beside another screen (the sidebar's and rail's Ask entry; the
    // phone opens Ask full screen instead).
    name: "ask-panel",
    path: "/runs",
    page: "(app)/runs/page.tsx",
    list: true,
    auth: "signed-in",
    steps: [{ action: "click", selector: '.or-sidebar [data-nav-id="ask"]' }],
    viewportOnly: true,
    viewports: ["desktop", "rail"],
    board: "Ask",
  },
  {
    name: "runs",
    path: "/runs",
    page: "(app)/runs/page.tsx",
    auth: "signed-in",
    list: true,
    board: "Runs",
  },
  // The Backlog (the fixture Linear workspace's FIX items): its Ready to start and Needs
  // refining lists, and one item open beside it on its PRD.
  {
    name: "backlog",
    path: "/backlog",
    page: "(app)/backlog/page.tsx",
    list: true,
    auth: "signed-in",
    board: "Backlog",
  },
  // Ask: the member's chats.
  {
    name: "ask",
    path: "/ask",
    page: "(app)/ask/page.tsx",
    auth: "signed-in",
    list: true,
    board: "Ask",
  },
  {
    name: "ask-new",
    path: "/ask/new",
    page: "(app)/ask/new/page.tsx",
    auth: "signed-in",
    board: "Ask",
  },
  {
    name: "ask-chat",
    path: `/ask/${ids.askChats.controlPanel}`,
    page: "(app)/ask/[chatId]/page.tsx",
    auth: "signed-in",
    board: ["Ask", "MobileAsk"],
  },
  {
    name: "backlog-item",
    path: "/backlog/linear-fixture-issue-fix-101",
    page: "(app)/backlog/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: "Backlog",
  },
  {
    name: "run-epic-running",
    path: `/runs/${ids.ralphRuns.running}`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: ["Runs", "MobileRun"],
  },
  {
    // The running story's step panel: its running attempt and transcript.
    name: "run-epic-step-panel",
    path: `/runs/${ids.ralphRuns.running}?step=${ids.stories.running}`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: "Runs",
  },
  {
    // The story with three attempts, on its Diff tab.
    name: "run-epic-diff",
    path: `/runs/${ids.ralphRuns.running}?step=${ids.stories.severalAttempts}&tab=diff`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: "Runs",
  },
  {
    name: "run-epic-failed",
    path: `/runs/${ids.ralphRuns.failed}`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    // The running epic's first story as its own view (the phone step page).
    name: "run-epic-step",
    path: `/runs/${ids.ralphRuns.running}/steps/${fixtureId("ralphStory", 100)}`,
    page: "(app)/runs/[id]/steps/[stepId]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: "MobileRun",
  },
  {
    name: "runs-reviews",
    path: `/runs?kind=review&repository=${ids.repositories.controlPanel}`,
    page: "(app)/runs/page.tsx",
    list: true,
    auth: "signed-in",
  },
  {
    // The featured review's pass (every severity and finding status) on its Findings tab.
    name: "run-review",
    path: `/runs/${fixtureId("reviewRun", 1)}?step=${ids.reviews.featured}&tab=findings`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    name: "run-triage-completed",
    path: `/runs/${ids.triageRuns.completed}`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    name: "run-triage-failed",
    path: `/runs/${ids.triageRuns.failed}`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    name: "run-triage-running",
    path: `/runs/${ids.triageRuns.running}`,
    page: "(app)/runs/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    name: "repos",
    path: "/repos",
    page: "(app)/repos/page.tsx",
    list: true,
    auth: "signed-in",
    board: "Repos",
  },
  {
    name: "repo",
    path: `/repos/${ids.repositories.controlPanel}`,
    page: "(app)/repos/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: "Repos",
  },
  {
    name: "repo-coding",
    path: `/repos/${ids.repositories.controlPanel}?section=coding`,
    page: "(app)/repos/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    // A staged Reviews change: the save bar lists it with its effect.
    name: "repo-reviews-unsaved",
    path: `/repos/${ids.repositories.controlPanel}`,
    page: "(app)/repos/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    steps: [{ action: "click", selector: 'section#reviews input[type="checkbox"]' }],
    viewportOnly: true,
  },
  {
    // The organization's agents that can be pinned.
    name: "repo-agents-menu",
    path: `/repos/${ids.repositories.controlPanel}?section=agents`,
    page: "(app)/repos/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    steps: [{ action: "click", selector: 'button[aria-label="Pin agent"]' }],
    viewportOnly: true,
  },
  {
    name: "repo-rules",
    path: `/repos/${ids.repositories.controlPanel}?section=rules`,
    page: "(app)/repos/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    // The add-repo sheet's connections and their health.
    name: "repos-add",
    path: "/repos",
    page: "(app)/repos/page.tsx",
    list: true,
    auth: "signed-in",
    steps: [{ action: "click", selector: 'button[aria-label="Add repo"]' }],
    viewportOnly: true,
  },
  {
    // A connection's picker (with fixture credentials, its error state).
    name: "repos-add-github",
    path: `/repos?add=github&connection=${ids.scmConnections.github}`,
    page: "(app)/repos/page.tsx",
    list: true,
    auth: "signed-in",
    viewportOnly: true,
  },
  {
    name: "repos-add-gitlab",
    path: `/repos?add=gitlab&connection=${ids.scmConnections.gitlab}`,
    page: "(app)/repos/page.tsx",
    list: true,
    auth: "signed-in",
    viewportOnly: true,
  },
  { name: "analytics", path: "/analytics", page: "(app)/analytics/page.tsx", auth: "signed-in" },
  { name: "help", path: "/help", page: "(app)/help/page.tsx", auth: "signed-in" },
  {
    name: "fleet",
    path: "/fleet",
    page: "(app)/fleet/page.tsx",
    list: true,
    auth: "signed-in",
    board: "Fleet",
  },
  {
    name: "fleet-agent",
    path: `/fleet/${ids.agents.online}`,
    page: "(app)/fleet/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    board: "Fleet",
  },
  {
    // The agent detail toolbar's ⋯ menu, open.
    name: "fleet-agent-menu",
    path: `/fleet/${ids.agents.online}`,
    page: "(app)/fleet/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    steps: [OPEN_MORE_ACTIONS],
    viewportOnly: true,
  },
  {
    // Revoke's typed confirmation, from the ⋯ menu.
    name: "fleet-agent-revoke",
    path: `/fleet/${ids.agents.online}`,
    page: "(app)/fleet/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
    steps: [
      OPEN_MORE_ACTIONS,
      { action: "click", selector: '[role="menuitem"]:has-text("Revoke agent")' },
    ],
    viewportOnly: true,
  },
  {
    // The enroll sheet's first step.
    name: "fleet-enroll",
    path: "/fleet",
    page: "(app)/fleet/page.tsx",
    list: true,
    auth: "signed-in",
    steps: [{ action: "click", selector: ".or-fleet__head button" }],
    viewportOnly: true,
  },
  {
    // The version policy sheet, pinning a version.
    name: "fleet-version-policy",
    path: "/fleet",
    page: "(app)/fleet/page.tsx",
    list: true,
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
    detail: true,
    auth: "signed-in",
  },
  {
    name: "fleet-agent-revoked",
    path: `/fleet/${ids.agents.revoked}`,
    page: "(app)/fleet/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  // Settings (2.0): the section nav beside each page.
  {
    name: "settings",
    path: "/settings",
    page: "(app)/settings/page.tsx",
    auth: "signed-in",
    board: "Settings",
  },
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
    ...(["general", "members", "profile"].includes(name) && { board: "Settings" as const }),
  })),
  {
    name: "settings-advanced-playbook",
    path: "/settings/advanced/playbooks/builtin%3Aimplement-story",
    page: "(app)/settings/advanced/playbooks/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    name: "settings-advanced-playbook-new",
    path: "/settings/advanced/playbooks/new",
    page: "(app)/settings/advanced/playbooks/new/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-advanced-playbook-edit",
    path: `/settings/advanced/playbooks/${ids.playbooks.custom}/edit`,
    page: "(app)/settings/advanced/playbooks/[id]/edit/page.tsx",
    auth: "signed-in",
  },
  {
    name: "settings-connection-linear",
    path: `/settings/connections/linear/${ids.integrations.linear}`,
    page: "(app)/settings/connections/[provider]/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    // With its webhook deliveries (every outcome, and a replay).
    name: "settings-connection-github",
    path: `/settings/connections/github/${ids.scmConnections.github}`,
    page: "(app)/settings/connections/[provider]/[id]/page.tsx",
    detail: true,
    auth: "signed-in",
  },
  {
    name: "settings-connection-gitlab",
    path: `/settings/connections/gitlab/${ids.scmConnections.gitlab}`,
    page: "(app)/settings/connections/[provider]/[id]/page.tsx",
    detail: true,
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

  // The member's view of the admin screens: Settings, Repos and Fleet, read-only.
  ...memberRoutes(),

  // "All organizations": the list screens and a detail of each, where every row and detail
  // header starts with the organization badge (rule 13).
  ...allOrganizationsRoutes(),
];

/** The list screens and a detail of each with "All organizations" selected (`org: "all"`). */
function allOrganizationsRoutes(): ScreenRoute[] {
  const lists: [name: string, path: string, page: (typeof LIST_PAGES)[number]][] = [
    ["inbox", "/", "(app)/page.tsx"],
    ["runs", "/runs", "(app)/runs/page.tsx"],
    ["backlog", "/backlog", "(app)/backlog/page.tsx"],
    ["repos", "/repos", "(app)/repos/page.tsx"],
    ["fleet", "/fleet", "(app)/fleet/page.tsx"],
    ["ask", "/ask", "(app)/ask/page.tsx"],
  ];
  const details: [name: string, path: string, page: (typeof DETAIL_PAGES)[number]][] = [
    ["run", `/runs/${ids.ralphRuns.running}`, "(app)/runs/[id]/page.tsx"],
    ["backlog-item", "/backlog/linear-fixture-issue-fix-101", "(app)/backlog/[id]/page.tsx"],
    ["repo", `/repos/${ids.repositories.controlPanel}`, "(app)/repos/[id]/page.tsx"],
    ["fleet-agent", `/fleet/${ids.agents.online}`, "(app)/fleet/[id]/page.tsx"],
  ];
  return [
    ...lists.map(([name, path, page]): ScreenRoute => ({
      name: `all-orgs-${name}`,
      path,
      page,
      auth: "signed-in",
      list: true,
      org: "all",
    })),
    {
      name: "all-orgs-inbox-item",
      path: inboxItem("needs-you", FIXTURE_INBOX_KEYS.manualStory),
      page: "(app)/page.tsx",
      auth: "signed-in",
      list: true,
      detail: true,
      needsYou: true,
      org: "all",
    },
    ...details.map(([name, path, page]): ScreenRoute => ({
      name: `all-orgs-${name}`,
      path,
      page,
      auth: "signed-in",
      detail: true,
      org: "all",
    })),
  ];
}

/** Settings, Repos and Fleet as the fixture member, so admin-only controls show read-only. */
function memberRoutes(): ScreenRoute[] {
  const routes: [name: string, path: string, page: string][] = [
    ["settings", "/settings", "(app)/settings/page.tsx"],
    ...(
      [
        "general",
        "members",
        "profile",
        "linked-accounts",
        "connections/new",
        "advanced/routing",
        "advanced/playbooks",
        "advanced/chat",
      ] as const
    ).map((route): [string, string, string] => [
      `settings-${route.replace(/\//g, "-")}`,
      `/settings/${route}`,
      `(app)/settings/${route}/page.tsx`,
    ]),
    [
      "settings-connection-github",
      `/settings/connections/github/${ids.scmConnections.github}`,
      "(app)/settings/connections/[provider]/[id]/page.tsx",
    ],
    [
      "settings-connection-linear",
      `/settings/connections/linear/${ids.integrations.linear}`,
      "(app)/settings/connections/[provider]/[id]/page.tsx",
    ],
    ["repos", "/repos", "(app)/repos/page.tsx"],
    ["repo", `/repos/${ids.repositories.controlPanel}`, "(app)/repos/[id]/page.tsx"],
    [
      "repo-coding",
      `/repos/${ids.repositories.controlPanel}?section=coding`,
      "(app)/repos/[id]/page.tsx",
    ],
    ["fleet", "/fleet", "(app)/fleet/page.tsx"],
    ["fleet-agent", `/fleet/${ids.agents.online}`, "(app)/fleet/[id]/page.tsx"],
  ];
  return routes.map(([name, path, page]) => ({
    name: `member-${name}`,
    path,
    page,
    auth: "signed-in",
    as: "member",
    ...((LIST_PAGES as readonly string[]).includes(page) && { list: true as const }),
    ...((DETAIL_PAGES as readonly string[]).includes(page) && { detail: true as const }),
  }));
}

/**
 * Whether a route matches a `--routes` glob, by name or path: `*` matches
 * within a path segment, `**` across them. Several globs may be
 * comma-separated; a route matches any of them.
 */
export function routeMatches(route: Pick<ScreenRoute, "name" | "path">, globs: string): boolean {
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
