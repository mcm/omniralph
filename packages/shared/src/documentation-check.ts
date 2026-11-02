/**
 * The documentation check (`builtin:check-docs`, role `docs-check`): a looped
 * review-type run that finds documentation a PR's change makes wrong or
 * incomplete. Each iteration's worker reports `documentationUpdates` (one per
 * file: its path, why it needs updating and optionally the text to write);
 * a fresh verifier session (`builtin:verify-docs`) re-reads each file
 * against the diff and confirms or drops each update. The loop stops once an
 * iteration confirms nothing new, or at its depth's iteration cap.
 *
 * A repo's documentation depth sets what counts as documentation, the model,
 * the token cap and the iteration cap, as the review depth does for reviews.
 * The UI shows each preset's `summary` first and its `details` on demand.
 */
import { z } from "zod";
import type { VerifierRun } from "./finding-verification.js";
import type { ReviewProfileConfig } from "./review-job.js";

/** The documentation depths, from fastest to most thorough. */
export const DOCUMENTATION_DEPTH_IDS = ["quick", "standard", "deep"] as const;
export type DocumentationDepth = (typeof DOCUMENTATION_DEPTH_IDS)[number];

/** The documentation depth of a repo that never chose one. */
export const DEFAULT_DOCUMENTATION_DEPTH: DocumentationDepth = "standard";

export const DocumentationDepthSchema = z.enum(DOCUMENTATION_DEPTH_IDS, {
  error: "Choose a documentation depth: quick, standard or deep.",
});

/** Whether `value` is a documentation depth. */
export function isDocumentationDepth(value: unknown): value is DocumentationDepth {
  return (
    typeof value === "string" && (DOCUMENTATION_DEPTH_IDS as readonly string[]).includes(value)
  );
}

/** The kinds of documentation a check can read, from the narrowest scope out. */
export const DOCUMENTATION_KINDS = ["docs", "changed-file-comments", "related-comments"] as const;
export type DocumentationKind = (typeof DOCUMENTATION_KINDS)[number];

/** What each kind of documentation covers, as the check's prompt lists it. */
export const DOCUMENTATION_KIND_DESCRIPTIONS: Readonly<Record<DocumentationKind, string>> = {
  docs: "Markdown documentation: READMEs, files under `docs/`, other Markdown files (`.md`, `.mdx`) and agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursor/rules/`).",
  "changed-file-comments": "Code comments and docstrings in the files the change modifies.",
  "related-comments":
    "Code comments and docstrings anywhere in the repo that mention what the change modifies (its functions, types, settings, flags, commands or endpoints).",
};

export interface DocumentationDepthPreset {
  id: DocumentationDepth;
  label: string;
  /** One plain sentence: what a check at this depth reads. */
  summary: string;
  /** The kinds of documentation the check reads and reports on. */
  scope: readonly DocumentationKind[];
  /** The Claude model each worker session runs with. */
  model: string;
  /** Token cap of each worker session. */
  maxTokens: number;
  /** Most changed files the check reads the diff of; the rest are skipped. */
  maxFiles: number;
  /** Most worker-then-verifier iterations a check runs (the loop's cap). */
  maxIterations: number;
  /** The depth popover's detail rows. */
  details: {
    modelLabel: string;
    tokenCapLabel: string;
    iterationsLabel: string;
    reads: string;
  };
}

