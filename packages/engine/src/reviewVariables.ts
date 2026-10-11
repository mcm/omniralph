import type { SkippedFile } from "./plan.js";
import {
  depthGuidance,
  diffText,
  hotspotList,
  MAX_PREVIOUS_FINDINGS,
  previousFindingLines,
  previousFindingText,
  quotedConventions,
  ruleTexts,
  type PreviousFinding,
  type ReviewConfig,
} from "./prompt.js";
import { languagesForPaths, rubricFromDocs } from "./rubric/index.js";
import type { ReviewContext } from "./runReview.js";

/**
 * The variables the `review` task type gives a review task's prompt
 * template (see the variable catalog in `@omniralph/tasks`). Lists are
 * `{ items }` objects, null when empty, so a template can head them once.
 */
export interface ReviewVariables {
  /** How thoroughly to review, from the profile (`depthGuidance`). */
  depth: string;
  /** The agent's rubric docs for the diff's languages (`rubricFromDocs`); null without any. */
  rubric: string | null;
  /** The repository's custom instructions and enabled rules; null when it has neither. */
  repositoryRules: {
    /** Trimmed; null when none. */
    instructions: string | null;
    /** Numbered as the prompt lists them (`ruleTexts`); null when none is enabled. */
    rules: { items: { number: number; text: string }[] } | null;
  } | null;
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

/**
 * The review task type's template variables for a prepared review: the
 * profile's depth, the rubric for the diff's languages from the agent's
 * reference docs, the repository's rules, and the prepared diff, plan, risk,
 * conventions and open findings. A template made of these renders
 * `buildPrompt`'s prompt.
 */
export function reviewVariables(
  context: ReviewContext,
  input: {
    baseSha: string;
    config: ReviewConfig;
    /** The agent's reference docs, holding the rubric (see `rubricDocName`). */
    referenceDocs?: readonly { name: string; content: string }[];
    previousFindings?: readonly PreviousFinding[];
  },
): ReviewVariables {
  const { plan, scope } = context;
  const files = plan.tasks.flatMap((task) => task.files);
  const conventions = context.conventions?.trim();
  const previous = (input.previousFindings ?? []).slice(0, MAX_PREVIOUS_FINDINGS);
  const instructions = input.config.customInstructions?.trim() || null;
  const rules = ruleTexts(input.config).map((text, i) => ({ number: i + 1, text }));
  const languages = languagesForPaths(files.map((file) => file.path));
  return {
    depth: depthGuidance(input.config.profile),
    rubric: rubricFromDocs(input.referenceDocs ?? [], languages) ?? null,
    repositoryRules:
      instructions || rules.length > 0
        ? { instructions, rules: rules.length > 0 ? { items: rules } : null }
        : null,
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
              // As the prompt quotes it, between backticks.
              path: finding.path.replace(/`/g, ""),
              lines: previousFindingLines(finding),
              category: finding.category,
              text: previousFindingText(finding) || null,
            })),
          }
        : null,
  };
}
