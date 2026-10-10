/**
 * Capabilities an agent host can run: code review, and `ralph` (building a
 * Linear epic story by story, ported from cyralph).
 */
export const CAPABILITIES = ["review", "ralph", "triage"] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
export * from "./finding.js";
export * from "./agent-protocol.js";
export * from "./protocol.js";
export * from "./review-job.js";
export * from "./settings.js";
export * from "./feedback.js";
export * from "./rules.js";
export * from "./reply.js";
export * from "./rerun.js";
export * from "./ralph-job.js";
export * from "./triage-job.js";
