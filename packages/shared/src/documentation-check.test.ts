import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyDocumentationVerification,
  DEFAULT_DOCUMENTATION_DEPTH,
  documentationCheckContext,
  documentationLoopLimits,
  documentationLoopVerdict,
  documentationProfileConfig,
  documentationScopeText,
  documentationUpdatesByFile,
  DocumentationVerificationOutput,
  documentationVerificationContext,
  DOCUMENTATION_DEPTH_IDS,
  DOCUMENTATION_DEPTHS,
  DOCUMENTATION_KIND_DESCRIPTIONS,
  isDocumentationDepth,
  MAX_DOCUMENTATION_UPDATES,
  MAX_DOCUMENTATION_REASON_LENGTH,
  MAX_DOCUMENTATION_VERIFICATION_SUMMARY_LENGTH,
  mergeDocumentationUpdates,
  type DocumentationUpdate,
  type DocumentationVerdict,
} from "./documentation-check.js";
import type { VerifierRun } from "./finding-verification.js";
import { ReviewProfileConfig, ReviewTaskResult, ReviewTriggerContext } from "./review-job.js";

const verifyDocs = getBuiltinTask("builtin:verify-docs")!;
const verifierSchema = z.fromJSONSchema(
  verifyDocs.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
);

const update = (path: string, reason = `${path} names the old flag.`): DocumentationUpdate => ({
  path,
  reason,
});
const withId = (id: string, path: string) => ({ id, ...update(path) });

function verdict(
  updateId: string,
  kind: DocumentationVerdict["verdict"],
  line: number | null = 3,
): DocumentationVerdict {
  return { updateId, verdict: kind, line, reason: `Line ${String(line)} shows it.` };
}

const answered = (output: unknown): VerifierRun => ({ status: "answered", output });

describe("DOCUMENTATION_DEPTHS", () => {
  it("has Quick, Standard and Deep, Standard by default", () => {
    expect(DOCUMENTATION_DEPTH_IDS).toEqual(["quick", "standard", "deep"]);
    expect(DEFAULT_DOCUMENTATION_DEPTH).toBe("standard");
    expect(isDocumentationDepth("deep")).toBe(true);
    expect(isDocumentationDepth("thorough")).toBe(false);
  });

  it("gives each depth a one-line summary, a model and a token cap", () => {
    for (const id of DOCUMENTATION_DEPTH_IDS) {
      const preset = DOCUMENTATION_DEPTHS[id];
      expect(preset.id).toBe(id);
      expect(preset.summary).toMatch(/^[^\n]+\.$/);
      expect(preset.model).toMatch(/^claude-/);
      expect(preset.maxTokens).toBeGreaterThan(0);
    }
  });

  it("widens the scope, the token cap and the iteration cap from Quick to Deep", () => {
    const [quick, standard, deep] = DOCUMENTATION_DEPTH_IDS.map((id) => DOCUMENTATION_DEPTHS[id]);
    expect(quick!.scope).toEqual(["docs"]);
    expect(standard!.scope).toEqual(["docs", "changed-file-comments"]);
    expect(deep!.scope).toEqual(["docs", "changed-file-comments", "related-comments"]);
    expect(quick!.maxTokens).toBeLessThan(standard!.maxTokens);
    expect(standard!.maxTokens).toBeLessThan(deep!.maxTokens);
    expect(quick!.maxIterations).toBeLessThan(standard!.maxIterations);
    expect(standard!.maxIterations).toBeLessThan(deep!.maxIterations);
    // Every depth loops: a single iteration couldn't find what the first one missed.
    expect(quick!.maxIterations).toBeGreaterThan(1);
  });
});

describe("documentationScopeText", () => {
  it("lists exactly the kinds of documentation in the depth's scope", () => {
    expect(documentationScopeText("quick")).toBe(`- ${DOCUMENTATION_KIND_DESCRIPTIONS.docs}`);
    const deep = documentationScopeText("deep").split("\n");
    expect(deep).toHaveLength(3);
    expect(deep[2]).toContain("anywhere in the repo");
    expect(documentationScopeText("standard")).not.toContain("anywhere in the repo");
  });
});

describe("documentationProfileConfig", () => {
  it("runs with the depth's model and token cap, and reads files beyond the diff at every depth", () => {
    for (const id of DOCUMENTATION_DEPTH_IDS) {
      const profile = documentationProfileConfig(id);
      expect(ReviewProfileConfig.parse(profile)).toEqual(profile);
      expect(profile).toMatchObject({
        model: DOCUMENTATION_DEPTHS[id].model,
        maxTokensPerReview: DOCUMENTATION_DEPTHS[id].maxTokens,
        maxFiles: DOCUMENTATION_DEPTHS[id].maxFiles,
        allowRepoExploration: true,
      });
    }
  });

  it("caps the loop at the depth's iterations", () => {
    expect(documentationLoopLimits("deep")).toEqual({
      maxIterations: DOCUMENTATION_DEPTHS.deep.maxIterations,
    });
  });
});

