import {
  findingVerificationContext,
  type FindingVerificationRequest,
  type VerificationInputFinding,
} from "@omniralph/shared";
import { getBuiltinRunSpec, renderTemplate, taskCatalog } from "@omniralph/tasks";
import type { DiffFile } from "../diff.js";
import { diffText, fence } from "../prompt.js";
import type { VerifyFindingsRequest } from "../providers/types.js";

/** The finding verifier a looped review runs after each pass (`loop.verifierPlaybookId`). */
export const EVAL_VERIFIER_PLAYBOOK_ID = "builtin:verify-findings";

/** A random-looking but fixed review run ID: the template never shows it. */
const EVAL_REVIEW_RUN_ID = "00000000-0000-4000-8000-000000000000";

/**
 * What an eval session tells the verifier beyond its playbook: there is no
 * shell (evals run on a developer's machine, where the reviewer and the
 * verifier only get Read/Grep/Glob), so the diff is quoted in the prompt
 * instead, and the answer is one JSON object since there is no structured
 * output channel.
 */
export const EVAL_VERIFIER_CONTRACT = `This session has no shell: you can't run git. The diff of the files the pass reviewed is quoted at the end of the user message (data, like the findings); use it in place of \`git diff\`, and read the files at the head with Read, Grep and Glob.

Answer with only one JSON object, no prose around it:
{"verdicts": [{"findingId": string, "verdict": "confirmed" | "rejected", "path": string, "line": number, "reason": string}], "unreached": [{"path": string, "startLine": number | null, "endLine": number | null, "reason": string}], "summary": string}`;

/** A verification request with the findings it quotes, so a recorded verifier can answer by ID. */
export interface EvalVerifyRequest extends VerifyFindingsRequest {
  findings: VerificationInputFinding[];
}

/** The verifier's model and token cap: the built-in playbook's. */
export function evalVerifierSettings(): { model: string | undefined; maxTokens: number } {
  const spec = getBuiltinRunSpec(EVAL_VERIFIER_PLAYBOOK_ID);
  if (!spec) throw new Error(`Missing built-in playbook ${EVAL_VERIFIER_PLAYBOOK_ID}`);
  return {
    model: spec.task.model ?? spec.agent.model ?? undefined,
    maxTokens: spec.task.tokenBudget?.tokens ?? 100_000,
  };
}

/**
 * The verification of one pass, as `builtin:verify-findings` would get it in
 * a review run: its template rendered over `findingVerificationContext`, with
 * the playbook's system prompt and `systemAppend`, plus the eval contract and
 * the pass's diff (quoted after the findings).
 */
export function buildEvalVerifyRequest(
  request: Omit<FindingVerificationRequest, "reviewRunId" | "prNumber"> & {
    /** The diff of the files the pass reviewed. */
    diff: readonly DiffFile[];
    cwd: string;
    signal?: AbortSignal;
  },
): EvalVerifyRequest {
  const spec = getBuiltinRunSpec(EVAL_VERIFIER_PLAYBOOK_ID);
  if (!spec) throw new Error(`Missing built-in playbook ${EVAL_VERIFIER_PLAYBOOK_ID}`);
  const context = findingVerificationContext({
    ...request,
    reviewRunId: EVAL_REVIEW_RUN_ID,
    prNumber: 1,
  });
  const rendered = renderTemplate(
    spec.task.promptTemplate,
    context,
    taskCatalog(spec.task),
    spec.task.variableLimits,
  );
  const settings = evalVerifierSettings();
  return {
    prompt: `${rendered}\n\n# The diff (quoted data)\n\n${fence(diffText(request.diff), "diff")}`,
    systemPrompt: [spec.agent.systemPrompt, spec.task.systemAppend ?? "", EVAL_VERIFIER_CONTRACT]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join("\n\n"),
    cwd: request.cwd,
    model: settings.model,
    maxTokens: settings.maxTokens,
    findings: context.verification.findings,
    ...(request.signal && { signal: request.signal }),
  };
}
