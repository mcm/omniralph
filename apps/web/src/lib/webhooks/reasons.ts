/**
 * Why a webhook delivery did nothing, in plain language: every reason code a code-host or
 * Linear delivery can be ignored with has one sentence here, which the delivery log
 * records next to the code.
 */
import type { WebhookProvider } from "@omniralph/db";

type Describe = (provider: WebhookProvider) => string;

const term = (provider: WebhookProvider) =>
  provider === "gitlab" ? "merge request" : "pull request";

/** One sentence per ignore reason code (a sentence may name the provider's PR/MR term). */
export const WEBHOOK_IGNORE_REASONS = {
  // Code hosts (`lib/webhooks/ingest.ts`).
  unknown_repository: () => "This repo isn't connected to Omniralph",
  unknown_installation: () => "This GitHub App installation isn't connected to Omniralph",
  repository_disabled: () => "Reviews are off for this repo",
  trigger_disabled: (p) => `Reviews for this ${term(p)} event are off for this repo`,
  draft: (p) => `Reviews of draft ${term(p)}s are off for this repo`,
  no_review_tasks: () => "This repo has no review tasks for this trigger",
  unsupported_event: () => "Omniralph doesn't act on this event",
  own_comment: () => "The comment is Om's own",
  no_mention: () => "The comment doesn't mention Om",
  ci_not_failed: () => "The CI run didn't fail",
  ralph_disabled: () => "Coding is off for this repo",
  not_ralph: (p) => `Om didn't open this ${term(p)}`,
  own_review: () => "Om's own review doesn't change the review state",
  // `@bot` commands (`lib/mentions/handle.ts`), once they've run.
  command_refused: () => "Only people with write access to the repo can use this command",
  query_disabled: () => "Questions are off for this repo",
  not_in_finding_thread: () => "The question isn't in a thread of one of Om's findings",
  run_finished: () => "Om's run for this is already over",
  help: () => "Om replied with the list of commands",
  // Linear (`lib/linear/ingest.ts` and `classifyWebhook`).
  unknown_workspace: () => "This Linear workspace isn't connected to Omniralph",
  issue_without_id: () => "The issue event has no issue ID",
  issue_unchanged: () => "The issue changed, but not its state or triage label",
  no_agent_session: () => "The agent session event has no session",
  agent_session_without_issue: () => "The agent session isn't on an issue",
  no_run: () => "The event didn't start or reach a run",
} satisfies Record<string, Describe>;

export type WebhookIgnoreReason = keyof typeof WEBHOOK_IGNORE_REASONS;

export const isWebhookIgnoreReason = (code: string): code is WebhookIgnoreReason =>
  Object.hasOwn(WEBHOOK_IGNORE_REASONS, code);

/** The sentence for an ignore reason code. */
export function describeIgnoreReason(code: WebhookIgnoreReason, provider: WebhookProvider): string {
  return WEBHOOK_IGNORE_REASONS[code](provider);
}

/** Reason code of a delivery whose handling threw (its reason is the error's message). */
export const HANDLER_FAILED = "handler_failed";

/** A failure's message, for the log (short; never a stack). */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.trim() || "The delivery couldn't be processed";
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}
