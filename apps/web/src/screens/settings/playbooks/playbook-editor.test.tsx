// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { CLAUDE_CODE_TOOLS } from "@omniralph/shared";
import {
  AGENT_TOOLS,
  CORRELATION_OUTPUT_SCHEMA,
  CUSTOM_PLAYBOOK_ROLES,
  getBuiltinPlaybook,
  LINEAR_TOOLS,
  Playbook,
} from "@omniralph/tasks";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewPlaybookPage from "@/app/(app)/settings/advanced/playbooks/new/page";
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
import type {
  PlaybookDetail as PlaybookDetailData,
  PlaybookFormOptions,
  PlaybookSummary,
  SavedPlaybook,
} from "@/lib/api/playbooks";
import { SettingsLayoutView } from "../settings-layout-view";
import { organizationSettings } from "../test-fixtures";
import { PLAYBOOKS_PATH, playbookEditHref, playbookHref } from "./labels";
import { PlaybookDetail } from "./playbook-detail";
import { ADMINS_ONLY, BUILTIN_READ_ONLY, EditPlaybookEditor } from "./playbook-editor";
import {
  draftFromPlaybook,
  draftToInput,
  errorAt,
  newDraft,
  unplacedErrors,
} from "./playbook-form";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

/** Navigation: `router.push` (and `nav.go`) renders the page at the new path (see `Pages`). */
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    pathname: "/settings/advanced/playbooks",
    go: (to: string) => {
      state.pathname = to;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  };
  return state;
});
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

function TestLink({ href, ...props }: LinkProps) {
  return <a {...props} href={href} />;
}

const CUSTOM_ID = "33333333-3333-4333-8333-333333333333";
const NEW_ID = "55555555-5555-4555-8555-555555555555";
const CLONE_ID = "77777777-7777-4777-8777-777777777777";

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ ...testUser.organization, role: "member" }],
};

const noUsers = { repositories: [], chatPlaybooks: [], chatChannels: [], playbooks: [] };
const reviewPlaybook = getBuiltinPlaybook("builtin:review-pr")!;
const customPlaybook = Playbook.parse({
  id: CUSTOM_ID,
  name: "Careful story",
  description: "Implements a story with extra checks.",
  role: "story",
  systemPrompt: "You are a careful engineer.",
  promptTemplate: "Implement {{story.title}}.",
  model: "claude-opus-5-5",
  tools: { builtin: ["Read"], agent: ["ship"], linear: [], mcpServers: [] },
  setupCommands: [{ name: "deps", command: "pnpm install", timeoutSeconds: 60 }],
  variableLimits: { "story.description": 4000 },
  coding: { verifyCommands: ["pnpm test"], maxAttemptsPerStory: 5 },
});

function detailOf(playbook: Playbook, builtin = false): PlaybookDetailData {
  return {
    playbook,
    builtin,
    tokenBudgetLabel: playbook.tokenBudget
      ? `${playbook.tokenBudget.tokens.toLocaleString("en-US")} tokens`
      : "No limit",
    requirements: { minAgentVersion: null, installables: [], hostTools: [] },
    usedBy: noUsers,
  };
}

function summaryOf(playbook: Playbook, builtin = false): PlaybookSummary {
  return {
    id: playbook.id,
    name: playbook.name,
    description: playbook.description,
    role: playbook.role,
    builtin,
    model: playbook.model,
    usedBy: noUsers,
  };
}

function savedAnswer(playbook: Playbook): SavedPlaybook {
  return { ok: true, id: playbook.id, detail: detailOf(playbook), summary: summaryOf(playbook) };
}

