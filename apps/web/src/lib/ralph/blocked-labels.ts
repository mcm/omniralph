/**
 * Blocked labels (`ralph_settings.blockedLabels`, default `under-review` and
 * `blocked`): Linear labels that keep Omniralph off an issue. A new run of an
 * issue carrying one (or whose epic carries one) is refused in the repository
 * the issue routes to.
 */
import { DEFAULT_BLOCKED_LABELS } from "@omniralph/shared";

/**
 * The labels keeping Omniralph from working in a repository's issues; the
 * defaults when its settings predate them, none when they're emptied.
 */
export function repositoryBlockedLabels(repository: {
  ralphSettings: { blockedLabels?: readonly string[] | null };
}): string[] {
  const labels = repository.ralphSettings.blockedLabels;
  if (!Array.isArray(labels)) return [...DEFAULT_BLOCKED_LABELS];
  return labels.map((l) => l.trim()).filter(Boolean);
}

/** The labels of `issues` that a repository's blocked labels name (matched ignoring case), in order. */
export function blockingLabels(
  issues: readonly { labels: readonly string[] }[],
  repository: { ralphSettings: { blockedLabels?: readonly string[] | null } },
): string[] {
  const blocked = new Set(repositoryBlockedLabels(repository).map((l) => l.toLowerCase()));
  const found: string[] = [];
  for (const label of issues.flatMap((i) => i.labels)) {
    const key = label.trim().toLowerCase();
    if (blocked.has(key) && !found.some((f) => f.toLowerCase() === key)) found.push(label.trim());
  }
  return found;
}

/** The response refusing to work an issue because of its blocked labels. */
export function blockedLabelsMessage(
  issue: { identifier: string },
  labels: readonly string[],
  repositoryPath?: string,
): string {
  const named = labels.map((l) => `\`${l}\``).join(", ");
  const where = repositoryPath
    ? `\`${repositoryPath}\` doesn't let me work issues labeled ${named}`
    : `no repository lets me work issues labeled ${named}`;
  return [
    `I won't work on **${issue.identifier}**: ${where}.`,
    "Remove the label (from the issue, or its epic), then delegate it to me again. The labels " +
      "are set per repository under **Repository › Settings › Coding › Linear › Blocked labels**.",
  ].join("\n\n");
}
