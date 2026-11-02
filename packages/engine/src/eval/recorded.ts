import type { Finding, UnreachedArea } from "@omniralph/shared";
import type {
  ReviewProvider,
  ReviewRequest,
  TaskReviewResult,
  TokenUsage,
  VerifyFindingsOutcome,
} from "../providers/types.js";
import type { LoopedEvalProvider } from "./looped.js";
import { caseIdFromRepoDir } from "./repo.js";
import type { EvalVerifyRequest } from "./verify.js";

/** What the recorded verifier answers for a case's findings (looped runs). */
export interface VerifierRecording {
  /** Titles of the findings it rejects; it confirms every other one. */
  rejected?: string[];
  /** Titles of the findings it gives no verdict (dropped as unanswered). */
  unanswered?: string[];
  /** Areas it says the pass didn't reach. */
  unreached?: UnreachedArea[];
  usage?: TokenUsage;
  /** The session stops this way instead of answering (the findings stay unverified). */
  stopReason?: Exclude<VerifyFindingsOutcome["status"], "answered">;
}

/** A canned review answer for one case. */
export interface Recording {
  /**
   * The reviewer's findings. Each review session answers those in its task's
   * files, like the real provider (a looped pass's session only sees its
   * check type's files).
   */
  findings: Finding[];
  /** Usage of each review session. */
  usage?: TokenUsage;
  stopReason?: TaskReviewResult["stopReason"];
  /** The verifier's answers; without it, it confirms every finding. */
  verifier?: VerifierRecording;
}

/**
 * An offline `ReviewProvider` (and finding verifier) that answers each
 * session from a recording, keyed by case ID (taken from the `buildCaseRepo`
 * directory the review runs in). Cases without a recording get no findings.
 * Keeps `pnpm test` from spending Claude tokens.
 */
export class RecordedProvider implements ReviewProvider, LoopedEvalProvider {
  readonly calls: { caseId: string | undefined; taskId: string; budget: number; prompt: string }[] =
    [];
  readonly verifications: {
    caseId: string | undefined;
    findingIds: string[];
    maxTokens: number;
    prompt: string;
    systemPrompt: string;
  }[] = [];

  constructor(private readonly recordings: Readonly<Record<string, Recording>>) {}

  async review(request: ReviewRequest): Promise<TaskReviewResult> {
    const caseId = caseIdFromRepoDir(request.cwd);
    this.calls.push({
      caseId,
      taskId: request.task.id,
      budget: request.task.budget,
      prompt: request.prompt,
    });
    const recording = caseId !== undefined ? this.recordings[caseId] : undefined;
    const usage = recording?.usage ?? { inputTokens: 0, outputTokens: 0 };
    const discarded = { invalid: 0, outsideDiff: 0 };
    // Like the real provider: going over the task budget aborts with partial (here: no) findings.
    if (usage.inputTokens + usage.outputTokens > request.task.budget) {
      return { findings: [], usage, stopReason: "budget_exhausted", discarded };
    }
    const paths = new Set(request.task.files.map((file) => file.path));
    return {
      findings: (recording?.findings ?? []).filter((finding) => paths.has(finding.path)),
      usage,
      stopReason: recording?.stopReason ?? "completed",
      discarded,
    };
  }

  async verifyFindings(request: EvalVerifyRequest): Promise<VerifyFindingsOutcome> {
    const caseId = caseIdFromRepoDir(request.cwd);
    this.verifications.push({
      caseId,
      findingIds: request.findings.map((finding) => finding.id),
      maxTokens: request.maxTokens,
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
    });
    const recording = (caseId !== undefined ? this.recordings[caseId] : undefined)?.verifier;
    const usage = recording?.usage ?? { inputTokens: 0, outputTokens: 0 };
    if (usage.inputTokens + usage.outputTokens > request.maxTokens) {
      return { status: "budget_exhausted", output: null, usage };
    }
    if (recording?.stopReason) {
      return {
        status: recording.stopReason,
        output: null,
        usage,
        error: `Recorded ${recording.stopReason}`,
      };
    }
    const rejected = new Set(recording?.rejected ?? []);
    const unanswered = new Set(recording?.unanswered ?? []);
    return {
      status: "answered",
      output: {
        verdicts: request.findings
          .filter((finding) => !unanswered.has(finding.title))
          .map((finding) => ({
            findingId: finding.id,
            verdict: rejected.has(finding.title) ? "rejected" : "confirmed",
            path: finding.path,
            line: finding.startLine,
            reason: "Recorded verdict.",
          })),
        unreached: recording?.unreached ?? [],
        summary: "Recorded verification.",
      },
      usage,
    };
  }
}
