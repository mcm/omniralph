import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, safeMarkdownUrl } from "./markdown.js";

function renderMarkdown(source: string) {
  return render(<Markdown>{source}</Markdown>).container.querySelector(".or-md")!;
}

describe("Markdown", () => {
  it("renders GFM tables inside a scroll container", () => {
    const root = renderMarkdown("| Story | Size |\n| --- | --- |\n| Login | M |\n");
    const table = screen.getByRole("table");
    expect(table.parentElement!.classList.contains("or-md__table")).toBe(true);
    expect(within(table).getByRole("columnheader", { name: "Story" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "M" })).toBeTruthy();
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  describe("safety", () => {
    it("never renders a <script> element", () => {
      const root = renderMarkdown(
        'Hello <script>alert("x")</script>\n\n<script>alert(1)</script>\n',
      );
      expect(root.querySelector("script")).toBeNull();
      expect(root.innerHTML).not.toContain("<script");
      expect(root.textContent).toContain("Hello");
    });

    it("never renders an element with an onerror attribute", () => {
      const root = renderMarkdown(
        '<img src="x" onerror="alert(1)">\n\nText <b onclick="x()">b</b>\n',
      );
      expect(root.querySelector("[onerror]")).toBeNull();
      expect(root.querySelector("[onclick]")).toBeNull();
      expect(root.querySelector("img")).toBeNull();
      expect(root.querySelector("b")).toBeNull();
    });

    it("drops javascript: links and keeps their text", () => {
      const root = renderMarkdown("[click me](javascript:alert(1)) and <javascript:alert(2)>\n");
      expect(root.querySelector("a")).toBeNull();
      expect(root.querySelector("[href]")).toBeNull();
      expect(root.textContent).toContain("click me");
    });

    it("drops data:, relative and fragment links", () => {
      const root = renderMarkdown(
        "[a](data:text/html,hi) [b](/settings) [c](#top) [d](vbscript:x)\n",
      );
      expect(root.querySelector("a")).toBeNull();
    });

    it("keeps http, https and mailto links, opening in a new tab without an opener", () => {
      renderMarkdown(
        "[site](https://example.com/a) [plain](http://example.com) [mail](mailto:a@example.com)\n",
      );
      for (const [name, href] of [
        ["site", "https://example.com/a"],
        ["plain", "http://example.com"],
        ["mail", "mailto:a@example.com"],
      ] as const) {
        const link = screen.getByRole("link", { name });
        expect(link.getAttribute("href")).toBe(href);
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      }
    });

    it("links bare URLs (GFM autolinks) the same way", () => {
      renderMarkdown("See https://linear.app/x for more.\n");
      const link = screen.getByRole("link", { name: "https://linear.app/x" });
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("drops unsafe image sources", () => {
      const root = renderMarkdown("![x](javascript:alert(1))\n");
      expect(root.querySelector("img")?.getAttribute("src") ?? null).toBeNull();
    });
  });

  describe("PRD sections", () => {
    const PRD = [
      "## Introduction",
      "",
      "- an unordered point",
      "",
      "## Quality Gates",
      "",
      "These commands must pass:",
      "",
      "- `pnpm install`",
      "- `pnpm test`",
      "",
      "## Open Questions",
      "",
      "Before starting:",
      "",
      "1. Which repo?",
      "",
      "### Details",
      "",
      "More.",
      "",
      "## Non-Goals",
      "",
      "- nothing",
    ].join("\n");

    it("renders the Quality Gates list as an ordered list", () => {
      const root = renderMarkdown(PRD);
      const gates = root.querySelector("ol.or-md__gates")!;
      expect(gates).toBeTruthy();
      expect(Array.from(gates.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
        "pnpm install",
        "pnpm test",
      ]);
      // Other sections keep their bullets.
      expect(root.querySelectorAll("ul")).toHaveLength(2);
    });

    it("wraps the Open Questions section in a callout, up to the next section", () => {
      const root = renderMarkdown(PRD);
      const callout = root.querySelector(".or-md__callout")!;
      expect(callout.getAttribute("data-callout")).toBe("open-questions");
      expect(within(callout as HTMLElement).getByRole("heading", { level: 2 }).textContent).toBe(
        "Open Questions",
      );
      expect(callout.textContent).toContain("Which repo?");
      expect(callout.textContent).toContain("More.");
      expect(callout.textContent).not.toContain("Non-Goals");
      expect(callout.nextElementSibling!.textContent).toBe("Non-Goals");
    });

    it("matches the section names regardless of case", () => {
      const root = renderMarkdown("## quality gates\n\n- a\n\n## OPEN QUESTIONS\n\n- b\n");
      expect(root.querySelector("ol.or-md__gates")).toBeTruthy();
      expect(root.querySelector(".or-md__callout")).toBeTruthy();
    });

    it("adds no callout or numbering without those sections", () => {
      const root = renderMarkdown("## Goals\n\n- a\n");
      expect(root.querySelector(".or-md__callout")).toBeNull();
      expect(root.querySelector("ol")).toBeNull();
    });
  });

  it("takes a class name", () => {
    const { container } = render(<Markdown className="prd">Hi</Markdown>);
    expect(container.querySelector(".or-md.prd")).toBeTruthy();
  });
});

describe("safeMarkdownUrl", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["http://example.com/a?b=c", "http://example.com/a?b=c"],
    ["mailto:a@example.com", "mailto:a@example.com"],
    ["  https://example.com ", "https://example.com"],
    ["JAVASCRIPT:alert(1)", null],
    ["javascript:alert(1)", null],
    ["data:text/html,x", null],
    ["/relative", null],
    ["#fragment", null],
    ["", null],
  ])("%j → %j", (input, expected) => {
    expect(safeMarkdownUrl(input)).toBe(expected);
  });
});
