// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { getBuiltinPlaybook, Playbook, type PlaybookInput } from "@omniralph/tasks";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlaybookSettingsPage from "@/app/(app)/settings/advanced/playbooks/[id]/page";
import PlaybooksSettingsPage from "@/app/(app)/settings/advanced/playbooks/page";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import { LiveProvider } from "@/components/live/live-provider";
import { changeEvent, fakeAbly, fakeToken } from "@/components/live/live-test-utils";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import { ShowAdvancedProvider } from "@/components/show-advanced";
import type { PlaybookDetail, PlaybookSummary, PlaybookUsedBy } from "@/lib/api/playbooks";
import { SettingsLayoutView } from "../settings-layout-view";
import { organizationSettings } from "../test-fixtures";
import { epicCompletedStateLabel, minutesLabel, PLAYBOOK_NOT_FOUND } from "./playbook-detail";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  pathname: "/settings/advanced/playbooks",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOM_STORY_ID = "33333333-3333-4333-8333-333333333333";
const REPO_6_ID = "66666666-6666-4666-8666-666666666666";
const REPO = (n: number, provider: "github" | "gitlab" = "github") => ({
  id: `repo-${n}`,
  fullPath: `acme/repo-${n}`,
  provider,
  roles: ["review" as const],
});

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

function usedBy(overrides: Partial<PlaybookUsedBy> = {}): PlaybookUsedBy {
  return { repositories: [], chatPlaybooks: [], chatChannels: [], playbooks: [], ...overrides };
}

const reviewPlaybook = getBuiltinPlaybook("builtin:review-pr")!;
const chatPlaybook = getBuiltinPlaybook("builtin:ask-about-code")!;
const storyInput: PlaybookInput = {
  id: CUSTOM_STORY_ID,
  name: "Careful story",
  description: "Implements a story with extra checks.",
  role: "story",
  systemPrompt: "You are a careful engineer.",
  promptTemplate: "Implement {{story.title}}.",
  model: "claude-opus-5-5",
  fallbackModel: "claude-sonnet-5-5",
  tools: {
    builtin: ["Read"],
    agent: ["post_activity", "ship"],
    tracker: ["tracker_get_issue", "tracker_search_issues"],
    mcpServers: ["@omniralph/code-graph:graph"],
  },
  toolSettings: { shell: true, trackerRead: true, network: true },
  setupCommands: [
    { name: "deps", command: "pnpm install" },
    { name: "env", command: "cp .env.example .env" },
  ],
  teardownCommands: [{ name: "clean", command: "git clean -fdx" }],
  tokenBudget: { tokens: 500000 },
  coding: {
    worktreeSetupCommand: "pnpm install --frozen-lockfile",
    runPrdQualityGates: false,
    epicCompletedState: "completed",
    unmergedBranchTimeoutMinutes: 120,
    maxAttemptsPerStory: 1,
  },
};
const storyPlaybook = Playbook.parse(storyInput);

const playbookList: PlaybookSummary[] = [
  {
    id: reviewPlaybook.id,
    name: reviewPlaybook.name,
    description: reviewPlaybook.description,
    role: "review",
    builtin: true,
    model: null,
    usedBy: usedBy({ repositories: [REPO(1), REPO(2, "gitlab"), REPO(3)] }),
  },
  {
    id: chatPlaybook.id,
    name: chatPlaybook.name,
    description: chatPlaybook.description,
    role: "chat-ask",
    builtin: true,
    model: "claude-sonnet-5-5",
    usedBy: usedBy({ chatPlaybooks: ["ask"] }),
  },
  {
    id: "builtin:describe-pr",
    name: "Describe a PR",
    description: "",
    role: "pr-description",
    builtin: true,
    model: null,
    usedBy: usedBy(),
  },
  {
    id: CUSTOM_STORY_ID,
    name: "Careful story",
    description: storyPlaybook.description,
    role: "story",
    builtin: false,
    model: "claude-opus-5-5",
    usedBy: usedBy({ repositories: [REPO(4), REPO(5, "gitlab")] }),
  },
];

