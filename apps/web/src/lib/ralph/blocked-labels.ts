/**
 * Blocked labels (the organization's `tracker.labels` setting, default `under-review` and
 * `blocked`): tracker labels that keep Om off a work item. A new run of an issue carrying one
 * (or whose epic carries one) is refused, whichever repo it routes to: routing applies them
 * before any repo or playbook is chosen.
 */
import { getTrackerLabels, type Database } from "@omniralph/db";

/** The labels keeping Om from working the organization's work items; none when emptied. */
export async function organizationBlockedLabels(
  db: Pick<Database, "select">,
  organizationId: string,
): Promise<string[]> {
  return (await getTrackerLabels(db, organizationId)).blockedLabels;
}

/** The labels of `issues` that `blocked` names (matched ignoring case), in order. */
export function blockingLabels(
  issues: readonly { labels: readonly string[] }[],
  blocked: readonly string[],
): string[] {
  const names = new Set(blocked.map((l) => l.trim().toLowerCase()).filter(Boolean));
  const found: string[] = [];
  for (const label of issues.flatMap((i) => i.labels)) {
    const key = label.trim().toLowerCase();
    if (names.has(key) && !found.some((f) => f.toLowerCase() === key)) found.push(label.trim());
  }
  return found;
}

/** The response refusing to work an issue because of its blocked labels. */
export function blockedLabelsMessage(
  issue: { identifier: string },
  labels: readonly string[],
): string {
  const named = labels.map((l) => `\`${l}\``).join(", ");
  return [
    `I won't work on **${issue.identifier}**: work items labeled ${named} are blocked for Om in this organization.`,
    "Remove the label (from the work item, or its epic), then delegate it to me again.",
  ].join("\n\n");
}
