// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { runHref } from "@/lib/runs/hrefs";
import { AskActivityLine, askActivityText } from "./activity-line";
import { AskMessage } from "./ask-message";
import { askDuration, omRunMeta } from "./format";
import * as omMessageModule from "./om-message";
import { OmMessage } from "./om-message";
import { omMessage, REPOSITORY, requestDraft } from "./test-fixtures";
import { UserBubble } from "./user-bubble";

function RouterLink(props: LinkProps) {
  return <a data-router="yes" {...props} />;
}

const renderUi = (element: ReactElement) =>
  render(<UiProvider linkComponent={RouterLink}>{element}</UiProvider>);

describe("askDuration and omRunMeta", () => {
  it.each([
    [0, "0s"],
    [41_000, "41s"],
    [59_400, "59s"],
    [60_000, "1m"],
    [192_000, "3m 12s"],
    [3_840_000, "1h 4m"],
    [7_200_000, "2h"],
  ])("%d ms reads %s", (ms, text) => {
    expect(askDuration(ms)).toBe(text);
  });

  it('reads " · read-only · read N files · 41s", "read 1 file", and nothing without a run', () => {
    const run = { id: "r", status: "completed" as const, durationMs: 41_000, filesRead: 3 };
    expect(omRunMeta(run)).toBe(" · read-only · read 3 files · 41s");
    expect(omRunMeta({ ...run, filesRead: 1, durationMs: 192_000 })).toBe(
      " · read-only · read 1 file · 3m 12s",
    );
    expect(omRunMeta({ ...run, durationMs: null })).toBe(" · read-only · read 3 files");
    expect(omRunMeta(null)).toBeNull();
  });
});

