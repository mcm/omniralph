/**
 * The dependency rules (`dependencyViolations` in `@omniralph/planning`) applied to what a run
 * builds: the epic and its tasks, or a standalone task. Om refuses to start such work, and a
 * running epic waits, while one of their blocks relations breaks the rules.
 */
import { dependencyViolations, workItemRole, type DependencyViolation } from "@omniralph/planning";
import type { PlannedItem } from "@omniralph/planning";
import type { IssueSummary, TrackerGateway } from "@omniralph/tracker";

/** The tracker reads the relation check needs. */
export type RelationsReader = Pick<TrackerGateway, "getIssue" | "getChildren" | "getBlockers">;

const notCanceled = (issue: Pick<IssueSummary, "stateType">) => issue.stateType !== "canceled";
const notDone = (issue: Pick<IssueSummary, "stateType">) =>
  issue.stateType !== "canceled" && issue.stateType !== "completed";

/**
 * Reads work items as the dependency rules see them (role and epic), each once per check.
 */
class PlannedItems {
  private readonly issues = new Map<string, Promise<IssueSummary>>();
  private readonly children = new Map<string, Promise<IssueSummary[]>>();
  private readonly planned = new Map<string, Promise<PlannedItem>>();

  constructor(private readonly reader: RelationsReader) {}

  issue(id: string): Promise<IssueSummary> {
    let found = this.issues.get(id);
    if (!found) {
      found = this.reader.getIssue(id);
      this.issues.set(id, found);
    }
    return found;
  }

  /** Its sub-issues that aren't canceled. */
  openChildren(id: string): Promise<IssueSummary[]> {
    let found = this.children.get(id);
    if (!found) {
      found = this.reader.getChildren(id).then((children) => children.filter(notCanceled));
      this.children.set(id, found);
    }
    return found;
  }

  item(id: string): Promise<PlannedItem> {
    let found = this.planned.get(id);
    if (!found) {
      found = this.read(id);
      this.planned.set(id, found);
    }
    return found;
  }

  private async read(id: string): Promise<PlannedItem> {
    const issue = await this.issue(id);
    const children = await this.openChildren(issue.id);
    const grandchildren = (
      await Promise.all(children.map((child) => this.openChildren(child.id)))
    ).flat();
    const { role } = workItemRole(issue, children, grandchildren);
    const ref = { id: issue.id, identifier: issue.identifier };
    if (role !== "task" || !issue.parentId) return { ...ref, role };
    const parent = await this.issue(issue.parentId);
    return { ...ref, role, parent: { id: parent.id, identifier: parent.identifier } };
  }
}

/**
 * Every blocks relation of the work a run of `issueId` would build that breaks the dependency
 * rules. A run builds the work item itself when it has (open) sub-issues, else its parent's epic
 * (a task delegated on its own), else the task alone, as `loadEpic` does; the relations checked
 * are the blockers of that epic and of its open tasks, or of the standalone task. Canceled
 * blockers don't count, nor do tasks already done. Throws when the tracker can't be read.
 */
export async function relationViolations(
  reader: RelationsReader,
  issueId: string,
): Promise<DependencyViolation[]> {
  const items = new PlannedItems(reader);
  const issue = await items.issue(issueId);
  let root = issue;
  let tasks = await items.openChildren(issue.id);
  if (tasks.length === 0 && issue.parentId) {
    root = await items.issue(issue.parentId);
    tasks = await items.openChildren(root.id);
  }
  const checked = [root, ...tasks.filter(notDone)];
  const found = await Promise.all(
    checked.map(async (blocked) => {
      const blockers = (await reader.getBlockers(blocked.id)).filter(notCanceled);
      return dependencyViolations(
        await items.item(blocked.id),
        await Promise.all(blockers.map((blocker) => items.item(blocker.id))),
      );
    }),
  );
  return found.flat();
}

const list = (violations: readonly DependencyViolation[]) =>
  violations.map((violation) => `- ${violation.message}`).join("\n");

const rules =
  "Dependencies follow epic boundaries: a task may be blocked only by an epic, a standalone task " +
  "or a task in its own epic, and an epic only by epics or standalone tasks.";

/**
 * The response refusing to start work whose relations break the rules (tracker Markdown);
 * `then` says how to try again.
 */
export function relationsMessage(
  violations: readonly DependencyViolation[],
  then = "delegate me again",
): string {
  return [
    `I won't start this: ${violations.length > 1 ? "these relations break" : "this relation breaks"} the dependency rules.`,
    list(violations),
    `${rules} Fix ${violations.length > 1 ? "them" : "it"}, then ${then}.`,
  ].join("\n\n");
}

/** The elicitation of a running epic that waits until its relations are fixed (tracker Markdown). */
export function relationsWaitingMessage(
  identifier: string,
  violations: readonly DependencyViolation[],
): string {
  return [
    `**${identifier}** is paused: ${violations.length > 1 ? "these relations break" : "this relation breaks"} the dependency rules.`,
    list(violations),
    `${rules} Fix ${violations.length > 1 ? "them" : "it"} and I'll go on: I check again on my own, or reply to check now. Or say \`stop\`.`,
  ].join("\n\n");
}

/** Why Start (or Start anyway) is refused, in plain text for the page and the Inbox. */
export function relationsStartReason(violations: readonly DependencyViolation[]): string {
  const messages = violations.map((violation) => violation.message).join(" ");
  return `${violations.length > 1 ? "These relations break" : "This relation breaks"} the dependency rules. ${messages}`;
}