describe("ReviewTaskResult", () => {
  const result = {
    findings: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    skipped: [],
    stopReason: "completed",
    scope: { mode: "full", baseSha: "a".repeat(40), headSha: "b".repeat(40) },
    discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
    durationMs: 1,
    summary: "`docs/settings.md` still names `--old-flag`.",
  };

  it("parses a documentation check's updates, with and without a suggestion", () => {
    const parsed = ReviewTaskResult.parse({
      ...result,
      documentationUpdates: [
        { path: "docs/settings.md", reason: "Names `--old-flag`.", suggestion: "`--new-flag`" },
        { path: "README.md", reason: "Doesn't list `--new-flag`." },
      ],
    });
    expect(parsed.documentationUpdates).toEqual([
      { path: "docs/settings.md", reason: "Names `--old-flag`.", suggestion: "`--new-flag`" },
      { path: "README.md", reason: "Doesn't list `--new-flag`." },
    ]);
  });

  it("still parses results without documentation updates", () => {
    expect(ReviewTaskResult.parse(result).documentationUpdates).toBeUndefined();
    expect(ReviewTaskResult.parse({ ...result, documentationUpdates: [] })).toMatchObject({
      documentationUpdates: [],
    });
  });

  it("rejects updates without a path or reason, and too many of them", () => {
    for (const documentationUpdates of [
      [{ path: "", reason: "x" }],
      [{ path: "README.md", reason: " " }],
      [{ path: "README.md" }],
      Array.from({ length: MAX_DOCUMENTATION_UPDATES + 1 }, (_, i) => update(`d${i}.md`)),
    ]) {
      expect(ReviewTaskResult.safeParse({ ...result, documentationUpdates }).success).toBe(false);
    }
  });
});

describe("documentationCheckContext", () => {
  it("carries the depth's scope, and earlier iterations from the second on", () => {
    const first = documentationCheckContext("quick");
    expect(first).toEqual({
      depth: "quick",
      scope: documentationScopeText("quick"),
      earlier: null,
    });
    const second = documentationCheckContext("deep", {
      iteration: 2,
      confirmed: [update("README.md")],
      dropped: [{ path: "docs/a.md", reason: "Already right at the head." }],
    });
    expect(second.earlier).toEqual({
      iteration: 2,
      confirmed: [update("README.md")],
      dropped: [{ path: "docs/a.md", reason: "Already right at the head." }],
    });
  });

  it("is what a review trigger context carries", () => {
    const parsed = ReviewTriggerContext.shape.documentation.parse(
      documentationCheckContext("standard"),
    );
    expect(parsed?.depth).toBe("standard");
  });
});

describe("documentationVerificationContext", () => {
  it("sends the iteration's updates with their ids, at most MAX_DOCUMENTATION_UPDATES", () => {
    const many = Array.from({ length: MAX_DOCUMENTATION_UPDATES + 3 }, (_, i) =>
      withId(`u-${i}`, `docs/${i}.md`),
    );
    const context = documentationVerificationContext({
      reviewRunId: "0f0f0f0f-0000-4000-8000-000000000001",
      repository: "acme/app",
      prNumber: 7,
      depth: "standard",
      iteration: 1,
      baseSha: "base",
      headSha: "head",
      updates: many,
    });
    expect(context.documentation).toEqual({
      depth: "standard",
      scope: documentationScopeText("standard"),
    });
    expect(context.verification.updates).toHaveLength(MAX_DOCUMENTATION_UPDATES);
    expect(context.verification.updates[0]).toEqual({
      id: "u-0",
      path: "docs/0.md",
      reason: "docs/0.md names the old flag.",
      suggestion: null,
    });
  });
});

describe("DocumentationVerificationOutput", () => {
  it("accepts what builtin:verify-docs' output schema accepts", () => {
    for (const output of [
      { verdicts: [verdict("a", "confirmed")], summary: "One holds." },
      { verdicts: [verdict("a", "rejected", null)], summary: "" },
      { verdicts: [], summary: "Nothing to check." },
    ]) {
      expect(verifierSchema.safeParse(output).success).toBe(true);
      expect(DocumentationVerificationOutput.safeParse(output).success).toBe(true);
    }
  });

  it("rejects what the output schema rejects", () => {
    for (const output of [
      { verdicts: [] },
      { verdicts: [{ ...verdict("a", "confirmed"), verdict: "maybe" }], summary: "" },
      { verdicts: [{ ...verdict("a", "confirmed"), line: 0 }], summary: "" },
      { verdicts: [{ ...verdict("a", "confirmed"), updateId: "" }], summary: "" },
      { verdicts: [{ ...verdict("a", "confirmed"), reason: "" }], summary: "" },
      {
        verdicts: [
          {
            ...verdict("a", "confirmed"),
            reason: "x".repeat(MAX_DOCUMENTATION_REASON_LENGTH + 1),
          },
        ],
        summary: "",
      },
      { verdicts: [], summary: "x".repeat(MAX_DOCUMENTATION_VERIFICATION_SUMMARY_LENGTH + 1) },
      {
        verdicts: Array.from({ length: MAX_DOCUMENTATION_UPDATES * 2 + 1 }, () =>
          verdict("a", "confirmed"),
        ),
        summary: "",
      },
    ]) {
      expect(verifierSchema.safeParse(output).success).toBe(false);
      expect(DocumentationVerificationOutput.safeParse(output).success).toBe(false);
    }
  });
});