const formOptions: PlaybookFormOptions = {
  roles: [...CUSTOM_PLAYBOOK_ROLES],
  models: [
    { value: "claude-opus-5-5", displayName: "Opus 5.5" },
    { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  ],
  tools: { builtin: [...CLAUDE_CODE_TOOLS], agent: [...AGENT_TOOLS], linear: [...LINEAR_TOOLS] },
  mcpServers: ["@omniralph/code-graph:graph"],
  prDescriptionPlaybooks: [{ id: "builtin:describe-pr", name: "Describe a PR", builtin: true }],
};

/** The server: its playbooks, and what each write answers (set per test). */
let list: PlaybookSummary[];
let details: Record<string, PlaybookDetailData>;
let options: PlaybookFormOptions;
/** While true, every playbook read hangs: what shows comes from the mutation's answer. */
let holdReads: boolean;
let answers: {
  create: () => Response;
  update: () => Response;
  remove: () => Response;
  clone: () => Response;
};
let seen: SeenRequest[];

const pending = () => new Promise<Response>(() => {});
const read = (answer: () => unknown) => () => (holdReads ? pending() : jsonResponse(answer()));
const path = (id: string) => `/api/ui/playbooks/${encodeURIComponent(id)}`;

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset();
  nav.router.push.mockImplementation((to: string) => nav.go(to));
  list = [summaryOf(reviewPlaybook, true), summaryOf(customPlaybook)];
  details = {
    [reviewPlaybook.id]: detailOf(reviewPlaybook, true),
    [CUSTOM_ID]: detailOf(customPlaybook),
  };
  options = formOptions;
  holdReads = false;
  const refuse = () => jsonResponse({ error: "unexpected" }, 500);
  answers = { create: refuse, update: refuse, remove: refuse, clone: refuse };
  const detailRoutes = Object.fromEntries(
    [reviewPlaybook.id, CUSTOM_ID, NEW_ID, CLONE_ID].map((id) => [
      `GET ${path(id)}`,
      () => {
        if (holdReads) return pending();
        const detail = details[id];
        return detail ? jsonResponse(detail) : jsonResponse({ error: "Not found" }, 404);
      },
    ]),
  );
  seen = mockFetch({
    "GET /api/ui/connections": { connections: [] },
    "GET /api/ui/organization": () => jsonResponse(organizationSettings()),
    "GET /api/ui/playbooks": read(() => ({ playbooks: list })),
    "GET /api/ui/playbooks/form-options": () => jsonResponse(options),
    ...detailRoutes,
    "POST /api/ui/playbooks": () => answers.create(),
    [`PUT ${path(CUSTOM_ID)}`]: () => answers.update(),
    [`DELETE ${path(CUSTOM_ID)}`]: () => answers.remove(),
    [`POST ${path(reviewPlaybook.id)}/clone`]: () => answers.clone(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The page at `pathname`, as the app routes it. */
function PageAt({ pathname }: { pathname: string }) {
  if (pathname === PLAYBOOKS_PATH) return <PlaybooksSettingsPage />;
  if (pathname === `${PLAYBOOKS_PATH}/new`) return <NewPlaybookPage />;
  const edit = new RegExp(`^${PLAYBOOKS_PATH}/([^/]+)/edit$`).exec(pathname);
  if (edit) return <EditPlaybookEditor id={decodeURIComponent(edit[1]!)} />;
  const id = decodeURIComponent(pathname.slice(PLAYBOOKS_PATH.length + 1));
  return <PlaybookDetail key={id} id={id} />;
}

/** The app at `nav.pathname`; `router.push` moves it, keeping the query cache. */
function Pages() {
  const pathname = useSyncExternalStore(nav.subscribe, () => nav.pathname);
  return (
    <SettingsLayoutView>
      <PageAt pathname={pathname} />
    </SettingsLayoutView>
  );
}

function renderAt(
  pathname: string,
  { user = testUser, live }: { user?: SessionUser; live?: ReturnType<typeof fakeAbly> } = {},
) {
  nav.pathname = pathname;
  const pages = <Pages />;
  render(
    <CurrentUserProvider user={user}>
      <ShowAdvancedProvider initial={true}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider linkComponent={TestLink}>
            {live ? (
              <LiveProvider createClient={live.createClient} fetchToken={fakeToken}>
                {pages}
              </LiveProvider>
            ) : (
              pages
            )}
          </UiProvider>
        </QueryClientProvider>
      </ShowAdvancedProvider>
    </CurrentUserProvider>,
  );
}

const writes = () => seen.filter((request) => request.method !== "GET");
const field = (name: string) =>
  screen.getByLabelText(name, { selector: "input, textarea, select" });
const pageTitle = (name: string) => screen.findByRole("heading", { level: 2, name });

/** The text of the error a control names in its `aria-describedby`. */
function describedError(control: HTMLElement): string | undefined {
  const ids = control.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids
    .map((id) => document.getElementById(id))
    .find((element) => element?.classList.contains("or-field-error"))?.textContent;
}

function optionLabels(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((option) => option.textContent!);
}

async function openMenu() {
  const toolbar = await screen.findByRole("toolbar", { name: "Playbook actions" });
  await userEvent.click(within(toolbar).getByRole("button", { name: "More actions" }));
  return screen.findByRole("menu");
}

const menuLabels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent);

describe("creating a playbook", () => {
  it("offers every field, sends the playbook and shows it before any refetch", async () => {
    renderAt(PLAYBOOKS_PATH);
    expect(await screen.findByRole("table", { name: "Playbooks" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "New playbook" }).getAttribute("href")).toBe(
      `${PLAYBOOKS_PATH}/new`,
    );
    act(() => nav.go(`${PLAYBOOKS_PATH}/new`));
    expect(await pageTitle("New playbook")).toBeTruthy();

    // Role: the custom roles only, story first.
    const role = field("Role");
    expect((role as HTMLSelectElement).value).toBe("story");
    expect(optionLabels(role)).toEqual([
      "Review",
      "Review summary",
      "Correlation",
      "Story",
      "Request",
      "Pull request description",
      "Chat answer",
    ]);
    expect(optionLabels(field("System prompt mode"))).toEqual([
      "Added to Claude Code's",
      "Replaces Claude Code's",
    ]);
    expect(optionLabels(field("Model"))).toEqual(["Claude Code default", "Opus 5.5", "Sonnet 5.5"]);
    expect(optionLabels(field("Fallback model"))).toEqual([
      "Claude Code default",
      "Opus 5.5",
      "Sonnet 5.5",
    ]);
    expect(optionLabels(field("Token budget"))).toEqual(["No limit", "A number of tokens"]);
    for (const group of ["Built-in tools", "Agent tools", "Linear tools", "Access"]) {
      expect(screen.getByRole("group", { name: group })).toBeTruthy();
    }
    expect(screen.getByRole("region", { name: "Coding" })).toBeTruthy();

    await userEvent.type(field("Name"), "Strict story");
    await userEvent.type(field("Description"), "Runs every check.");
    await userEvent.selectOptions(field("System prompt mode"), "replace");
    await userEvent.type(field("System prompt"), "Be strict.");
    await userEvent.type(field("Prompt template"), "Do it.");
    await userEvent.click(screen.getByRole("button", { name: "Add reference doc" }));
    await userEvent.type(field("Reference doc 1 name"), "Style");
    await userEvent.type(field("Reference doc 1"), "Use tabs.");
    await userEvent.selectOptions(field("Model"), "claude-opus-5-5");
    await userEvent.selectOptions(field("Fallback model"), "claude-sonnet-5-5");
    await userEvent.selectOptions(field("Token budget"), "limited");
    await userEvent.type(field("Tokens"), "200000");
    const builtins = screen.getByRole("group", { name: "Built-in tools" });
    await userEvent.click(within(builtins).getByRole("checkbox", { name: "Read" }));
    await userEvent.click(within(builtins).getByRole("checkbox", { name: "Grep" }));
    await userEvent.click(
      within(screen.getByRole("group", { name: "Agent tools" })).getByRole("checkbox", {
        name: "ship",
      }),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Shell" }));

    // MCP servers: only the offered ones.
    const servers = field("MCP servers");
    await userEvent.type(servers, "other:server{Enter}");
    expect(screen.getByText("Choose one of @omniralph/code-graph:graph.")).toBeTruthy();
    await userEvent.clear(servers);
    await userEvent.type(servers, "@omniralph/code-graph:graph{Enter}");
    await userEvent.type(field("Packages"), "@omniralph/code-graph{Enter}");
    await userEvent.type(field("Host tools"), "semgrep{Enter}");

    // Setup commands: an ordered list, rows moved and removed.
    const addSetup = screen.getByRole("button", { name: "Add setup command" });
    await userEvent.click(addSetup);
    await userEvent.type(field("Setup command 1 name"), "env");
    await userEvent.type(field("Setup command 1"), "cp .env.example .env");
    await userEvent.click(addSetup);
    await userEvent.type(field("Setup command 2 name"), "deps");
    await userEvent.type(field("Setup command 2"), "pnpm install");
    await userEvent.click(screen.getByRole("button", { name: "Move setup command 2 up" }));
    expect(
      within(screen.getByRole("list", { name: "Setup commands" }))
        .getAllByRole("listitem")
        .map((row) => within(row).getAllByRole("textbox")[0]!.getAttribute("value")),
    ).toEqual(["deps", "env"]);
    await userEvent.click(screen.getByRole("button", { name: "Add teardown command" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove teardown command 1" }));
    expect(screen.queryByRole("list", { name: "Teardown commands" })).toBeNull();

    // Coding settings.
    await userEvent.click(screen.getByRole("button", { name: "Add verify command" }));
    await userEvent.type(field("Verify command 1"), "pnpm test");
    await userEvent.type(field("Worktree setup"), "pnpm install");
    await userEvent.selectOptions(field("Epic completed state"), "completed");
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "Run the PRD's quality gates after the verify commands",
      }),
    );

    const created = Playbook.parse({
      ...draftToInput(newDraft("story")),
      id: NEW_ID,
      name: "Strict story",
      promptTemplate: "Do it.",
    });
    answers.create = () => {
      holdReads = true;
      return jsonResponse(savedAnswer(created));
    };
    await userEvent.click(screen.getByRole("button", { name: "Create playbook" }));

    expect(await pageTitle("Strict story")).toBeTruthy();
    expect(nav.router.push).toHaveBeenCalledWith(playbookHref(NEW_ID));
    expect(ui.toast).toHaveBeenCalledWith("Created Strict story");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.body).toEqual({
      name: "Strict story",
      description: "Runs every check.",
      role: "story",
      systemPrompt: "Be strict.",
      systemPromptMode: "replace",
      promptTemplate: "Do it.",
      referenceDocs: [{ name: "Style", content: "Use tabs." }],
      model: "claude-opus-5-5",
      fallbackModel: "claude-sonnet-5-5",
      tokenBudget: { tokens: 200000 },
      tools: {
        builtin: ["Grep", "Read"],
        agent: ["ship"],
        linear: [],
        mcpServers: ["@omniralph/code-graph:graph"],
      },
      toolSettings: { shell: true, linearRead: false, network: false },
      requires: { installables: ["@omniralph/code-graph"], hostTools: ["semgrep"] },
      setupCommands: [
        { name: "deps", command: "pnpm install" },
        { name: "env", command: "cp .env.example .env" },
      ],
      teardownCommands: [],
      coding: {
        verifyCommands: ["pnpm test"],
        worktreeSetupCommand: "pnpm install",
        runPrdQualityGates: false,
        allowPreparation: true,
        epicCompletedState: "completed",
        cleanupMergedWorktrees: true,
        unmergedBranchTimeoutMinutes: 60,
        prDescriptionPlaybookId: "builtin:describe-pr",
      },
    });

    // The list has it too, while its refetch is still pending.
    act(() => nav.go(PLAYBOOKS_PATH));
    const table = await screen.findByRole("table", { name: "Playbooks" });
    expect(within(table).getByRole("link", { name: "Strict story" })).toBeTruthy();
  });

  it("hides the token budget and coding settings for a review role, and drops tools it can't use", async () => {
    renderAt(`${PLAYBOOKS_PATH}/new`);
    expect(await pageTitle("New playbook")).toBeTruthy();
    const agentTools = () => screen.getByRole("group", { name: "Agent tools" });
    await userEvent.click(within(agentTools()).getByRole("checkbox", { name: "ship" }));
    await userEvent.selectOptions(field("Role"), "review");
    expect(screen.queryByLabelText("Token budget")).toBeNull();
    expect(screen.queryByRole("region", { name: "Coding" })).toBeNull();
    expect(within(agentTools()).queryByRole("checkbox", { name: "ship" })).toBeNull();
    // The model stays: the server says why a review playbook can't set one.
    expect(field("Model")).toBeTruthy();

    answers.create = () =>
      jsonResponse(
        {
          error: "Fix the highlighted fields.",
          fieldErrors: {
            name: "Too small: expected string to have >=1 characters",
            promptTemplate: "Too small: expected string to have >=1 characters",
          },
        },
        400,
      );
    await userEvent.click(screen.getByRole("button", { name: "Create playbook" }));
    await waitFor(() => expect(describedError(field("Name"))).toContain("Too small"));
    expect(describedError(field("Prompt template"))).toContain("Too small");
    expect(writes()[0]!.body).toMatchObject({ role: "review", tokenBudget: null });
    expect(writes()[0]!.body).not.toHaveProperty("coding");
    expect(writes()[0]!.body).toMatchObject({ tools: { agent: [] } });
  });

  it("checks the token budget before sending anything", async () => {
    renderAt(`${PLAYBOOKS_PATH}/new`);
    expect(await pageTitle("New playbook")).toBeTruthy();
    await userEvent.selectOptions(field("Token budget"), "limited");
    await userEvent.type(field("Tokens"), "lots");
    await userEvent.click(screen.getByRole("button", { name: "Create playbook" }));
    expect(describedError(field("Tokens"))).toBe('Enter a number of tokens, or choose "No limit".');
    expect(writes()).toEqual([]);
  });
});

describe("cloning a playbook", () => {
  it("copies a built-in and opens the copy in the editor before any refetch", async () => {
    renderAt(playbookHref(reviewPlaybook.id));
    expect(await pageTitle(reviewPlaybook.name)).toBeTruthy();
    const copy = Playbook.parse({
      ...reviewPlaybook,
      id: CLONE_ID,
      name: `${reviewPlaybook.name} copy`,
    });
    answers.clone = () => {
      holdReads = true;
      return jsonResponse(savedAnswer(copy));
    };
    const toolbar = screen.getByRole("toolbar", { name: "Playbook actions" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Clone" }));

    expect(await pageTitle(`Edit ${reviewPlaybook.name} copy`)).toBeTruthy();
    expect(nav.router.push).toHaveBeenCalledWith(playbookEditHref(CLONE_ID));
    expect(ui.toast).toHaveBeenCalledWith(`Created ${reviewPlaybook.name} copy`);
    expect((field("Name") as HTMLInputElement).value).toBe(`${reviewPlaybook.name} copy`);
    expect((field("Role") as HTMLSelectElement).disabled).toBe(true);
    expect(writes().map((request) => `${request.method} ${request.path}`)).toEqual([
      `POST ${path(reviewPlaybook.id)}/clone`,
    ]);
  });

  it("shows the server's refusal and stays", async () => {
    renderAt(playbookHref(reviewPlaybook.id));
    expect(await pageTitle(reviewPlaybook.name)).toBeTruthy();
    answers.clone = () =>
      jsonResponse({ error: "Review a pull request can't be cloned: too long." }, 400);
    await userEvent.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        "Review a pull request can't be cloned: too long.",
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(nav.router.push).not.toHaveBeenCalled();
  });
});

describe("editing a playbook", () => {
  it("shows the server's field errors next to their fields, then saves before any refetch", async () => {
    renderAt(PLAYBOOKS_PATH);
    expect(await screen.findByRole("table", { name: "Playbooks" })).toBeTruthy();
    act(() => nav.go(playbookHref(CUSTOM_ID)));
    expect(await pageTitle("Careful story")).toBeTruthy();
    const menu = await openMenu();
    expect(menuLabels(menu)).toEqual(["Copy playbook ID", "Edit", "Delete…"]);
    expect(within(menu).getByRole("menuitem", { name: "Edit" }).getAttribute("href")).toBe(
      playbookEditHref(CUSTOM_ID),
    );
    await userEvent.keyboard("{Escape}");
    act(() => nav.go(playbookEditHref(CUSTOM_ID)));
    expect(await pageTitle("Edit Careful story")).toBeTruthy();

    // The draft starts from the playbook; the role is fixed.
    expect((field("Name") as HTMLInputElement).value).toBe("Careful story");
    expect((field("Role") as HTMLSelectElement).disabled).toBe(true);
    expect((field("Model") as HTMLSelectElement).value).toBe("claude-opus-5-5");
    expect((field("Setup command 1") as HTMLInputElement).value).toBe("pnpm install");
    expect((field("Verify command 1") as HTMLInputElement).value).toBe("pnpm test");

    answers.update = () =>
      jsonResponse(
        {
          error: "Fix the highlighted fields.",
          fieldErrors: {
            model: "Story playbooks need a model an agent reports.",
            "setupCommands.0.name": "Use lowercase letters, digits and _, starting with a letter",
            "tools.agent": "A story playbook can't use get_attachment.",
            "toolSettings.linearRead": "Linear tools need Read Linear on.",
            outputSchema: "A story playbook can't declare an output schema.",
          },
        },
        400,
      );
    await userEvent.selectOptions(field("Model"), "claude-sonnet-5-5");
    await userEvent.clear(field("Setup command 1 name"));
    await userEvent.type(field("Setup command 1 name"), "Deps");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(describedError(field("Model"))).toBe("Story playbooks need a model an agent reports."),
    );
    const setupRow = within(screen.getByRole("list", { name: "Setup commands" })).getAllByRole(
      "listitem",
    )[0]!;
    expect(within(setupRow).getByText(/Use lowercase letters/)).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Agent tools" })).getByText(
        "A story playbook can't use get_attachment.",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: "Access" })).getByText(
        "Linear tools need Read Linear on.",
      ),
    ).toBeTruthy();
    // An error no field shows goes above the form.
    expect(screen.getByRole("alert").textContent).toBe(
      "A story playbook can't declare an output schema.",
    );
    expect(nav.router.push).not.toHaveBeenCalled();

    // What the editor doesn't show is kept: a command's timeout, variable limits, coding limits.
    expect(writes()[0]!.body).toMatchObject({
      model: "claude-sonnet-5-5",
      setupCommands: [{ name: "Deps", command: "pnpm install", timeoutSeconds: 60 }],
      variableLimits: { "story.description": 4000 },
      coding: { maxAttemptsPerStory: 5, verifyCommands: ["pnpm test"] },
    });
    expect(writes()[0]!.body).not.toHaveProperty("id");

    const saved = Playbook.parse({
      ...customPlaybook,
      name: "Careful story v2",
      model: "claude-sonnet-5-5",
    });
    answers.update = () => {
      holdReads = true;
      return jsonResponse(savedAnswer(saved));
    };
    await userEvent.clear(field("Name"));
    await userEvent.type(field("Name"), "Careful story v2");
    await userEvent.clear(field("Setup command 1 name"));
    await userEvent.type(field("Setup command 1 name"), "deps");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await pageTitle("Careful story v2")).toBeTruthy();
    expect(nav.router.push).toHaveBeenCalledWith(playbookHref(CUSTOM_ID));
    expect(ui.toast).toHaveBeenCalledWith("Saved Careful story v2");
    expect(screen.getByRole("region", { name: "Overview" }).textContent).toContain(
      "claude-sonnet-5-5",
    );
    act(() => nav.go(PLAYBOOKS_PATH));
    const table = await screen.findByRole("table", { name: "Playbooks" });
    expect(within(table).getByRole("link", { name: "Careful story v2" })).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Careful story" })).toBeNull();
  });

  it("refuses a built-in's editor, and says an unknown playbook doesn't exist", async () => {
    renderAt(playbookEditHref(reviewPlaybook.id));
    expect(await screen.findByRole("heading", { name: BUILTIN_READ_ONLY })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    cleanup();
    renderAt(playbookEditHref(NEW_ID));
    expect(
      await screen.findByRole("heading", { name: "This playbook doesn't exist." }),
    ).toBeTruthy();
  });
});

