/** Why a finding was dismissed (`@bot dismiss [reason]` in its thread on the PR/MR). */
export const FEEDBACK_REASONS = ["false_positive", "wont_fix", "not_relevant", "other"] as const;
export type FeedbackReasonValue = (typeof FEEDBACK_REASONS)[number];

export const FEEDBACK_REASON_LABELS: Record<FeedbackReasonValue, string> = {
  false_positive: "False positive",
  wont_fix: "Won't fix",
  not_relevant: "Not relevant",
  other: "Other",
};