export const DOCUMENTATION_DEPTHS: Readonly<Record<DocumentationDepth, DocumentationDepthPreset>> =
  {
    quick: {
      id: "quick",
      label: "Quick",
      summary: "Checks Markdown docs, READMEs, docs/ and agent instruction files.",
      scope: ["docs"],
      model: "claude-haiku-5-5",
      maxTokens: 100_000,
      maxFiles: 50,
      maxIterations: 2,
      details: {
        modelLabel: "Haiku 5.5",
        tokenCapLabel: "100k per iteration",
        iterationsLabel: "Up to 2",
        reads: "Markdown docs, READMEs, docs/ and agent instruction files",
      },
    },
    standard: {
      id: "standard",
      label: "Standard",
      summary: "Adds the comments and docstrings in the changed files.",
      scope: ["docs", "changed-file-comments"],
      model: "claude-sonnet-5-5",
      maxTokens: 250_000,
      maxFiles: 100,
      maxIterations: 3,
      details: {
        modelLabel: "Sonnet 5.5",
        tokenCapLabel: "250k per iteration",
        iterationsLabel: "Up to 3",
        reads: "Quick's files, plus comments and docstrings in the changed files",
      },
    },
    deep: {
      id: "deep",
      label: "Deep",
      summary:
        "Adds comments and docstrings anywhere in the repo that mention what the change modifies.",
      scope: ["docs", "changed-file-comments", "related-comments"],
      model: "claude-opus-5-5",
      maxTokens: 500_000,
      maxFiles: 200,
      maxIterations: 4,
      details: {
        modelLabel: "Opus 5.5",
        tokenCapLabel: "500k per iteration",
        iterationsLabel: "Up to 4",
        reads: "Standard's files, plus comments and docstrings across the repo",
      },
    },
  };

/** The kinds of documentation in `depth`'s scope, as a Markdown list for a prompt. */
export function documentationScopeText(depth: DocumentationDepth): string {
  return DOCUMENTATION_DEPTHS[depth].scope
    .map((kind) => `- ${DOCUMENTATION_KIND_DESCRIPTIONS[kind]}`)
    .join("\n");
}

/**
 * The `reviewConfig.profile` a documentation check at `depth` runs with: the
 * depth's model, token cap and file limit, and always reading files beyond
 * the diff (the documentation lives outside it).
 */
export function documentationProfileConfig(depth: DocumentationDepth): ReviewProfileConfig {
  const preset = DOCUMENTATION_DEPTHS[depth];
  return {
    id: preset.id,
    name: `${preset.label} documentation check`,
    model: preset.model,
    maxTokensPerReview: preset.maxTokens,
    maxFiles: preset.maxFiles,
    allowRepoExploration: true,
  };
}

/** The loop limits of a documentation check at `depth` (`startLoop`'s `limits`). */
export function documentationLoopLimits(depth: DocumentationDepth): { maxIterations: number } {
  return { maxIterations: DOCUMENTATION_DEPTHS[depth].maxIterations };
}

/** Most documentation updates a check's result carries. */
export const MAX_DOCUMENTATION_UPDATES = 100;
/** Longest path of a documentation update. */
export const MAX_DOCUMENTATION_PATH_LENGTH = 1_000;
/** Longest reason a documentation update gives. */
export const MAX_DOCUMENTATION_REASON_LENGTH = 2_000;
/** Longest suggested text a documentation update carries. */
export const MAX_DOCUMENTATION_SUGGESTION_LENGTH = 5_000;

/**
 * A file the change makes wrong or incomplete: its path in the repo, what is
 * wrong or missing (`reason`) and optionally short text to write (`suggestion`).
 */
export const DocumentationUpdate = z.object({
  path: z.string().trim().min(1).max(MAX_DOCUMENTATION_PATH_LENGTH),
  reason: z.string().trim().min(1).max(MAX_DOCUMENTATION_REASON_LENGTH),
  suggestion: z.string().trim().min(1).max(MAX_DOCUMENTATION_SUGGESTION_LENGTH).optional(),
});
export type DocumentationUpdate = z.infer<typeof DocumentationUpdate>;

/** A check's documentation updates (at most `MAX_DOCUMENTATION_UPDATES`). */
export const DocumentationUpdateList = z.array(DocumentationUpdate).max(MAX_DOCUMENTATION_UPDATES);

/** `path` as two updates of one file compare: without `./` or a leading `/`. */
function filePathKey(path: string): string {
  return path.trim().replace(/^(\.\/|\/)+/, "");
}

/**
 * `updates` with one entry per file, in first-seen order: a file's later
 * entries add their reason and suggestion to its first one.
 */