describe("deleting a playbook", () => {
  async function confirmDelete() {
    renderAt(playbookHref(CUSTOM_ID));
    expect(await pageTitle("Careful story")).toBeTruthy();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete Careful story?")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete playbook" }));
  }

  it("shows the refusal while something uses it, and keeps the playbook", async () => {
    const refusal = "Careful story can't be deleted while it's used by repo acme/api (story).";
    answers.remove = () => jsonResponse({ error: refusal, code: "playbook_in_use" }, 409);
    await confirmDelete();
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(
        refusal,
        expect.objectContaining({ variant: "danger" }),
      ),
    );
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: "Careful story" })).toBeTruthy();
  });

  it("deletes it and leaves it out of the list before any refetch", async () => {
    answers.remove = () => {
      holdReads = true;
      return jsonResponse({ ok: true });
    };
    // The list is cached from an earlier visit.
    renderAt(PLAYBOOKS_PATH);
    expect(await screen.findByRole("table", { name: "Playbooks" })).toBeTruthy();
    act(() => nav.go(playbookHref(CUSTOM_ID)));
    expect(await pageTitle("Careful story")).toBeTruthy();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete playbook",
      }),
    );

    const table = await screen.findByRole("table", { name: "Playbooks" });
    expect(nav.router.push).toHaveBeenCalledWith(PLAYBOOKS_PATH);
    expect(ui.toast).toHaveBeenCalledWith("Deleted Careful story");
    expect(within(table).queryByRole("link", { name: "Careful story" })).toBeNull();
    expect(within(table).getByRole("link", { name: reviewPlaybook.name })).toBeTruthy();
    expect(writes().map((request) => `${request.method} ${request.path}`)).toEqual([
      `DELETE ${path(CUSTOM_ID)}`,
    ]);
  });

  it("can be canceled", async () => {
    renderAt(playbookHref(CUSTOM_ID));
    expect(await pageTitle("Careful story")).toBeTruthy();
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete…" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(writes()).toEqual([]);
  });
});