const details: Readonly<Record<string, PlaybookDetail>> = {
  [reviewPlaybook.id]: {
    playbook: reviewPlaybook,
    builtin: true,
    tokenBudgetLabel: "Set by the review depth",
    requirements: { minAgentVersion: "0.10.0", installables: [], hostTools: [] },
    usedBy: usedBy({ repositories: [REPO(1)] }),
  },
  [chatPlaybook.id]: {
    playbook: chatPlaybook,
    builtin: true,
    tokenBudgetLabel: "No limit",
    requirements: { minAgentVersion: "0.9.0", installables: [], hostTools: [] },
    usedBy: usedBy({
      chatPlaybooks: ["ask"],
      chatChannels: [
        {
          connectionId: "chat-1",
          connectionName: "Acme Slack",
          channelId: "C123",
          roles: ["ask", "startWork"],
        },
      ],
    }),
  },
  [CUSTOM_STORY_ID]: {
    playbook: storyPlaybook,
    builtin: false,
    tokenBudgetLabel: "500,000 tokens",
    requirements: {
      minAgentVersion: "0.11.0",
      installables: ["@omniralph/code-graph"],
      hostTools: ["semgrep"],
    },
    usedBy: usedBy({ repositories: [{ ...REPO(4), roles: ["story", "request"] }] }),
  },
};

let playbooks: PlaybookSummary[];
/** Changes to `details` for one test; null answers 404 (deleted). */
let detailOverrides: Record<string, PlaybookDetail | null>;
let seen: SeenRequest[];

