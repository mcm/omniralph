import type { Finding } from "@omniralph/shared";
import type {
  ReviewProvider,
  ReviewRequest,
  TaskReviewResult,
  TokenUsage,
} from "../providers/types.js";
import { caseIdFromRepoDir } from "./repo.js";

/** A canned review answer for one case. */
export interface Recording {
  findings: Finding[];
  usage?: TokenUsage;
  stopReason?: TaskReviewResult["stopReason"];
}

/**
 * An offline `ReviewProvider` that answers each review from a recording,
 * keyed by case ID (taken from the `buildCaseRepo` directory the review runs
 * in). Cases without a recording get no findings. Keeps `pnpm test` from
 * spending Claude tokens.
 */
export class RecordedProvider implements ReviewProvider {
  readonly calls: { caseId: string | undefined; budget: number; prompt: string }[] = [];

  constructor(private readonly recordings: Readonly<Record<string, Recording>>) {}

  async review(request: ReviewRequest): Promise<TaskReviewResult> {
    const caseId = caseIdFromRepoDir(request.cwd);
    this.calls.push({ caseId, budget: request.task.budget, prompt: request.prompt });
    const recording = caseId !== undefined ? this.recordings[caseId] : undefined;
    const usage = recording?.usage ?? { inputTokens: 0, outputTokens: 0 };
    const discarded = { invalid: 0, outsideDiff: 0 };
    // Like the real provider: going over the task budget aborts with partial (here: no) findings.
    if (usage.inputTokens + usage.outputTokens > request.task.budget) {
      return { findings: [], usage, stopReason: "budget_exhausted", discarded };
    }
    return {
      findings: recording?.findings ?? [],
      usage,
      stopReason: recording?.stopReason ?? "completed",
      discarded,
    };
  }
}
