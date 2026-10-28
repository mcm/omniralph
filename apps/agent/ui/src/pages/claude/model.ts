/** The Claude page's copy: what the last check found, in sentences. */
import type { ClaudeLoginSource } from "@omniralph/shared";
import type { StatusTone } from "@omniralph/ui";
import type { ClaudeStatus } from "../../../../src/claude-status.js";

/** Where the credentials come from. */
export const SOURCE_LABELS: Record<ClaudeLoginSource, string> = {
  login: "Claude login",
  api_key: "API key from ANTHROPIC_API_KEY",
  oauth_token: "OAuth token from CLAUDE_CODE_OAUTH_TOKEN",
  other: "Third-party provider",
};

export const NOT_SIGNED_IN = "Not signed in";
export const NOT_CHECKED = "Not checked yet";
export const CHECK_FAILED = "Couldn't check whether Claude is signed in";
export const NO_MODELS = "None reported";

/** "Max" for `max`, "Team" for `team`; anything else as reported, capitalized. */
export function subscriptionLabel(type: string): string {
  const spaced = type.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The headline: "Signed in as steve@example.com · Max", "Not signed in", … */
export function loginHeadline(claude: ClaudeStatus | null): { text: string; tone?: StatusTone } {
  if (claude === null) return { text: NOT_CHECKED };
  if (claude.status === "signed_out") return { text: NOT_SIGNED_IN, tone: "fail" };
  if (claude.status === "unknown") return { text: CHECK_FAILED };
  const email = claude.account?.email ?? null;
  const plan = claude.account?.subscriptionType ?? null;
  const who = email === null ? "Signed in" : `Signed in as ${email}`;
  return { text: plan === null ? who : `${who} · ${subscriptionLabel(plan)}` };
}
