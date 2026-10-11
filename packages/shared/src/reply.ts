/**
 * Thread replies: a question asked by mentioning the bot in a finding's
 * thread runs the built-in query task `builtin:reply-to-finding` (job type
 * `review.reply`); the control panel's `finding-thread` sink posts the answer
 * in the thread.
 */

export const REVIEW_REPLY_JOB_TYPE = "review.reply";
/** Longest question passed to the agent; longer ones are truncated. */
export const MAX_REPLY_QUESTION_LENGTH = 4000;
/** Longest answer posted in a thread; longer ones are cut and marked. */
export const MAX_REPLY_ANSWER_LENGTH = 4000;