describe("UserBubble", () => {
  it("shows the text as written in the right-aligned bubble", () => {
    const { container } = render(<UserBubble text={"Where is login?\nAnd logout?"} />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toBe("or-ask-user");
    const bubble = row.querySelector(".or-ask-user__bubble")!;
    expect(bubble.textContent).toBe("Where is login?\nAnd logout?");
  });

  it("is what AskMessage renders for a member's message, never as Markdown", () => {
    const { container } = render(
      <AskMessage message={omMessage({ author: "user", markdown: "**not bold**" })} />,
    );
    expect(container.querySelector(".or-ask-user__bubble")!.textContent).toBe("**not bold**");
    expect(container.querySelector("strong")).toBeNull();
  });
});

describe("OmMessage", () => {
  it("is exported for reuse", () => {
    expect(omMessageModule.OmMessage).toBeTypeOf("function");
  });

  it("starts with the 16 px Glyph and Om, then the Markdown body", () => {
    const { container } = renderUi(
      <OmMessage message={omMessage({ markdown: "Use **`signIn`** in `auth.ts`." })} />,
    );
    const who = container.querySelector(".or-ask-om__who")!;
    const glyph = who.querySelector("svg.or-glyph")!;
    expect(glyph.getAttribute("width")).toBe("16");
    expect(who.textContent).toBe("Om");
    const body = container.querySelector(".or-ask-om__body")!;
    expect(body.classList.contains("or-md")).toBe(true);
    expect(body.querySelector("strong code")?.textContent).toBe("signIn");
  });

  it("adds the run's meta to the Om line", () => {
    const { container } = renderUi(
      <OmMessage
        message={omMessage({
          run: { id: "run-1", status: "completed", durationMs: 41_000, filesRead: 1 },
        })}
      />,
    );
    expect(container.querySelector(".or-ask-om__who")!.textContent).toBe(
      "Om · read-only · read 1 file · 41s",
    );
  });

  it("renders no raw HTML and drops unsafe links", () => {
    const { container } = renderUi(
      <OmMessage
        message={omMessage({ markdown: '<img src=x onerror="alert(1)"> [x](javascript:alert(1))' })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
  });

  it("shows a FileBadge per cited file, linked to the code host", () => {
    const url = "https://github.com/acme/customer-portal/blob/main/src/login.tsx#L4-L9";
    renderUi(
      <OmMessage
        message={omMessage({
          files: [
            { path: "src/login.tsx", startLine: 4, endLine: 9, url },
            { path: "README.md", startLine: null, endLine: null, url: null },
          ],
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "src/login.tsx · lines 4–9" });
    expect(link.getAttribute("href")).toBe(url);
    expect(link.className).toContain("or-ref--file");
    expect(link.textContent).toContain("login.tsx");
    const readme = document.querySelectorAll(".or-ref--file")[1] as HTMLElement;
    expect(readme.tagName).toBe("SPAN");
    expect(readme.textContent).toContain("README.md");
  });

  it("links each work item to its run, else to the work item", () => {
    renderUi(
      <OmMessage
        message={omMessage({
          markdown: "See TOOL-12 and TOOL-13.",
          workItems: [
            {
              tracker: "linear",
              identifier: "TOOL-12",
              url: "https://linear.app/t/12",
              runId: "run-12",
            },
            {
              tracker: "linear",
              identifier: "TOOL-13",
              url: "https://linear.app/t/13",
              runId: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("link", { name: "Linear TOOL-12" }).getAttribute("href")).toBe(
      runHref("run-12"),
    );
    expect(screen.getByRole("link", { name: "Linear TOOL-13" }).getAttribute("href")).toBe(
      "https://linear.app/t/13",
    );
  });

  it("puts files first, then work items, in one badge row", () => {
    const { container } = renderUi(
      <OmMessage
        message={omMessage({
          files: [{ path: "a.ts", startLine: null, endLine: null, url: null }],
          workItems: [{ tracker: "linear", identifier: "TOOL-1", url: "https://l/1", runId: null }],
        })}
      />,
    );
    const rows = container.querySelectorAll(".or-ask-om__refs");
    expect(rows).toHaveLength(1);
    expect(Array.from(rows[0]!.children, (badge) => badge.className.split(" ")[1])).toEqual([
      "or-ref--file",
      "or-ref--issue",
    ]);
  });

  it("has no badge row without files or work items", () => {
    const { container } = renderUi(<OmMessage message={omMessage()} />);
    expect(container.querySelector(".or-ask-om__refs")).toBeNull();
  });

  it("grows as it streams and says what Om is doing", () => {
    const streaming = omMessage({ markdown: "", status: "streaming" });
    const { container, rerender } = renderUi(
      <OmMessage message={streaming} status="Asking an agent to read customer-portal" />,
    );
    const article = screen.getByRole("article", { name: "Om" });
    expect(article.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".or-ask-om__body")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Asking an agent to read customer-portal");
    expect(status.className).toBe("or-ask-om__status");

    const ui = (markdown: string, status: string | null) => (
      <UiProvider linkComponent={RouterLink}>
        <OmMessage message={{ ...streaming, markdown }} status={status} />
      </UiProvider>
    );
    rerender(ui("The login", "Looking at runs"));
    expect(container.querySelector(".or-ask-om__body")!.textContent).toBe("The login");
    expect(screen.getByRole("status").textContent).toBe("Looking at runs");
    rerender(ui("The login form posts", "Looking at runs"));
    expect(container.querySelector(".or-ask-om__body")!.textContent).toBe("The login form posts");

    rerender(
      <UiProvider linkComponent={RouterLink}>
        <OmMessage message={{ ...streaming, markdown: "Done.", status: "complete" }} status="x" />
      </UiProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(article.getAttribute("aria-busy")).toBeNull();
  });

  it("is what AskMessage renders for Om, and a card message renders its card", () => {
    const { container, rerender } = renderUi(<AskMessage message={omMessage()} />);
    expect(container.querySelector(".or-ask-om")).not.toBeNull();
    rerender(
      <UiProvider linkComponent={RouterLink}>
        <AskMessage
          message={omMessage({ card: { kind: "request_draft", draft: requestDraft() } })}
        />
      </UiProvider>,
    );
    expect(container.querySelector(".or-ask-om")).toBeNull();
    expect(
      within(container).getByRole("region", { name: "Remember the email on the login form" }),
    ).toBeTruthy();
  });
});

describe("AskActivityLine", () => {
  const activity = {
    state: "running" as const,
    repository: REPOSITORY,
    filesRead: 3,
    runIds: ["run-1"],
  };

  it("renders a running StatusLine with the repo and files read", () => {
    const { container } = render(<AskActivityLine activity={activity} />);
    const line = screen.getByRole("status", { name: "Om is reading customer-portal · 3 files" });
    expect(line.className).toContain("or-statusline--run");
    expect(container.querySelector(".or-dot--run")).not.toBeNull();
  });

  it("counts one file, and leaves out the count before any", () => {
    expect(askActivityText({ ...activity, filesRead: 1 })).toBe(
      "Om is reading customer-portal · 1 file",
    );
    expect(askActivityText({ ...activity, filesRead: 0 })).toBe("Om is reading customer-portal");
  });

  it("says it's waiting for an agent while queued", () => {
    render(<AskActivityLine activity={{ ...activity, state: "queued", filesRead: 0 }} />);
    expect(
      screen.getByRole("status", { name: "Waiting for an agent to read customer-portal" }),
    ).toBeTruthy();
  });
});
