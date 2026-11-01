// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { UiProvider } from "@omniralph/ui";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AskActivityLine } from "./activity-line";
import { AskMessage } from "./ask-message";
import { workItemDraft, omMessage, REPOSITORY, requestDraft } from "./test-fixtures";

const DIR = __dirname;
const THIS_FILE = path.basename(__filename);

/** Every source file here (tests too, except this one, which names what it looks for). */
const sources = readdirSync(DIR)
  .filter((file) => /\.(tsx?|css)$/.test(file) && file !== THIS_FILE)
  .map((file) => ({ file, text: readFileSync(path.join(DIR, file), "utf8") }));
const components = sources.filter(
  ({ file }) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
);

/** Every component here in its states, as one page. */
function everything() {
  const run = { id: "run-1", status: "completed" as const, durationMs: 41_000, filesRead: 2 };
  const outcome = (kind: "started" | "added" | "dismissed" | "expired", text: string) =>
    requestDraft({
      status: kind,
      actions: [],
      outcome: {
        kind,
        text,
        run: kind === "started" ? { id: "run-2", url: "https://app/runs/run-2" } : null,
        workItem:
          kind === "added" ? { tracker: "linear", identifier: "TOOL-1", url: "https://l/1" } : null,
      },
    });
  const cards = [
    { kind: "request_draft" as const, draft: requestDraft({ error: "Coding is off." }) },
    { kind: "request_draft" as const, draft: requestDraft({ question: "Triage it now?" }) },
    { kind: "request_draft" as const, draft: outcome("started", "Request started") },
    { kind: "request_draft" as const, draft: outcome("added", "Added to the backlog") },
    { kind: "request_draft" as const, draft: outcome("dismissed", "Not now") },
    { kind: "request_draft" as const, draft: outcome("expired", "This draft expired") },
    { kind: "tracker_issue_draft" as const, draft: workItemDraft() },
    {
      kind: "tracker_issue_draft" as const,
      draft: workItemDraft({
        status: "created",
        actions: [],
        issue: { identifier: "TOOL-2", url: null },
      }),
    },
    {
      kind: "tracker_issue_draft" as const,
      draft: workItemDraft({ status: "cancelled", actions: [] }),
    },
    {
      kind: "generic" as const,
      title: "Card",
      text: "Body",
      actions: [{ id: "a", label: "Go", value: null }],
    },
  ];
  return render(
    <UiProvider>
      <AskMessage message={omMessage({ author: "user", markdown: "Where is login?" })} />
      <AskMessage
        message={omMessage({
          run,
          files: [{ path: "src/a.ts", startLine: 1, endLine: 3, url: "https://g/a" }],
          workItems: [{ tracker: "linear", identifier: "TOOL-3", url: "https://l/3", runId: "r3" }],
        })}
      />
      <AskMessage
        message={omMessage({ markdown: "Part", status: "streaming" })}
        status="Looking at runs"
      />
      {cards.map((card, index) => (
        <AskMessage key={index} message={omMessage({ id: `c${index}`, card })} />
      ))}
      <AskActivityLine
        activity={{ state: "running", repository: REPOSITORY, filesRead: 3, runIds: [] }}
      />
      <AskActivityLine
        activity={{ state: "queued", repository: REPOSITORY, filesRead: 0, runIds: [] }}
      />
    </UiProvider>,
  );
}

describe("Ask's components", () => {
  it("are all found", () => {
    expect(components.map(({ file }) => file)).toEqual(
      expect.arrayContaining(["om-message.tsx", "request-draft-card.tsx", "activity-line.tsx"]),
    );
  });

  it("render no old names, keyboard-shortcut text or hint text", () => {
    const { container } = everything();
    const text = `${container.textContent} ${Array.from(
      container.querySelectorAll("[aria-label], [title]"),
      (el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`,
    ).join(" ")}`;
    const oldMachine = ["har", "ness"].join("");
    expect(text).not.toMatch(/ralph/i);
    expect(text.toLowerCase()).not.toContain(oldMachine);
    expect(container.querySelector("kbd")).toBeNull();
    expect(text).not.toMatch(/⌘|⌥|⇧|⏎|\bCtrl\b|\bShift\b|\bEnter\b|\bEsc\b|\bCmd\b/);
    expect(text).not.toMatch(
      /\b(?:listed|shown|appear|appears) here\b|\bclick (?:here|to)\b|\btap to\b/i,
    );
  });

  it("reuse Markdown, the badges, StatusLine, TriageNowCheckbox and runHref instead of copies", () => {
    for (const { file, text } of sources) {
      expect({ file, markdown: /react-markdown|remark-|rehype-/.test(text) }).toEqual({
        file,
        markdown: false,
      });
      expect({
        file,
        checkbox: /type=["']checkbox["']|<Checkbox\b|Triage now["'`]?\s*<\//.test(text),
      }).toEqual({
        file,
        checkbox: false,
      });
      expect({ file, runUrl: /["'`]\/runs\//.test(text) }).toEqual({ file, runUrl: false });
      expect({ file, badge: /className=["'`][^"'`]*or-ref\b/.test(text) }).toEqual({
        file,
        badge: false,
      });
    }
    for (const { file, text } of components) {
      expect({ file, statusLine: /or-statusline|or-dot\b/.test(text) }).toEqual({
        file,
        statusLine: false,
      });
    }
    const card = components.find(({ file }) => file === "request-draft-card.tsx")!.text;
    expect(card).toContain('from "@/components/work-items/triage-now-checkbox"');
    for (const file of ["om-message.tsx", "request-draft-card.tsx"]) {
      expect(components.find((c) => c.file === file)!.text).toContain('from "@/lib/runs/hrefs"');
    }
  });
});

describe("Ask's stylesheets", () => {
  const sheets = sources.filter(({ file }) => file.endsWith(".css"));
  const uncomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it.each(sheets.map(({ file }) => file))("%s is imported by a component next to it", (file) => {
    expect(components.some(({ text }) => text.includes(`import "./${file}";`))).toBe(true);
  });

  it.each(sheets)("$file uses no color literals and only --or- tokens", ({ text }) => {
    const css = uncomment(text);
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi)).toBeNull();
    const tokens = Array.from(css.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
    expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
  });

  it("draws the member's bubble right-aligned on --or-sel, at most 84 % wide, and the status in --or-sec", () => {
    const css = uncomment(sheets.find(({ file }) => file === "ask-messages.css")!.text);
    const rule = (selector: string) =>
      css.match(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".or-ask-user")).toMatch(/justify-content:\s*flex-end/);
    expect(rule(".or-ask-user__bubble")).toMatch(/background:\s*var\(--or-sel\)/);
    expect(rule(".or-ask-user__bubble")).toMatch(/max-width:\s*84%/);
    expect(rule(".or-ask-om__status")).toMatch(/color:\s*var\(--or-sec\)/);
  });
});
