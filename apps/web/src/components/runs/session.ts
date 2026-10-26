/** Pure helpers of the run Session section (`RunSession`). */
import type { RunMessageState, RunSession } from "@/lib/api/runs";

/** A message's state, in words. */
export const RUN_MESSAGE_STATE_LABELS: Record<RunMessageState, string> = {
  waiting: "Waiting for delivery",
  delivered: "Delivered",
  guidance: "Not delivered: kept as guidance",
  undelivered: "Not delivered: the attempt ended",
};

export const RUN_MESSAGE_KIND_LABELS: Record<RunSession["messages"][number]["kind"], string> = {
  guidance: "Guidance",
  request: "Request",
};

/** The Session's subsections in display order. */
export const SESSION_SECTIONS = [
  "pendingRequests",
  "messages",
  "guidance",
  "recommendations",
  "progressLog",
] as const;
export type SessionSection = (typeof SESSION_SECTIONS)[number];

export const SESSION_SECTION_TITLES: Record<SessionSection, string> = {
  pendingRequests: "Pending requests",
  messages: "Messages",
  guidance: "Guidance",
  recommendations: "Recommendations",
  progressLog: "Progress log",
};

/** The subsections with something to show, in display order (empty ones are left out). */
export function sessionSections(session: RunSession): SessionSection[] {
  return SESSION_SECTIONS.filter((section) =>
    section === "progressLog" ? session.progressLog.trim() !== "" : session[section].length > 0,
  );
}

/**
 * The Session from its loaded pages: the first page's everything, with the messages of the
 * later (older) pages appended, each message once.
 */
export function mergeSessionPages(pages: readonly RunSession[]): RunSession | null {
  const [first, ...older] = pages;
  if (!first) return null;
  const seen = new Set<string>();
  const messages = [first, ...older]
    .flatMap((page) => page.messages)
    .filter((message) => !seen.has(message.id) && seen.add(message.id));
  return { ...first, messages, nextCursor: pages.at(-1)!.nextCursor };
}