describe("applyDocumentationVerification", () => {
  const updates = [withId("a", "README.md"), withId("b", "docs/cli.md"), withId("c", "AGENTS.md")];

  it("keeps the confirmed updates and drops rejected and unanswered ones with why", () => {
    const result = applyDocumentationVerification(
      updates,
      [],
      answered({
        verdicts: [
          verdict("a", "confirmed"),
          verdict("b", "rejected"),
          verdict("zzz", "confirmed"),
        ],
        summary: "README.md still names the old flag.",
      }),
    );
    expect(result).toEqual({
      status: "verified",
      confirmed: [update("README.md")],
      newConfirmed: [update("README.md")],
      dropped: [
        { path: "docs/cli.md", reason: "Line 3 shows it." },
        { path: "AGENTS.md", reason: "The verifier gave no verdict for it." },
      ],
      summary: "README.md still names the old flag.",
    });
  });

  it("counts an update both confirmed and rejected as rejected", () => {
    const result = applyDocumentationVerification(
      updates.slice(0, 1),
      [],
      answered({ verdicts: [verdict("a", "confirmed"), verdict("a", "rejected")], summary: "" }),
    );
    expect(result).toMatchObject({ confirmed: [], newConfirmed: [] });
  });

  it("only counts files no earlier iteration confirmed as new", () => {
    const result = applyDocumentationVerification(
      updates,
      [update("./README.md")],
      answered({
        verdicts: [verdict("a", "confirmed"), verdict("b", "confirmed")],
        summary: "",
      }),
    );
    expect(result).toMatchObject({
      confirmed: [update("README.md"), update("docs/cli.md")],
      newConfirmed: [update("docs/cli.md")],
    });
  });

  it("drops updates past the limit, whatever the verifier answered", () => {
    const many = Array.from({ length: MAX_DOCUMENTATION_UPDATES + 1 }, (_, i) =>
      withId(`u-${i}`, `docs/${i}.md`),
    );
    const result = applyDocumentationVerification(
      many,
      [],
      answered({ verdicts: many.map((u) => verdict(u.id, "confirmed")), summary: "" }),
    );
    expect(result.status === "verified" && result.confirmed).toHaveLength(
      MAX_DOCUMENTATION_UPDATES,
    );
  });

  it("confirms nothing when the verifier failed or answered something else, and retries a rate limit", () => {
    expect(
      applyDocumentationVerification(updates, [], {
        status: "failed",
        error: "boom",
        rateLimited: false,
      }),
    ).toEqual({ status: "unverified", warning: "The documentation verifier failed: boom" });
    expect(applyDocumentationVerification(updates, [], answered({ verdicts: "no" }))).toMatchObject(
      { status: "unverified", warning: expect.stringMatching(/malformed/) },
    );
    expect(
      applyDocumentationVerification(updates, [], {
        status: "failed",
        error: "429",
        rateLimited: true,
      }),
    ).toEqual({ status: "retry" });
  });
});

describe("documentationLoopVerdict", () => {
  it("continues with the newly confirmed files, and converges once nothing new is confirmed", () => {
    expect(
      documentationLoopVerdict({
        status: "verified",
        confirmed: [update("README.md")],
        newConfirmed: [update("README.md")],
        dropped: [],
        summary: "",
      }),
    ).toEqual({
      converged: false,
      summary: "Confirmed 1 new documentation update.",
      findings: ["README.md: README.md names the old flag."],
    });
    expect(
      documentationLoopVerdict({
        status: "verified",
        confirmed: [update("README.md")],
        newConfirmed: [],
        dropped: [{ path: "docs/a.md", reason: "Already right." }],
        summary: "Only the README needed it.",
      }),
    ).toEqual({ converged: true, summary: "Only the README needed it.", findings: [] });
  });

  it("stops a loop whose verifier couldn't verify", () => {
    expect(documentationLoopVerdict({ status: "unverified", warning: "It failed." })).toEqual({
      converged: true,
      summary: "It failed.",
      findings: [],
    });
  });
});

describe("documentationUpdatesByFile and mergeDocumentationUpdates", () => {
  it("keeps one update per file, joining a file's reasons and suggestions", () => {
    expect(
      documentationUpdatesByFile([
        { path: "README.md", reason: "Old flag.", suggestion: "`--new`" },
        update("docs/a.md"),
        { path: "./README.md", reason: "Missing setting.", suggestion: "`timeout`" },
      ]),
    ).toEqual([
      {
        path: "README.md",
        reason: "Old flag.\nMissing setting.",
        suggestion: "`--new`\n\n`timeout`",
      },
      update("docs/a.md"),
    ]);
  });

  it("adds only the files the earlier updates don't have", () => {
    expect(
      mergeDocumentationUpdates(
        [update("README.md")],
        [update("README.md", "Again."), update("docs/a.md")],
      ),
    ).toEqual([update("README.md"), update("docs/a.md")]);
  });
});