export function documentationUpdatesByFile(
  updates: readonly DocumentationUpdate[],
): DocumentationUpdate[] {
  const byPath = new Map<string, DocumentationUpdate>();
  for (const update of updates) {
    const key = filePathKey(update.path);
    const earlier = byPath.get(key);
    if (!earlier) {
      byPath.set(key, { ...update });
      continue;
    }
    const suggestion = [earlier.suggestion, update.suggestion].filter(Boolean).join("\n\n");
    byPath.set(key, {
      path: earlier.path,
      reason: `${earlier.reason}\n${update.reason}`.slice(0, MAX_DOCUMENTATION_REASON_LENGTH),
      ...(suggestion && { suggestion: suggestion.slice(0, MAX_DOCUMENTATION_SUGGESTION_LENGTH) }),
    });
  }
  return [...byPath.values()];
}

/** A documentation update the verifier dropped, with its reason, so a later iteration doesn't report it again. */
export const DroppedDocumentationUpdate = z.object({
  path: z.string().min(1).max(MAX_DOCUMENTATION_PATH_LENGTH),
  reason: z.string().min(1).max(MAX_DOCUMENTATION_REASON_LENGTH),
});
export type DroppedDocumentationUpdate = z.infer<typeof DroppedDocumentationUpdate>;

/**
 * The `documentation` of a documentation check's trigger context (its
 * worker's): the depth and the kinds of documentation in its scope, and from
 * the second iteration on what earlier iterations' verifiers confirmed and
 * dropped. The prompt template renders it.
 */
export const DocumentationCheckContext = z.object({
  depth: DocumentationDepthSchema,
  /** `documentationScopeText(depth)`. */
  scope: z.string().min(1),
  /** Null on the first iteration. */
  earlier: z
    .object({
      /** This iteration's number (2 or more). */
      iteration: z.int().min(2),
      confirmed: z.array(DocumentationUpdate).max(MAX_DOCUMENTATION_UPDATES),
      dropped: z.array(DroppedDocumentationUpdate).max(MAX_DOCUMENTATION_UPDATES),
    })
    .nullable(),
});
export type DocumentationCheckContext = z.infer<typeof DocumentationCheckContext>;

/** What earlier iterations of a check settled, for `documentationCheckContext`. */
export interface EarlierDocumentationIterations {
  /** The iteration about to run (2 or more). */
  iteration: number;
  confirmed: readonly DocumentationUpdate[];
  dropped: readonly DroppedDocumentationUpdate[];
}

/** The `documentation` trigger context of a check's worker at `depth`. */
export function documentationCheckContext(
  depth: DocumentationDepth,
  earlier: EarlierDocumentationIterations | null = null,
): DocumentationCheckContext {
  return DocumentationCheckContext.parse({
    depth,
    scope: documentationScopeText(depth),
    earlier: earlier && {
      iteration: earlier.iteration,
      confirmed: earlier.confirmed.slice(0, MAX_DOCUMENTATION_UPDATES),
      dropped: earlier.dropped.slice(-MAX_DOCUMENTATION_UPDATES).map((dropped) => ({
        path: dropped.path.slice(0, MAX_DOCUMENTATION_PATH_LENGTH),
        reason: dropped.reason.slice(0, MAX_DOCUMENTATION_REASON_LENGTH),
      })),
    },
  });
}

/** Job type of a documentation check iteration's verification run. */
export const DOCUMENTATION_VERIFICATION_JOB_TYPE = "review.verify-docs";

/** An update of the iteration, as the verifier sees it. */
export const VerificationInputDocumentationUpdate = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  reason: z.string(),
  suggestion: z.string().nullable(),
});
export type VerificationInputDocumentationUpdate = z.infer<
  typeof VerificationInputDocumentationUpdate
>;

/**
 * The `run.invoked` trigger context of a documentation verification: the
 * invoking review run, its PR, the depth and its scope, and the iteration's
 * updates against the change (the checkout is of `headSha`).
 */
