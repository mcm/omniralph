import { type Job } from "@omniralph/db";
import {
  isRateLimitError,
  QueryRunResult,
  verifierRunFromResult,
  type VerifierRun,
} from "@omniralph/shared";

/**
 * How a loop's verifier job ended, as `applyFindingVerification` and
 * `applyDocumentationVerification` read it; null while it runs.
 */
export function verifierRunOf(job: Pick<Job, "status" | "result" | "error">): VerifierRun | null {
  switch (job.status) {
    case "completed": {
      const result = QueryRunResult.safeParse(job.result);
      return result.success
        ? verifierRunFromResult(result.data)
        : {
            status: "failed",
            error: "The verifier's result isn't a query result",
            rateLimited: false,
          };
    }
    case "failed":
      return { status: "failed", error: job.error, rateLimited: isRateLimitError(job.error) };
    case "canceled":
    case "skipped":
      return { status: "failed", error: "The verifier was canceled", rateLimited: false };
    default:
      return null;
  }
}
