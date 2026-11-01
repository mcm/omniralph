// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { parseRequestDraftValue, requestDraftAddValue } from "@/lib/api/ask";
import { runHref } from "@/lib/runs/hrefs";
import { AskCard } from "./ask-card";
import { GenericCard } from "./generic-card";
import { WorkItemDraftCard } from "./work-item-draft-card";
import { RequestDraftCard } from "./request-draft-card";
import { DRAFT_ID, workItemDraft, requestDraft } from "./test-fixtures";

function RouterLink(props: LinkProps) {
  return <a data-router="yes" {...props} />;
}

const renderUi = (element: ReactElement) =>
  render(<UiProvider linkComponent={RouterLink}>{element}</UiProvider>);

const buttons = () => screen.queryAllByRole("button");
const variantOf = (button: HTMLElement) =>
  /or-btn--(outline|solid|primary|ghost|danger)/.exec(button.className)?.[1];

describe("RequestDraftCard", () => {
  it('shows the "Request" badge, the repo and the title', () => {
    renderUi(<RequestDraftCard draft={requestDraft()} />);
    const card = screen.getByRole("region", { name: "Remember the email on the login form" });
    const meta = card.querySelector(".or-ask-card__meta")!;
    const badges = Array.from(meta.children) as HTMLElement[];
    expect(badges[0]!.className).toContain("or-ref--meta");
    expect(badges[0]!.textContent).toContain("Request");
    expect(badges[0]!.querySelector(".tabler-icon-code")).not.toBeNull();
    expect(badges[1]!.className).toContain("or-ref--repo");
    expect(within(badges[1]!).getByRole("img", { name: "GitHub" })).toBeTruthy();
    expect(badges[1]!.textContent).toContain("acme/customer-portal");
  });

  it("offers Start request (solid), Add to backlog (outline) and Not now (ghost) with Triage now above them", () => {
    const { container } = renderUi(<RequestDraftCard draft={requestDraft()} />);
    expect(buttons().map((b) => [b.textContent, variantOf(b)])).toEqual([
      ["Start request", "solid"],
      ["Add to backlog", "outline"],
      ["Not now", "ghost"],
    ]);
    const box = screen.getByRole("checkbox", { name: "Triage now" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    const triage = container.querySelector(".or-wi-triage-now")!;
    const actions = container.querySelector(".or-ask-card__actions")!;
    expect(triage.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves out Add to backlog and Triage now when the view doesn't offer it", () => {
    const draft = requestDraft();
    renderUi(
      <RequestDraftCard
        draft={{ ...draft, actions: draft.actions.filter((a) => a.id !== "request_draft_add") }}
      />,
    );
    expect(buttons().map((b) => b.textContent)).toEqual(["Start request", "Not now"]);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("sends each button's action, and Add to backlog with the Triage now choice", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderUi(<RequestDraftCard draft={requestDraft()} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Start request" }));
    expect(onAction).toHaveBeenLastCalledWith({ actionId: "request_draft_start", value: DRAFT_ID });
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onAction).toHaveBeenLastCalledWith({
      actionId: "request_draft_dismiss",
      value: DRAFT_ID,
    });
    await user.click(screen.getByRole("button", { name: "Add to backlog" }));
    expect(onAction).toHaveBeenLastCalledWith({
      actionId: "request_draft_add",
      value: requestDraftAddValue(DRAFT_ID, true),
    });
    await user.click(screen.getByRole("checkbox", { name: "Triage now" }));
    await user.click(screen.getByRole("button", { name: "Add to backlog" }));
    const value = onAction.mock.lastCall![0].value as string;
    expect(parseRequestDraftValue(value)).toEqual({ draftId: DRAFT_ID, triageNow: false });
  });

  it("disables the buttons and the checkbox while a click is in flight", () => {
    renderUi(<RequestDraftCard draft={requestDraft()} pending />);
    for (const button of buttons()) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });

  it("asks the follow-up question with the view's buttons when it has one", () => {
    renderUi(
      <RequestDraftCard
        draft={requestDraft({
          triageChoice: "follow_up",
          question: "Triage it now?",
          actions: [
            {
              id: "request_draft_add_triage",
              label: "Triage now",
              value: DRAFT_ID,
              style: "solid",
            },
            {
              id: "request_draft_add_no_triage",
              label: "Add without triage",
              value: DRAFT_ID,
              style: "outline",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Triage it now?")).toBeTruthy();
    expect(buttons().map((b) => [b.textContent, variantOf(b)])).toEqual([
      ["Triage now", "solid"],
      ["Add without triage", "outline"],
    ]);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows Request started with the run's link in place of the buttons", () => {
    renderUi(
      <RequestDraftCard
        draft={requestDraft({
          status: "started",
          actions: [],
          outcome: {
            kind: "started",
            text: "Request started",
            run: { id: "run-9", url: "https://app.example/runs/run-9" },
            workItem: null,
          },
        })}
      />,
    );
    expect(buttons()).toEqual([]);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Request started")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
      runHref("run-9"),
    );
  });

  it("shows Added to the backlog with the work item's badge", () => {
    renderUi(
      <RequestDraftCard
        draft={requestDraft({
          status: "added",
          actions: [],
          outcome: {
            kind: "added",
            text: "Added to the backlog · Om is triaging it",
            run: null,
            workItem: { tracker: "linear", identifier: "TOOL-77", url: "https://linear.app/t/77" },
          },
        })}
      />,
    );
    expect(screen.getByText("Added to the backlog · Om is triaging it")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Linear TOOL-77 (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe("https://linear.app/t/77");
  });

  it.each([
    ["dismissed", "Not now"],
    ["expired", "This draft expired"],
  ] as const)("shows %s quietly", (kind, text) => {
    const { container } = renderUi(
      <RequestDraftCard
        draft={requestDraft({
          status: kind,
          actions: [],
          outcome: { kind, text, run: null, workItem: null },
        })}
      />,
    );
    expect(buttons()).toEqual([]);
    const outcome = container.querySelector(".or-ask-card__outcome")!;
    expect(outcome.textContent).toBe(text);
    expect(outcome.className).toContain("or-ask-card__outcome--quiet");
  });

  it("shows a click's error in an alert under the card and keeps the buttons", () => {
    const { container, rerender } = renderUi(
      <RequestDraftCard
        draft={requestDraft({ error: "Coding is off for acme/customer-portal." })}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Coding is off for acme/customer-portal.");
    const card = container.querySelector("section.or-card")!;
    expect(card.contains(alert)).toBe(false);
    expect(card.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(buttons()).toHaveLength(3);
    rerender(
      <UiProvider linkComponent={RouterLink}>
        <RequestDraftCard draft={requestDraft()} actionError="Couldn't reach Omniralph." />
      </UiProvider>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Couldn't reach Omniralph.");
  });

  it("never uses the primary variant", () => {
    const { container } = renderUi(
      <>
        <RequestDraftCard draft={requestDraft()} />
        <RequestDraftCard
          draft={requestDraft({
            question: "Triage it now?",
            triageChoice: "follow_up",
            actions: [
              {
                id: "request_draft_add_triage",
                label: "Triage now",
                value: DRAFT_ID,
                style: "solid",
              },
            ],
          })}
        />
        <WorkItemDraftCard draft={workItemDraft()} />
        <GenericCard
          card={{
            kind: "generic",
            title: "T",
            text: "",
            actions: [{ id: "a", label: "A", value: null }],
          }}
        />
      </>,
    );
    expect(buttons().length).toBeGreaterThan(0);
    expect(container.querySelector(".or-btn--primary")).toBeNull();
  });
});

describe("WorkItemDraftCard", () => {
  it("shows the title, the tracker, team, labels, details and description preview", () => {
    const { container } = renderUi(<WorkItemDraftCard draft={workItemDraft()} />);
    const card = screen.getByRole("region", { name: "Login form forgets the email" });
    const meta = card.querySelector(".or-ask-card__meta")!.textContent;
    expect(meta).toContain("Linear work item");
    expect(meta).toContain("TOOL");
    expect(meta).toContain("bug");
    expect(meta).toContain("frontend");
    const facts = Array.from(container.querySelectorAll(".or-ask-card__fact"), (f) => [
      f.querySelector("dt")!.textContent,
      f.querySelector("dd")!.textContent,
    ]);
    expect(facts).toEqual([
      ["Project", "Portal"],
      ["Priority", "High"],
      ["Screenshots", "login.png"],
    ]);
    expect(card.querySelector(".or-md strong")?.textContent).toBe("email");
  });

  it("offers Create, Create and delegate and Cancel, and sends them", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderUi(<WorkItemDraftCard draft={workItemDraft()} onAction={onAction} />);
    expect(buttons().map((b) => [b.textContent, variantOf(b)])).toEqual([
      ["Create", "solid"],
      ["Create and delegate", "outline"],
      ["Cancel", "ghost"],
    ]);
    await user.click(screen.getByRole("button", { name: "Create and delegate" }));
    expect(onAction).toHaveBeenLastCalledWith({
      actionId: "linear_issue_create_delegate",
      value: DRAFT_ID,
    });
  });

  it("shows the created work item's badge in place of the buttons", () => {
    renderUi(
      <WorkItemDraftCard
        draft={workItemDraft({
          status: "created",
          actions: [],
          issue: { identifier: "TOOL-88", url: "https://linear.app/t/88" },
        })}
      />,
    );
    expect(buttons()).toEqual([]);
    expect(screen.getByText("Created in Linear")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Linear TOOL-88 (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe("https://linear.app/t/88");
  });

  it.each([
    ["cancelled", "Cancelled"],
    ["expired", "This draft expired"],
    ["creating", "Creating the work item in Linear"],
  ] as const)("shows %s", (status, text) => {
    const { container } = renderUi(
      <WorkItemDraftCard draft={workItemDraft({ status, actions: [] })} />,
    );
    expect(buttons()).toEqual([]);
    expect(container.querySelector(".or-ask-card__outcome")!.textContent).toBe(text);
  });

  it("shows a click's error in an alert", () => {
    renderUi(<WorkItemDraftCard draft={workItemDraft()} actionError="It failed." />);
    expect(screen.getByRole("alert").textContent).toBe("It failed.");
  });
});

describe("GenericCard", () => {
  it("shows any other card's title, text and buttons, and sends them", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderUi(
      <GenericCard
        card={{
          kind: "generic",
          title: "Run finished",
          text: "The run **passed**.",
          actions: [
            { id: "open", label: "Open", value: "r1" },
            { id: "retry", label: "Retry", value: null },
          ],
        }}
        onAction={onAction}
      />,
    );
    const card = screen.getByRole("region", { name: "Run finished" });
    expect(card.querySelector("strong")?.textContent).toBe("passed");
    expect(buttons().map((b) => [b.textContent, variantOf(b)])).toEqual([
      ["Open", "outline"],
      ["Retry", "outline"],
    ]);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onAction).toHaveBeenLastCalledWith({ actionId: "retry", value: null });
  });
});

describe("AskCard", () => {
  it("renders each kind with its component", () => {
    const { rerender } = renderUi(
      <AskCard card={{ kind: "request_draft", draft: requestDraft() }} />,
    );
    expect(screen.getByRole("button", { name: "Start request" })).toBeTruthy();
    rerender(
      <UiProvider linkComponent={RouterLink}>
        <AskCard card={{ kind: "tracker_issue_draft", draft: workItemDraft() }} />
      </UiProvider>,
    );
    expect(screen.getByRole("button", { name: "Create and delegate" })).toBeTruthy();
    rerender(
      <UiProvider linkComponent={RouterLink}>
        <AskCard card={{ kind: "generic", title: "Hello", text: "", actions: [] }} />
      </UiProvider>,
    );
    expect(screen.getByRole("region", { name: "Hello" })).toBeTruthy();
  });
});