export const DocumentationVerificationTriggerContext = z.object({
  invoker: z.object({ kind: z.literal("review-run"), id: z.uuid() }),
  repository: z.string().min(1),
  pr: z.object({ number: z.int() }),
  documentation: DocumentationCheckContext.pick({ depth: true, scope: true }),
  verification: z.object({
    iteration: z.int().min(1),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    updates: z.array(VerificationInputDocumentationUpdate).max(MAX_DOCUMENTATION_UPDATES),
  }),
});
export type DocumentationVerificationTriggerContext = z.infer<
  typeof DocumentationVerificationTriggerContext
>;

/** What `documentationVerificationContext` builds a verification's trigger context from. */
export interface DocumentationVerificationRequest {
  reviewRunId: string;
  repository: string;
  prNumber: number;
  depth: DocumentationDepth;
  iteration: number;
  baseSha: string;
  headSha: string;
  /** The iteration's updates, each with an `id` its verdict names. */
  updates: readonly (DocumentationUpdate & { id: string })[];
}

/**
 * The trigger context of an iteration's verification. Only its first
 * `MAX_DOCUMENTATION_UPDATES` updates are sent: the rest go unanswered, so
 * `applyDocumentationVerification` drops them.
 */
export function documentationVerificationContext(
  request: DocumentationVerificationRequest,
): DocumentationVerificationTriggerContext {
  return DocumentationVerificationTriggerContext.parse({
    invoker: { kind: "review-run", id: request.reviewRunId },
    repository: request.repository,
    pr: { number: request.prNumber },
    documentation: { depth: request.depth, scope: documentationScopeText(request.depth) },
    verification: {
      iteration: request.iteration,
      baseSha: request.baseSha,
      headSha: request.headSha,
      updates: request.updates.slice(0, MAX_DOCUMENTATION_UPDATES).map((update) => ({
        id: update.id,
        path: update.path,
        reason: update.reason,
        suggestion: update.suggestion ?? null,
      })),
    },
  });
}

export const DOCUMENTATION_VERDICTS = ["confirmed", "rejected"] as const;

/** The verifier's verdict on one update, with the documentation line it relies on. */
export const DocumentationVerdict = z.object({
  updateId: z.string().min(1),
  verdict: z.enum(DOCUMENTATION_VERDICTS),
  /** The line of the update's file the verdict relies on (1-based, at the head); null when the file lacks what the update adds. */
  line: z.int().min(1).nullable(),
  reason: z.string().trim().min(1).max(MAX_DOCUMENTATION_REASON_LENGTH),
});
export type DocumentationVerdict = z.infer<typeof DocumentationVerdict>;

/** Longest summary a documentation verifier may write. */
export const MAX_DOCUMENTATION_VERIFICATION_SUMMARY_LENGTH = 5_000;

/** The structured output of a documentation verification (`builtin:verify-docs`'s fixed output schema). */
export const DocumentationVerificationOutput = z.object({
  verdicts: z.array(DocumentationVerdict).max(MAX_DOCUMENTATION_UPDATES * 2),
  summary: z.string().max(MAX_DOCUMENTATION_VERIFICATION_SUMMARY_LENGTH),
});
export type DocumentationVerificationOutput = z.infer<typeof DocumentationVerificationOutput>;

/** What an iteration keeps after its verification. */
export type DocumentationVerification =
  /** The verifier answered: only confirmed updates count. */
  | {
      status: "verified";
      /** Every update it confirmed, one per file. */
      confirmed: DocumentationUpdate[];
      /** The confirmed updates of files no earlier iteration confirmed. */
      newConfirmed: DocumentationUpdate[];
      /** Updates it rejected or gave no verdict for, with why. */
      dropped: DroppedDocumentationUpdate[];
      summary: string;
    }
  /**
   * The verifier failed (or its answer was malformed): nothing of the
   * iteration is confirmed, and the loop stops on what earlier ones confirmed.
   */
  | { status: "unverified"; warning: string }
  /** The verifier hit a rate limit: it runs again, and nothing is applied yet. */
  | { status: "retry" };

