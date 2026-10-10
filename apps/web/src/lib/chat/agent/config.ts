/**
 * The control-panel agent's model comes from the Vercel AI Gateway, which
 * authenticates with `AI_GATEWAY_API_KEY` or, on Vercel, the deployment's
 * OIDC token.
 */

export const DEFAULT_CHAT_AGENT_MODEL = "anthropic/claude-haiku-5.5";
/** Model calls per turn (each tool round-trip is one). */
export const CHAT_AGENT_MAX_STEPS = 8;
/** Messages of the thread the agent sees each turn. */
export const CHAT_AGENT_HISTORY_LIMIT = 50;

export interface ChatAgentConfig {
  /** AI Gateway model id, e.g. `anthropic/claude-haiku-5.5`. */
  model: string;
}

/** The agent's config, or null when the AI Gateway has no credentials. */
export function chatAgentConfig(env: NodeJS.ProcessEnv = process.env): ChatAgentConfig | null {
  const gatewayAuth = Boolean(
    env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || env.VERCEL === "1",
  );
  if (!gatewayAuth) return null;
  return { model: env.CHAT_AGENT_MODEL?.trim() || DEFAULT_CHAT_AGENT_MODEL };
}

/** Limits on the files attached to chat messages that the agent reads. */
export interface ChatAttachmentLimits {
  /** Attachments read per message; the rest are skipped. */
  perMessage: number;
  /** Largest image read (bytes). */
  maxImageBytes: number;
  /** Largest text file read (bytes). */
  maxTextBytes: number;
  /** Attachments of the whole thread fetched for one turn, newest first. */
  perTurn: number;
}

export const CHAT_ATTACHMENT_LIMITS: ChatAttachmentLimits = {
  perMessage: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxTextBytes: 256 * 1024,
  perTurn: 10,
};
