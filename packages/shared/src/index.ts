/**
 * Capabilities an agent host can run. v1 ships only code review; cyralph
 * ("ralph") lands in a follow-up epic.
 */
export const CAPABILITIES = ["review"] as const;

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
