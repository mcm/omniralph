import { agentTopic, capabilityTopic, isCapability, SYSTEM_CAPABILITY } from "@omniralph/shared";

type Env = Record<string, string | undefined>;

const REGION = /^[a-z]{3}\d$/;

/**
 * Vercel Queues regions the control panel uses (`QUEUE_REGIONS`, comma-separated,
 * e.g. `iad1`). Jobs are published to the first one; the queue proxy only
 * forwards to regions in this list.
 */
export function queueRegions(env: Env = process.env): string[] {
  return (env.QUEUE_REGIONS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => REGION.test(r));
}

/** The region jobs are published to (and agents poll): the first of `QUEUE_REGIONS`. */
export function publishRegion(env: Env = process.env): string {
  const [region] = queueRegions(env);
  if (!region) throw new Error("Set QUEUE_REGIONS (e.g. iad1) to dispatch jobs");
  return region;
}

/**
 * Topics an agent may read: its own pinned topic and its organization's
 * shared topic for every capability enabled for it (e.g.
 * `ralph-jobs-org-<orgId>` and `ralph-jobs-agent-<id>` only with `ralph`
 * enabled), plus its own topic of the built-in `system` capability
 * (`repo.sync` pre-clones), which is always enabled. Enabled names that
 * aren't known capabilities are ignored. Never another organization's topics.
 */
export function agentTopics(agent: {
  id: string;
  organizationId: string;
  enabledCapabilities: readonly string[];
}): string[] {
  const enabled = agent.enabledCapabilities.filter(isCapability);
  return [
    ...enabled.map((c) => agentTopic(c, agent.id)),
    ...enabled.map((c) => capabilityTopic(c, agent.organizationId)),
    agentTopic(SYSTEM_CAPABILITY, agent.id),
  ];
}