beforeEach(() => {
  ui.toast.mockReset();
  nav.pathname = "/settings/advanced/playbooks";
  playbooks = [...playbookList];
  detailOverrides = {};
  seen = mockFetch({
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
    "GET /api/ui/playbooks": () => jsonResponse({ playbooks }),
  });
  // Details: any `/api/ui/playbooks/{id}` path, 404 for an unknown ID.
  const listFetch = vi.mocked(fetch);
  const base = listFetch.getMockImplementation()!;
  listFetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const match = /^\/api\/ui\/playbooks\/([^/]+)$/.exec(url.pathname);
    if (!match) return base(input, init);
    seen.push({ method: "GET", path: url.pathname, query: url.searchParams, body: undefined });
    const id = decodeURIComponent(match[1]!);
    const detail = id in detailOverrides ? detailOverrides[id] : details[id];
    return detail ? jsonResponse(detail) : jsonResponse({ ok: false, error: "Not found" }, 404);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage(page: ReactNode, options: { live?: ReturnType<typeof fakeAbly> } = {}) {
  const content = <SettingsLayoutView>{page}</SettingsLayoutView>;
  render(
    <CurrentUserProvider user={member}>
      <ShowAdvancedProvider initial={true}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider linkComponent={TestLink}>
            {options.live ? (
              <LiveProvider createClient={options.live.createClient} fetchToken={fakeToken}>
                {content}
              </LiveProvider>
            ) : (
              content
            )}
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
}

async function renderDetail(id: string, options: { live?: ReturnType<typeof fakeAbly> } = {}) {
  nav.pathname = `/settings/advanced/playbooks/${encodeURIComponent(id)}`;
  const page = await PlaybookSettingsPage({
    params: Promise.resolve({ id: encodeURIComponent(id) }),
  });
  renderPage(page, options);
}

const table = () => screen.findByRole("table", { name: "Playbooks" });

/** A cell's text without the code-host marks' SVG titles. */
function cellText(cell: HTMLElement): string {
  const copy = cell.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("svg").forEach((svg) => svg.remove());
  return copy.textContent!.replace(/\s+/g, " ").trim();
}

/** The table's rows: name, built-in badge, role, model and used by. */
async function tableRows() {
  return within(await table())
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell").map(cellText));
}

const playbookReads = () => seen.filter((request) => request.path === "/api/ui/playbooks");
const detailReads = (id: string) =>
  seen.filter((request) => request.path === `/api/ui/playbooks/${encodeURIComponent(id)}`);

/** The facts of the card titled `title`: `[term, value]`. */
function facts(title: string): [string, string][] {
  const card = screen.getByRole("region", { name: title });
  return Array.from(card.querySelectorAll(".or-playbook__fact")).map((fact) => [
    fact.querySelector("dt")!.textContent!,
    fact.querySelector("dd")!.textContent!,
  ]);
}

describe("the playbooks list", () => {
  it("lists built-in and custom playbooks with role, model, Built-in and used by", async () => {
    renderPage(<PlaybooksSettingsPage />);
    expect(await tableRows()).toEqual([
      ["Review a pull request", "Built-in", "Review", "Set by the review depth", "acme/repo-1+2"],
      ["Ask about code", "Built-in", "Chat answer", "claude-sonnet-5-5", "Chat"],
      ["Describe a PR", "Built-in", "Pull request description", "Claude Code default", "Not used"],
      ["Careful story", "", "Story", "claude-opus-5-5", "acme/repo-4 acme/repo-5"],
    ]);
    const tbl = await table();
    expect(within(tbl).getByRole("columnheader", { name: "Used by" })).toBeTruthy();
    // Each name links to its page (built-in IDs keep their colon encoded).
    expect(
      within(tbl).getByRole("link", { name: "Review a pull request" }).getAttribute("href"),
    ).toBe("/settings/advanced/playbooks/builtin%3Areview-pr");
    expect(within(tbl).getByRole("link", { name: "Careful story" }).getAttribute("href")).toBe(
      `/settings/advanced/playbooks/${CUSTOM_STORY_ID}`,
    );
    // The overflow is a "+N" badge after the first repo, with its code-host mark.
    const review = within(tbl).getAllByRole("row")[1]!;
    expect(review.querySelectorAll(".or-ref--repo")).toHaveLength(1);
    expect(within(review).getByText("+2")).toBeTruthy();
    // The custom row has no Built-in badge.
    const custom = within(tbl).getAllByRole("row")[4]!;
    expect(within(custom).queryByText("Built-in")).toBeNull();
  });

  it("names every role in plain words", async () => {
    const roles = [
      ["review-summary", "Review summary"],
      ["correlation", "Correlation"],
      ["request", "Request"],
      ["triage", "Triage"],
      ["learn-rule", "Learn rule"],
      ["reply-to-finding", "Reply to finding"],
      ["verifier", "Verifier"],
      ["audit", "Epic audit"],
    ] as const;
    playbooks = roles.map(([role], index) => ({
      ...playbookList[3]!,
      id: `builtin:role-${index}`,
      name: `Playbook ${index}`,
      role,
    }));
    renderPage(<PlaybooksSettingsPage />);
    expect((await tableRows()).map((row) => row[2])).toEqual(roles.map(([, label]) => label));
  });

  it("shows the same rows as cards on phone", async () => {
    renderPage(<PlaybooksSettingsPage />);
    const cards = within(await screen.findByRole("list", { name: "Playbooks" })).getAllByRole(
      "listitem",
    );
    expect(cards).toHaveLength(4);
    const first = cards[0]!;
    expect(within(first).getByRole("link", { name: "Review a pull request" })).toBeTruthy();
    expect(within(first).getByText("Built-in")).toBeTruthy();
    expect(within(first).getByText("Review")).toBeTruthy();
    expect(within(first).getByText("+2")).toBeTruthy();
    expect(within(cards[1]!).getByText("Chat")).toBeTruthy();
    expect(within(cards[3]!).queryByText("Built-in")).toBeNull();
  });

  it("offers to try again when the list can't load", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes("/api/ui/playbooks")
        ? jsonResponse({ ok: false, error: "Down" }, 500)
        : jsonResponse({ connections: [] }),
    );
    renderPage(<PlaybooksSettingsPage />);
    expect(await screen.findByText("Couldn't load the playbooks")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("a playbook's page", () => {
  it("shows a review playbook", async () => {
    await renderDetail(reviewPlaybook.id);
    expect(
      await screen.findByRole("heading", { level: 2, name: "Review a pull request" }),
    ).toBeTruthy();
    expect(facts("Overview")).toEqual([
      ["Role", "Review"],
      ["Starts on", "Pull request opened or updatedMention on a pull requestReview rerun"],
      ["Model", "Set by the review depth"],
      ["Fallback model", "Set by the review depth"],
      ["Token budget", "Set by the review depth"],
    ]);
    const prompts = screen.getByRole("region", { name: "Prompts" });
    const blocks = prompts.querySelectorAll("pre.or-mono");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.textContent).toBe(reviewPlaybook.systemPrompt);
    expect(blocks[1]!.textContent).toBe(reviewPlaybook.promptTemplate);
    expect(within(prompts).getByText("System prompt (replaces Claude Code's)")).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Built-in tools" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Read", "Grep", "Glob"]);
    expect(facts("Tools")).toContainEqual(["Agent", "None"]);
    expect(facts("Requirements")).toEqual([
      ["Agent version", "0.10.0 or later"],
      ["Packages", "None"],
      ["Host tools", "None"],
    ]);
    expect(facts("Commands")).toEqual([
      ["Setup", "None"],
      ["Teardown", "None"],
    ]);
    // A review loops: its limits at their defaults.
    expect(facts("Loop")).toEqual([
      ["Most iterations", "5 iterations"],
      ["Stall rounds", "Stops after 2 iterations without a better score"],
    ]);
    expect(screen.queryByRole("region", { name: "Coding" })).toBeNull();
    const used = screen.getByRole("region", { name: "Used by" });
    expect(within(used).getByText("acme/repo-1")).toBeTruthy();
    expect(within(used).getByText("Review")).toBeTruthy();
    expect(screen.getByText("Built-in", { selector: ".or-ref__text" })).toBeTruthy();
  });

  it("shows a story playbook with its commands, tools, requirements and coding settings", async () => {
    await renderDetail(CUSTOM_STORY_ID);
    expect(await screen.findByRole("heading", { level: 2, name: "Careful story" })).toBeTruthy();
    expect(screen.getByText("Implements a story with extra checks.")).toBeTruthy();
    expect(facts("Overview")).toEqual([
      ["Role", "Story"],
      ["Starts on", "Work item delegated to Om"],
      ["Model", "claude-opus-5-5"],
      ["Fallback model", "claude-sonnet-5-5"],
      ["Token budget", "500,000 tokens"],
    ]);
    expect(screen.queryByText("Built-in", { selector: ".or-ref__text" })).toBeNull();
    const items = (name: string) =>
      within(screen.getByRole("list", { name }))
        .getAllByRole("listitem")
        .map((item) => item.textContent);
    expect(items("Agent tools")).toEqual(["post_activity", "ship"]);
    expect(items("MCP servers")).toEqual(["@omniralph/code-graph:graph"]);
    expect(items("Tracker tools")).toEqual(["Read a work item", "Search work items"]);
    expect(facts("Tools")).toContainEqual(["Shell access", "On"]);
    expect(items("Packages")).toEqual(["@omniralph/code-graph"]);
    expect(items("Host tools")).toEqual(["semgrep"]);
    // Setup and teardown commands are numbered lists (Design rule 19).
    for (const name of ["Setup commands", "Teardown commands"]) {
      expect(screen.getByRole("list", { name }).tagName).toBe("OL");
    }
    expect(items("Setup commands")).toEqual(["pnpm install", "cp .env.example .env"]);
    expect(items("Teardown commands")).toEqual(["git clean -fdx"]);
    expect(facts("Coding")).toEqual([
      ["Worktree setup", "pnpm install --frozen-lockfile"],
      ["PRD quality gates", "Skipped"],
      ["Preparation", "Offers to run a manual story's preparation commands"],
      ["Epic completed state", "The team's first completed state"],
      ["Merged worktree cleanup", "Removes the worktree and branch after the pull request merges"],
      ["Unmerged branch timeout", "2 hours"],
    ]);
    // A story loops by its coding settings, unset ones at their defaults.
    expect(facts("Loop")).toEqual([
      ["Attempts per story", "1 attempt"],
      ["Rounds per story", "8 rounds"],
      ["Stall rounds", "Set aside after 3 rounds without a better score"],
      ["Task verifier", "builtin:verify-task"],
      ["Epic audit", "builtin:audit-epic"],
      ["Audit rounds", "2 rounds"],
    ]);
    expect(
      within(screen.getByRole("region", { name: "Used by" })).getByText("Story, Request"),
    ).toBeTruthy();
  });

  it("shows a chat playbook and where chat uses it", async () => {
    await renderDetail(chatPlaybook.id);
    expect(await screen.findByRole("heading", { level: 2, name: "Ask about code" })).toBeTruthy();
    expect(facts("Overview")).toEqual([
      ["Role", "Chat answer"],
      ["Starts on", "Chat request"],
      ["Model", "claude-sonnet-5-5"],
      ["Fallback model", "None"],
      ["Token budget", "No limit"],
    ]);
    // A chat answer is one session.
    expect(screen.queryByRole("region", { name: "Loop" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Coding" })).toBeNull();
    const used = screen.getByRole("region", { name: "Used by" });
    expect(within(used).getByText("Ask about code")).toBeTruthy();
    expect(within(used).getByText("Acme Slack › C123")).toBeTruthy();
    expect(within(used).getByText("Ask about code, Start work")).toBeTruthy();
  });

  it("copies the playbook ID from the ⋯ menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderDetail(reviewPlaybook.id);
    const toolbar = await screen.findByRole("toolbar", { name: "Playbook actions" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Copy playbook ID"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy playbook ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("builtin:review-pr"));
    expect(ui.toast).toHaveBeenCalledWith("Playbook ID copied");
  });

  it("says an unknown or other organization's playbook doesn't exist", async () => {
    await renderDetail("44444444-4444-4444-8444-444444444444");
    expect(await screen.findByRole("heading", { name: PLAYBOOK_NOT_FOUND })).toBeTruthy();
    expect(screen.getByRole("link", { name: "‹ Playbooks" }).getAttribute("href")).toBe(
      "/settings/advanced/playbooks",
    );
  });

  it("stacks the facts on phone", () => {
    const css = readFileSync(path.resolve(__dirname, "playbooks.css"), "utf8");
    const phone = /@media \(max-width: 768px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(phone).toMatch(/\.or-playbook__facts \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  });
});

describe("labels", () => {
  it("words the epic completed state and the timeout", () => {
    expect(epicCompletedStateLabel(null)).toBe("Left as it is");
    expect(epicCompletedStateLabel("started")).toBe("The team's first started state");
    expect(epicCompletedStateLabel("Shipped")).toBe("Shipped");
    expect(minutesLabel(60)).toBe("1 hour");
    expect(minutesLabel(90)).toBe("90 minutes");
    expect(minutesLabel(1440 * 7)).toBe("7 days");
  });
});

describe("live updates", () => {
  const ORG_CHANNEL = `org:${TEST_ORGANIZATION_ID}:changes`;
  const connected = (live: ReturnType<typeof fakeAbly>) =>
    waitFor(() => expect(live.current().subscribed()).toContain(ORG_CHANNEL));

  it.each([
    [
      "a playbook saved",
      changeEvent(TEST_ORGANIZATION_ID, {
        resource: "settings",
        section: "playbooks",
        ids: [CUSTOM_STORY_ID],
        subjectId: CUSTOM_STORY_ID,
      }),
    ],
    [
      "a repo's bindings changed",
      changeEvent(TEST_ORGANIZATION_ID, {
        resource: "settings",
        section: "repository.playbooks",
        ids: [REPO_6_ID],
        subjectId: REPO_6_ID,
      }),
    ],
    [
      "a repo connected",
      changeEvent(TEST_ORGANIZATION_ID, { resource: "repository", ids: [REPO_6_ID] }),
    ],
  ])("refreshes the list on %s", async (_, event) => {
    const live = fakeAbly();
    renderPage(<PlaybooksSettingsPage />, { live });
    expect(await tableRows()).toHaveLength(4);
    await connected(live);
    const reads = playbookReads().length;
    playbooks = [
      ...playbookList.slice(0, 3),
      {
        ...playbookList[3]!,
        name: "Careful story v2",
        usedBy: usedBy({ repositories: [REPO(6)] }),
      },
    ];
    act(() => live.current().deliver(ORG_CHANNEL, event));
    await waitFor(async () => expect((await tableRows())[3]![0]).toBe("Careful story v2"));
    expect((await tableRows())[3]![4]).toBe("acme/repo-6");
    expect(playbookReads().length).toBe(reads + 1);
  });

  it("refreshes an open playbook on an edit, and on a delete says it's gone", async () => {
    const live = fakeAbly();
    await renderDetail(CUSTOM_STORY_ID, { live });
    expect(await screen.findByRole("heading", { level: 2, name: "Careful story" })).toBeTruthy();
    await connected(live);
    const saved = changeEvent(TEST_ORGANIZATION_ID, {
      resource: "settings",
      section: "playbooks",
      ids: [CUSTOM_STORY_ID],
      subjectId: CUSTOM_STORY_ID,
    });
    detailOverrides[CUSTOM_STORY_ID] = {
      ...details[CUSTOM_STORY_ID]!,
      playbook: { ...storyPlaybook, name: "Careful story v2" },
    };
    act(() => live.current().deliver(ORG_CHANNEL, saved));
    expect(await screen.findByRole("heading", { level: 2, name: "Careful story v2" })).toBeTruthy();

    detailOverrides[CUSTOM_STORY_ID] = null;
    act(() => live.current().deliver(ORG_CHANNEL, saved));
    expect(await screen.findByRole("heading", { name: PLAYBOOK_NOT_FOUND })).toBeTruthy();
  });

  it("refreshes an open playbook when a repo's bindings change", async () => {
    const live = fakeAbly();
    await renderDetail(reviewPlaybook.id, { live });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Review a pull request" }),
    ).toBeTruthy();
    await connected(live);
    const reads = detailReads(reviewPlaybook.id).length;
    detailOverrides[reviewPlaybook.id] = {
      ...details[reviewPlaybook.id]!,
      usedBy: usedBy({ repositories: [REPO(1), REPO(7)] }),
    };
    act(() =>
      live.current().deliver(
        ORG_CHANNEL,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "settings",
          section: "repository.playbooks",
          ids: [REPO_6_ID],
          subjectId: REPO_6_ID,
        }),
      ),
    );
    expect(
      await within(screen.getByRole("region", { name: "Used by" })).findByText("acme/repo-7"),
    ).toBeTruthy();
    expect(detailReads(reviewPlaybook.id).length).toBe(reads + 1);
  });

  it("ignores another organization's and unrelated events", async () => {
    const live = fakeAbly();
    renderPage(<PlaybooksSettingsPage />, { live });
    expect(await tableRows()).toHaveLength(4);
    await connected(live);
    const reads = playbookReads().length;
    act(() => {
      live.current().deliver(
        ORG_CHANNEL,
        changeEvent(OTHER_ORG_ID, {
          resource: "settings",
          section: "playbooks",
          ids: [CUSTOM_STORY_ID],
          subjectId: CUSTOM_STORY_ID,
        }),
      );
      live
        .current()
        .deliver(ORG_CHANNEL, changeEvent(TEST_ORGANIZATION_ID, { resource: "organization" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(playbookReads().length).toBe(reads);
  });
});
