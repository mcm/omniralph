// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
} from "@/components/query-test-utils";
import { connectionHealth, type ConnectionHealthSummary } from "@/lib/connections/health";
import { ConnectGitHubButton, GITHUB_NOT_CONFIGURED } from "./connect-github-button";
import { ConnectionHealth, type ConnectionHealthProps } from "./connection-health";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const NOW = new Date("2026-10-26T12:00:00.000Z");
const REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

function gitlab(
  problems: { code: string; message: string; repositoryId?: string }[],
  tokenExpiresAt: string | null = "2027-06-01",
): ConnectionHealthSummary {
  return connectionHealth(
    {
      provider: "gitlab",
      health: { checkedAt: "2026-10-26T04:45:00.000Z", tokenExpiresAt, problems },
    },
    NOW,
  );
}

function renderHealth(props: ConnectionHealthProps) {
  const client = createTestQueryClient();
  return render(<ConnectionHealth {...props} />, { wrapper: queryWrapper(client) });
}

/** The visible state line: its text and its tone class. */
function stateLine(container: HTMLElement) {
  const line = container.querySelector<HTMLElement>(".or-status")!;
  return { text: line.textContent, tone: line.className };
}

afterEach(() => {
  vi.unstubAllGlobals();
  ui.toast.mockReset();
});

describe("ConnectionHealth", () => {
  it("says Healthy in mint for a checked connection with nothing wrong", () => {
    const { container } = renderHealth({ health: gitlab([]) });
    expect(stateLine(container)).toEqual({ text: "Healthy", tone: "or-status or-status--good" });
    expect(container.querySelector("li")).toBeNull();
  });

  it("says when a soon-expiring token expires, in neutral", () => {
    const { container } = renderHealth({ health: gitlab([], "2026-11-02") });
    expect(stateLine(container)).toEqual({
      text: "Expires Nov 2",
      tone: "or-status or-status--neutral",
    });
  });

  it("says Not checked yet before the first check, and Connected for GitHub", () => {
    const notChecked = connectionHealth({ provider: "gitlab", health: null }, NOW);
    const { container, unmount } = renderHealth({ health: notChecked });
    expect(stateLine(container).text).toBe("Not checked yet");
    unmount();
    const github = connectionHealth({ provider: "github", health: null }, NOW);
    expect(stateLine(renderHealth({ health: github }).container).text).toBe("Connected");
  });

  it("says Needs attention in coral and lists each problem's sentence", () => {
    const { container } = renderHealth({
      health: gitlab([
        { code: "token_invalid", message: "GitLab rejects the bot token." },
        { code: "missing_api_scope", message: "The bot token needs the api scope." },
        { code: "rotation_failed", message: "Rotating the bot token failed: boom" },
      ]),
    });
    expect(stateLine(container)).toEqual({
      text: "Needs attention",
      tone: "or-status or-status--fail",
    });
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "GitLab rejects the bot token.",
      "The bot token needs the api scope.",
      "Rotating the bot token failed: boom",
    ]);
  });

  it("offers Recreate webhook for missing and outdated webhooks only, and only when allowed", () => {
    const health = gitlab([
      {
        code: "webhook_missing",
        message: "acme/api has no Omniralph webhook.",
        repositoryId: "r1",
      },
      {
        code: "webhook_events_outdated",
        message: "The webhook of acme/web lacks pipeline events.",
        repositoryId: "r2",
      },
      { code: "token_invalid", message: "GitLab rejects the bot token." },
    ]);
    const { container, unmount } = renderHealth({ health, canRecreateWebhook: true });
    const item = (code: string) =>
      container.querySelector<HTMLElement>(`[data-problem="${code}"]`)!;
    expect(within(item("webhook_missing")).getByRole("button", { name: "Recreate webhook" }));
    expect(
      within(item("webhook_events_outdated")).getByRole("button", { name: "Recreate webhook" }),
    );
    expect(within(item("token_invalid")).queryByRole("button")).toBeNull();
    unmount();
    renderHealth({ health });
    expect(screen.queryByRole("button", { name: "Recreate webhook" })).toBeNull();
  });

  it("recreates the webhook and hands the result to onWebhookRecreated", async () => {
    const seen = mockFetch({
      [`POST /api/ui/repositories/${REPO_ID}/webhook`]: () => jsonResponse({ ok: true }),
    });
    const onWebhookRecreated = vi.fn();
    renderHealth({
      health: gitlab([
        { code: "webhook_missing", message: "acme/api has no webhook.", repositoryId: REPO_ID },
      ]),
      canRecreateWebhook: true,
      onWebhookRecreated,
    });
    await userEvent.click(screen.getByRole("button", { name: "Recreate webhook" }));
    await waitFor(() => expect(onWebhookRecreated).toHaveBeenCalledTimes(1));
    expect(onWebhookRecreated.mock.calls[0]![0]).toBe(REPO_ID);
    expect(seen.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(ui.toast).toHaveBeenCalledWith("Webhook recreated");
  });
});

describe("ConnectGitHubButton", () => {
  it("links to the install path", () => {
    render(<ConnectGitHubButton installPath="/repositories/github/install?organization=o1" />);
    expect(screen.getByRole("link", { name: "Connect GitHub" }).getAttribute("href")).toBe(
      "/repositories/github/install?organization=o1",
    );
  });

  it("is disabled, saying why, when the GitHub App isn't configured", async () => {
    render(<ConnectGitHubButton installPath={null} />);
    const button = screen.getByRole("button", { name: "Connect GitHub" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.tab();
    expect((await screen.findByRole("tooltip")).textContent).toBe(GITHUB_NOT_CONFIGURED);
  });

  it("is disabled without a reason while the setup loads", () => {
    render(<ConnectGitHubButton installPath={undefined} />);
    expect(
      (screen.getByRole("button", { name: "Connect GitHub" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
