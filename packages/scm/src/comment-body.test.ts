import { describe, expect, it } from "vitest";
import { capLength, renderInlineComment, summaryWithFallbacks } from "./comment-body.js";

describe("renderInlineComment", () => {
  it("returns the body when there is no suggestion", () => {
    expect(renderInlineComment({ path: "a.ts", line: 1, body: "Hi" })).toBe("Hi");
  });

  it("renders the suggestion as a suggestion block", () => {
    expect(
      renderInlineComment({
        path: "a.ts",
        line: 1,
        body: "Use const.",
        suggestion: "const x = 1;",
      }),
    ).toBe("Use const.\n\n```suggestion\nconst x = 1;\n```");
  });

  it("uses a longer fence when the suggestion contains backticks", () => {
    const body = renderInlineComment({
      path: "a.md",
      line: 1,
      body: "Fix",
      suggestion: "```ts\ncode\n```\n",
    });
    expect(body).toBe("Fix\n\n````suggestion\n```ts\ncode\n```\n````");
  });

  it("supports an empty suggestion (delete the lines)", () => {
    expect(renderInlineComment({ path: "a.ts", line: 1, body: "Remove", suggestion: "" })).toBe(
      "Remove\n\n```suggestion\n\n```",
    );
  });
});

describe("summaryWithFallbacks", () => {
  it("leaves the summary alone when nothing fell back", () => {
    expect(summaryWithFallbacks("Summary", [])).toBe("Summary");
  });

  it("appends fallback comments with their location", () => {
    const text = summaryWithFallbacks("Summary", [
      { path: "src/a.ts", line: 40, body: "Bug here." },
      { path: "src/b.ts", startLine: 3, line: 5, side: "old", body: "Old code.", suggestion: "x" },
    ]);
    expect(text).toContain("### Comments outside the diff");
    expect(text).toContain("**`src/a.ts`** L40\n\nBug here.");
    expect(text).toContain("**`src/b.ts`** L3-L5 (old)\n\nOld code.\n\n```\nx\n```");
    expect(text).not.toContain("```suggestion");
  });
});

describe("capLength", () => {
  it("truncates long bodies with a marker", () => {
    const capped = capLength("x".repeat(100), 50);
    expect(capped).toHaveLength(50);
    expect(capped.endsWith("_…truncated_")).toBe(true);
    expect(capLength("short", 50)).toBe("short");
  });
});
