// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ClaudeStatus } from "../../../../src/claude-status.js";
import type { AgentUiState } from "../../state.js";
import {
  NARROW,
  WIDE,
  agentState,
  fakeApi,
  fakeEventSources,
  renderAgentPage,
} from "../../test/page.js";
import { CHECK_FAILED, NOT_CHECKED, NOT_SIGNED_IN, NO_MODELS } from "./model.js";

const MINUTES_AGO = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const MODELS = [
  { value: "opus", displayName: "Opus 5.5" },
  { value: "sonnet", displayName: "Sonnet 5.5" },
];

function signedIn(overrides: Partial<ClaudeStatus> = {}): ClaudeStatus {
  return {
    status: "signed_in",
    source: "login",
    account: { email: "steve@example.com", organization: "Example", subscriptionType: "max" },
    models: MODELS,
    checkedAt: MINUTES_AGO(5),
    ...overrides,
  };
}

function signedOut(): ClaudeStatus {
  return {
    status: "signed_out",
    source: null,
    models: [],
    checkedAt: MINUTES_AGO(2),
    error: "Not logged in · Please run /login",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What `/api/state` answers now. */
interface Machine {
  claude: AgentUiState["claude"];
  user?: string | null;
}

async function openClaude({
  claude = signedIn(),
  user = "omniralph",
  width = WIDE,
  routes = () => ({}),
}: {
  claude?: AgentUiState["claude"];
  user?: string | null;
  width?: number;
  routes?: (machine: Machine) => Parameters<typeof fakeApi>[0];
} = {}) {
  const machine: Machine = { claude, user };
  const api = fakeApi({
    "/api/state": () => ({ body: agentState(machine) }),
    ...routes(machine),
  });
  const streams = fakeEventSources();
  renderAgentPage({ path: "/claude", width, createEventSource: streams.create });
  await screen.findByRole("heading", { level: 2, name: "Claude", hidden: true });
  await screen.findByRole("region", { name: "Login" });
  return { api, streams, machine };
}

function login(): HTMLElement {
  return screen.getByRole("region", { name: "Login" });
}

function models(): HTMLElement {
  return screen.getByRole("region", { name: "Models" });
}

function checkAgain(): HTMLButtonElement {
  return within(login()).getByRole("button", { name: /Check again|Checking/ }) as HTMLButtonElement;
}

describe("the Claude page", () => {
  it("says who is signed in with the Claude login, the models and when it was checked", async () => {
    await openClaude();
    expect(within(login()).getByText("Signed in as steve@example.com · Max")).toBeTruthy();
    expect(within(login()).getByText("Claude login")).toBeTruthy();
    expect(within(login()).getByText("5 minutes ago")).toBeTruthy();
    expect(within(login()).getByText(/^Last checked/)).toBeTruthy();
    expect(within(models()).getByRole("list", { name: "Models" }).textContent).toBe(
      "Opus 5.5Sonnet 5.5",
    );
    expect(checkAgain().disabled).toBe(false);
    expect(checkAgain().textContent).toBe("Check again");
    // Never a failure tone while signed in.
    expect(document.querySelector(".or-status--fail")).toBeNull();
  });

  it("names an API key from ANTHROPIC_API_KEY", async () => {
    await openClaude({
      claude: signedIn({
        source: "api_key",
        account: { email: null, organization: null, subscriptionType: null },
      }),
    });
    expect(within(login()).getByText("Signed in")).toBeTruthy();
    expect(within(login()).getByText("API key from ANTHROPIC_API_KEY")).toBeTruthy();
  });

  it("names an OAuth token from CLAUDE_CODE_OAUTH_TOKEN", async () => {
    await openClaude({
      claude: signedIn({
        source: "oauth_token",
        account: { email: "ops@example.com", organization: null, subscriptionType: "team" },
      }),
    });
    expect(within(login()).getByText("Signed in as ops@example.com · Team")).toBeTruthy();
    expect(within(login()).getByText("OAuth token from CLAUDE_CODE_OAUTH_TOKEN")).toBeTruthy();
  });

  it("says Not signed in in the fail tone and how to sign in as the agent's OS user", async () => {
    await openClaude({ claude: signedOut(), user: "ci" });
    const headline = within(login()).getByText(NOT_SIGNED_IN);
    expect(NOT_SIGNED_IN).toBe("Not signed in");
    expect(headline.closest(".or-status--fail")).not.toBeNull();
    const how = within(login()).getByText(/^Sign in on this machine/);
    expect(how.textContent).toBe(
      "Sign in on this machine as ci by running claude, then check again.",
    );
    expect(within(how).getByText("claude").tagName).toBe("CODE");
    expect(within(models()).getByText(NO_MODELS)).toBeTruthy();
    expect(NO_MODELS).toBe("None reported");
  });

  it("leaves the user out of the sign-in sentence when it can't be read", async () => {
    await openClaude({ claude: signedOut(), user: null });
    expect(within(login()).getByText(/^Sign in on this machine/).textContent).toBe(
      "Sign in on this machine by running claude, then check again.",
    );
  });

  it("says it couldn't check (unknown) with the reason, without the fail tone", async () => {
    await openClaude({
      claude: {
        status: "unknown",
        source: null,
        models: [],
        checkedAt: MINUTES_AGO(90),
        error: "timed out checking Claude",
      },
    });
    expect(within(login()).getByText(CHECK_FAILED)).toBeTruthy();
    expect(within(login()).getByText("timed out checking Claude")).toBeTruthy();
    expect(within(login()).getByText("1 hour ago")).toBeTruthy();
    expect(within(login()).queryByText(/^Sign in on this machine/)).toBeNull();
    expect(document.querySelector(".or-status--fail")).toBeNull();
    expect(within(models()).getByText(NO_MODELS)).toBeTruthy();
  });

  it("says None reported when a signed-in agent reports no models", async () => {
    await openClaude({ claude: signedIn({ models: [] }) });
    expect(within(models()).getByText("None reported")).toBeTruthy();
    expect(within(models()).queryByRole("list")).toBeNull();
  });

  it("says Not checked yet before the first check", async () => {
    await openClaude({ claude: null });
    expect(within(login()).getByText(NOT_CHECKED)).toBeTruthy();
    expect(within(login()).queryByText(/^Last checked/)).toBeNull();
  });

  it("Check again is disabled while checking, and the claude event updates the page", async () => {
    const reply = deferred<{ body: unknown }>();
    const { api, streams, machine } = await openClaude({
      claude: signedOut(),
      routes: () => ({ "POST /api/claude/check": () => reply.promise }),
    });
    streams.latest().open();
    await userEvent.click(checkAgain());
    await waitFor(() => expect(checkAgain().disabled).toBe(true));
    expect(checkAgain().textContent).toBe("Checking…");
    expect(api.count("POST /api/claude/check")).toBe(1);

    // The daemon's read finished: its `claude` event refetches the state.
    machine.claude = signedIn({ checkedAt: new Date().toISOString() });
    streams.latest().change({ resource: "claude" });
    await within(login()).findByText("Signed in as steve@example.com · Max");
    expect(within(login()).getByText("just now")).toBeTruthy();
    expect(within(models()).getByText("Opus 5.5")).toBeTruthy();
    expect(screen.queryByText(NOT_SIGNED_IN)).toBeNull();

    reply.resolve({ body: { claude: machine.claude } });
    await waitFor(() => expect(checkAgain().disabled).toBe(false));
  });

  it("shows Check again's answer before any refetch resolves", async () => {
    const refetch = deferred<{ body: unknown }>();
    let states = 0;
    const answer = signedIn({ checkedAt: new Date().toISOString() });
    fakeApi({
      "/api/state": () => {
        states += 1;
        return states === 1 ? { body: agentState({ claude: signedOut() }) } : refetch.promise;
      },
      "POST /api/claude/check": { body: { claude: answer } },
    });
    renderAgentPage({ path: "/claude", createEventSource: fakeEventSources().create });
    await screen.findByText(NOT_SIGNED_IN);
    await userEvent.click(checkAgain());
    await within(login()).findByText("Signed in as steve@example.com · Max");
    expect(states).toBeGreaterThanOrEqual(2);
    refetch.resolve({ body: agentState({ claude: answer }) });
  });

  it("opens full screen with a back link at narrow widths", async () => {
    await openClaude({ width: NARROW, claude: signedOut() });
    expect(document.querySelector(".or-split")?.getAttribute("data-view")).toBe("detail");
    expect(screen.getByRole("link", { name: "Agent" })).toBeTruthy();
    expect(within(login()).getByText(NOT_SIGNED_IN)).toBeTruthy();
    expect(checkAgain()).toBeTruthy();
  });
});
