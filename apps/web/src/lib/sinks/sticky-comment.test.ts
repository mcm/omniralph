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

  it("says when the updates were handed off to Om, naming the files", () => {
    const updates = [
      { path: "README.md", reason: "Shows the old `--fast` flag." },
      { path: "docs/setup.md", reason: "Describes the removed setting." },
    ];
    const body = documentationCommentBody(updates, sanitize, {
      handoff: {
        status: "handed_off",
        paths: ["README.md", "docs/setup.md"],
        delivery: "started",
        runId: "run-1",
      },
    });
    expect(body).toContain(
      "Om is committing these updates to this change: `README.md`, `docs/setup.md`.",
    );
    // The list stays: the comment still says what changes.
    expect(body).toContain("**`docs/setup.md`**: Describes the removed setting.");
  });

  it("says a person needs to finish past the request limit or when Om's commit didn't settle them", () => {
    const updates = [{ path: "README.md", reason: "Shows the old flag." }];
    expect(
      documentationCommentBody(updates, sanitize, { handoff: { status: "limit", requests: 3 } }),
    ).toContain(
      "Om has already updated the documentation of this change 3 times, so a person needs to finish these updates.",
    );
    expect(
      documentationCommentBody(updates, sanitize, {
        handoff: { status: "repeated", paths: ["README.md"] },
      }),
    ).toContain("so a person needs to finish these updates.");
  });

  it("says nothing about a hand-off when none happened", () => {
    const updates = [{ path: "README.md", reason: "Shows the old flag." }];
    const body = documentationCommentBody(updates, sanitize, {
      handoff: { status: "ignored", reason: "run_over" },
    });
    expect(body).not.toContain("Om ");
    expect(body).not.toContain("a person needs to finish");
    expect(
      documentationCommentBody([], sanitize, { handoff: { status: "limit", requests: 3 } }),
    ).toBe("No documentation changes needed for this change.");
  });
});
