import { toIssuePriority, type CreateIssueInput, type IssueSummary } from "@omniralph/tracker";
import type { LinearGateway } from "@omniralph/tracker/linear";
import type { IssuePlacement } from "../placement";

/** Whether the gateway has the Linear-only reads (a Linear gateway, or a lazy one over it). */
export function isLinearGateway(gateway: { provider: string }): gateway is LinearGateway {
  return (
    gateway.provider === "linear" &&
    typeof (gateway as Partial<LinearGateway>).getRoutingFields === "function"
  );
}

/** A Linear issue's placement: its routing fields, with its milestone and cycle as extras. */
export async function linearIssuePlacement(
  gateway: LinearGateway,
  issueId: string,
): Promise<IssuePlacement> {
  const { issue } = await gateway.getRoutingFields(issueId);
  return {
    ...(issue.teamId && { teamId: issue.teamId }),
    ...(issue.projectId && { projectId: issue.projectId }),
    ...(issue.project && { projectName: issue.project }),
    priority: toIssuePriority(issue.priority),
    labels: issue.labels,
    extras: {
      ...(issue.projectMilestoneId && { projectMilestoneId: issue.projectMilestoneId }),
      ...(issue.cycle && { cycleId: issue.cycle }),
    },
  };
}

/**
 * Creates an issue with Linear's extras. Linear may refuse the cycle (e.g.
 * once it's completed): then it retries once without it, and the extras it
 * returns leave the cycle out.
 */
export async function createLinearIssueWithExtras(
  gateway: LinearGateway,
  input: CreateIssueInput,
  extras: Record<string, string>,
): Promise<{ issue: IssueSummary; extras: Record<string, string> }> {
  try {
    return { issue: await gateway.createIssue({ ...input, ...extras }), extras };
  } catch (error) {
    const { cycleId, ...withoutCycle } = extras;
    if (!cycleId) throw error;
    console.warn(`Could not file "${input.title}" in cycle ${cycleId}, retrying without it`, error);
    return {
      issue: await gateway.createIssue({ ...input, ...withoutCycle }),
      extras: withoutCycle,
    };
  }
}
