import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { documentationCommentBody, MAX_DOCUMENTATION_COMMENT_CHARS } =
  await import("./sticky-comment");

const sanitize = { allowedHosts: ["github.com"], author: "octocat" };

describe("documentationCommentBody", () => {
  it("says no change is needed, noting a check that hit its token cap", () => {
    expect(documentationCommentBody([], sanitize)).toBe(
      "No documentation changes needed for this change.",
    );
    expect(documentationCommentBody([], sanitize, { budgetExhausted: true })).toBe(
      "No documentation changes needed for this change.\n\n_The check reached its token cap, so it may have missed some documentation._",
    );
  });

  it("sanitizes the reason and fences the suggestion past its backticks", () => {
    const body = documentationCommentBody(
      [
        {
          path: "README.md",
          reason: "Ask @someone at https://evil.example.com <b>now</b>.",
          suggestion: "Run ```pnpm dev```.",
        },
      ],
      sanitize,
    );
    expect(body).not.toContain("<b>");
    expect(body).not.toContain(" @someone");
    expect(body).not.toContain("](https://evil.example.com");
    expect(body).toContain("  ````\n  Run ```pnpm dev```.\n  ````");
  });

  it("counts the files that don't fit instead of listing them", () => {
    const updates = Array.from({ length: 40 }, (_, i) => ({
      path: `docs/page-${i}.md`,
      reason: "x".repeat(1_500),
      suggestion: "y".repeat(1_500),
    }));
    const body = documentationCommentBody(updates, sanitize);
    expect(body.length).toBeLessThanOrEqual(MAX_DOCUMENTATION_COMMENT_CHARS + 100);
    expect(body).toMatch(/^40 documentation files need updating for this change:/);
    const listed = body.match(/^- \*\*/gm)!.length;
    expect(listed).toBeLessThan(40);
    expect(body).toContain(`_…and ${40 - listed} more files: see the run._`);
  });
});
