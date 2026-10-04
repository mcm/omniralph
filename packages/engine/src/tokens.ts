/**
 * Deterministic input-token estimate (~3.5 characters per token). Kept in its
 * own module so a real tokenizer can replace it without touching the planner.
 */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
