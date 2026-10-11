import type { SkippedFile } from "./plan.js";
import {
  diffText,
  hotspotList,
  MAX_PREVIOUS_FINDINGS,
  previousFindingLines,
  previousFindingText,
  quotedConventions,
  type PreviousFinding,
} from "./prompt.js";
import type { ReviewContext } from "./runReview.js";

/**
 * The variables the `review` task type gives a review task's prompt
 * template (see the variable catalog in `@omniralph/tasks`). Lists are
 * `{ items }` objects, null when empty, so a template can head them once.
 */
export interface ReviewVariables {
  /** The planned files' diff (untrusted); null when nothing is left to review. */
  diff: string | null;
  plan: {
    /** `full` (the whole change) or `incremental` (the commits since the last review). */
    mode: "full" | "incremental";
    baseSha: string;
    /** First commit of an incremental review's range (exclusive); null for a full one. */
    fromSha: string | null;
    headSha: string;
    /** Paths of the files under review. */
    files: string[];
    skipped: SkippedFile[];
  };
  risk: {
    /** The diff's complexity, 0 to 10. */
    complexityScore: number;
    /** Markdown list of the files and patterns the risk pre-pass flagged; null when none. */
    hotspots: string | null;
  };
  /** `CLAUDE.md` from the base commit, trimmed and capped (untrusted); null without one. */
  conventions: string | null;
  /** The open findings of earlier reviews to re-check; an item's `id` is its position. */
  previousFindings: {
    items: {
      id: number;
      path: string;
      /** `N` or `N-M`. */
      lines: string;
      category: string;
      /** Title and capped body (untrusted); null without either. */
      text: string | null;
    }[];
  } | null;
}

/** The review task type's template variables for a prepared review. */
export function reviewVariables(
  context: ReviewContext,
  input: { baseSha: string; previousFindings?: readonly PreviousFinding[] },
): ReviewVariables {
  const { plan, scope } = context;
  const files = plan.tasks.flatMap((task) => task.files);
  const conventions = context.conventions?.trim();
  const previous = (input.previousFindings ?? []).slice(0, MAX_PREVIOUS_FINDINGS);
  return {
    diff: files.length > 0 ? diffText(files) : null,
    plan: {
      mode: scope.mode,
      baseSha: input.baseSha,
      fromSha: scope.mode === "incremental" ? scope.fromSha : null,
      headSha: scope.headSha,
      files: files.map((file) => file.path),
      skipped: plan.skipped,
    },
    risk: {
      complexityScore: plan.complexityScore,
      hotspots: hotspotList(plan) ?? null,
    },
    conventions: conventions ? quotedConventions(conventions) : null,
    previousFindings:
      previous.length > 0
        ? {
            items: previous.map((finding, id) => ({
              id,
              path: finding.path,
              lines: previousFindingLines(finding),
              category: finding.category,
              text: previousFindingText(finding) || null,
            })),
          }
        : null,
  };
}
