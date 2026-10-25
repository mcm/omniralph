// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { clearToasts, Toaster } from "@omniralph/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import { AuthShell } from "@/components/auth-shell";
import { ChatLinkView } from "./chat-link-view";

vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));
const actions = vi.hoisted(() => ({
  linkChatAccountAction: vi.fn<(state: string) => Promise<ActionResult>>(),
}));
vi.mock("./actions", () => actions);

beforeEach(() => {
  actions.linkChatAccountAction.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  act(() => clearToasts());
});

const confirmation = {
  state: "signed.state",
  platform: "slack" as const,
  displayName: "ada",
  organizationName: "Acme",
  connectionName: "Acme Slack",
};

function renderView(props: React.ComponentProps<typeof ChatLinkView>) {
  return render(
    <>
      <AuthShell>
        <ChatLinkView {...props} />
      </AuthShell>
      <Toaster />
    </>,
  );
}

describe("ChatLinkView", () => {
  it("asks to link the chat user, naming Om", () => {
    renderView({ confirmation });
    expect(screen.getByRole("heading", { level: 1, name: "Link Slack account" })).toBeTruthy();
    expect(screen.getByText(/Om will act as you for this Slack user in Acme Slack/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Cancel" }).getAttribute("href")).toBe("/");
  });

  it("links the account and leads to the chat accounts", async () => {
    const user = userEvent.setup();
    renderView({ confirmation });
    await user.click(screen.getByRole("button", { name: "Link" }));
    expect(actions.linkChatAccountAction).toHaveBeenCalledWith("signed.state");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Slack account linked" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Linked ada");
    expect(screen.getByRole("link", { name: "Chat accounts" }).getAttribute("href")).toBe(
      "/settings/chat-accounts",
    );
  });

  it("shows a failed link in an alert and stays on the question", async () => {
    actions.linkChatAccountAction.mockResolvedValue({
      ok: false,
      error: "This link was used already.",
    });
    const user = userEvent.setup();
    renderView({ confirmation });
    await user.click(screen.getByRole("button", { name: "Link" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This link was used already.");
    expect(screen.getByRole("heading", { level: 1, name: "Link Slack account" })).toBeTruthy();
  });

  it("explains a link that can't be used in an alert", () => {
    renderView({ problem: "This link has expired. Mention Om again to get a new one." });
    expect(
      screen.getByRole("heading", { level: 1, name: "Can't link this chat account" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "This link has expired. Mention Om again to get a new one.",
    );
    expect(
      screen.getByRole("link", { name: "Back to the control panel" }).getAttribute("href"),
    ).toBe("/");
  });
});