describe("who sees which actions", () => {
  it("gives built-ins Clone but no Edit or Delete", async () => {
    renderAt(playbookHref(reviewPlaybook.id));
    expect(await pageTitle(reviewPlaybook.name)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clone" })).toBeTruthy();
    expect(menuLabels(await openMenu())).toEqual(["Copy playbook ID"]);
  });

  it("gives members no New playbook, Clone, Edit, Delete or editor", async () => {
    renderAt(PLAYBOOKS_PATH, { user: member });
    expect(await screen.findByRole("table", { name: "Playbooks" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "New playbook" })).toBeNull();

    act(() => nav.go(playbookHref(CUSTOM_ID)));
    expect(await pageTitle("Careful story")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clone" })).toBeNull();
    expect(menuLabels(await openMenu())).toEqual(["Copy playbook ID"]);
    await userEvent.keyboard("{Escape}");

    for (const to of [`${PLAYBOOKS_PATH}/new`, playbookEditHref(CUSTOM_ID)]) {
      act(() => nav.go(to));
      expect(await screen.findByRole("heading", { name: ADMINS_ONLY })).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
    }
    expect(seen.some((request) => request.path === "/api/ui/playbooks/form-options")).toBe(false);
  });
});

describe("live updates", () => {
  it("offers a model an agent starts reporting", async () => {
    const live = fakeAbly();
    renderAt(`${PLAYBOOKS_PATH}/new`, { live });
    expect(await pageTitle("New playbook")).toBeTruthy();
    const channel = `org:${TEST_ORGANIZATION_ID}:changes`;
    await waitFor(() => expect(live.current().subscribed()).toContain(channel));
    options = {
      ...formOptions,
      models: [...formOptions.models, { value: "claude-fable-5-1", displayName: "Fable 5.1" }],
    };
    act(() =>
      live.current().deliver(
        channel,
        changeEvent(TEST_ORGANIZATION_ID, {
          resource: "agent",
          ids: ["88888888-8888-4888-8888-888888888888"],
        }),
      ),
    );
    await waitFor(() => expect(optionLabels(field("Model"))).toContain("Fable 5.1"));
    // What's typed stays.
    expect((field("Role") as HTMLSelectElement).value).toBe("story");
  });
});

describe("the draft", () => {
  it("keeps what the editor doesn't show and drops coding settings for other roles", () => {
    const draft = draftFromPlaybook(customPlaybook);
    expect(draftToInput(draft)).toMatchObject({
      variableLimits: { "story.description": 4000 },
      coding: { maxAttemptsPerStory: 5 },
    });
    expect(draftToInput({ ...draft, role: "chat-ask" })).not.toHaveProperty("coding");
  });

  it("gives a new correlation playbook its fixed output", () => {
    expect(draftToInput(newDraft("correlation")).outputSchema).toEqual(CORRELATION_OUTPUT_SCHEMA);
    expect(draftToInput(newDraft("chat-ask"))).not.toHaveProperty("outputSchema");
  });

  it("places errors by field path", () => {
    const errors = { "setupCommands.1.name": "Bad name", outputSchema: "Bad output", model: "No" };
    expect(errorAt(errors, "setupCommands")).toBe("Bad name");
    expect(errorAt(errors, "setupCommands.1")).toBe("Bad name");
    expect(errorAt(errors, "teardownCommands")).toBeUndefined();
    expect(unplacedErrors(errors, "story")).toEqual(["Bad output"]);
    expect(unplacedErrors({ tokenBudget: "No budget" }, "review")).toEqual(["No budget"]);
  });
});