/**
 * What an iteration keeps of its `updates` (each with the `id` its verdict
 * names) after its verifier `run`, given the files `earlierConfirmed` by
 * earlier iterations:
 * - an answer keeps the updates it confirmed; a rejected update, one without
 *   a verdict and one past `MAX_DOCUMENTATION_UPDATES` are dropped. An update
 *   with both verdicts counts as rejected. A confirmed update of a file an
 *   earlier iteration confirmed isn't new.
 * - an answer that isn't a `DocumentationVerificationOutput`, or a failed
 *   run, keeps nothing (`unverified`).
 * - a rate-limited run is retried: nothing is kept or dropped yet.
 */
export function applyDocumentationVerification(
  updates: readonly (DocumentationUpdate & { id: string })[],
  earlierConfirmed: readonly DocumentationUpdate[],
  run: VerifierRun,
): DocumentationVerification {
  if (run.status === "failed" && run.rateLimited) return { status: "retry" };
  const output =
    run.status === "answered" ? DocumentationVerificationOutput.safeParse(run.output) : null;
  if (!output?.success) {
    return {
      status: "unverified",
      warning: output
        ? `The documentation verifier's answer is malformed: ${z.prettifyError(output.error).slice(0, 2_000)}`
        : `The documentation verifier failed: ${run.status === "failed" ? (run.error ?? "unknown error") : "no answer"}`,
    };
  }

  const byId = new Map<string, DocumentationVerdict>();
  for (const verdict of output.data.verdicts) {
    const earlier = byId.get(verdict.updateId);
    // A rejection wins over a confirmation of the same update.
    if (!earlier || (earlier.verdict === "confirmed" && verdict.verdict === "rejected")) {
      byId.set(verdict.updateId, verdict);
    }
  }
  const confirmed: DocumentationUpdate[] = [];
  const dropped: DroppedDocumentationUpdate[] = [];
  updates.forEach((update, index) => {
    // Updates past the limit weren't sent to the verifier, whatever it answered.
    const verdict = index < MAX_DOCUMENTATION_UPDATES ? byId.get(update.id) : undefined;
    const { id: _id, ...kept } = update;
    if (verdict?.verdict === "confirmed") confirmed.push(kept);
    else
      dropped.push({
        path: update.path,
        reason: verdict?.reason ?? "The verifier gave no verdict for it.",
      });
  });
  const byFile = documentationUpdatesByFile(confirmed);
  const earlierFiles = new Set(earlierConfirmed.map((update) => filePathKey(update.path)));
  return {
    status: "verified",
    confirmed: byFile,
    newConfirmed: byFile.filter((update) => !earlierFiles.has(filePathKey(update.path))),
    dropped,
    summary: output.data.summary,
  };
}

/**
 * The loop verdict of an iteration (the run loop's `LoopVerdict` shape): it
 * converged when its verifier confirmed nothing new (or couldn't verify), and
 * otherwise sends the newly confirmed files back as findings.
 */
export function documentationLoopVerdict(
  verification: Exclude<DocumentationVerification, { status: "retry" }>,
): { converged: boolean; summary: string; findings: string[] } {
  if (verification.status === "unverified") {
    return { converged: true, summary: verification.warning, findings: [] };
  }
  const findings = verification.newConfirmed
    .slice(0, MAX_DOCUMENTATION_UPDATES)
    .map((update) => `${update.path}: ${update.reason}`.slice(0, 5_000));
  const fallback =
    findings.length === 0
      ? "No new documentation update was confirmed."
      : `Confirmed ${findings.length} new documentation update${findings.length === 1 ? "" : "s"}.`;
  return {
    converged: findings.length === 0,
    summary: (verification.summary.trim() || fallback).slice(0, 20_000),
    findings,
  };
}

/** Every confirmed update of a check: `earlier`'s, then the files `next` adds. */
export function mergeDocumentationUpdates(
  earlier: readonly DocumentationUpdate[],
  next: readonly DocumentationUpdate[],
): DocumentationUpdate[] {
  const files = new Set(earlier.map((update) => filePathKey(update.path)));
  return [
    ...earlier,
    ...documentationUpdatesByFile(next).filter((update) => !files.has(filePathKey(update.path))),
  ].slice(0, MAX_DOCUMENTATION_UPDATES);
}
