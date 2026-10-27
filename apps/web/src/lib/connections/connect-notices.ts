/**
 * What a Linear, Slack or Discord connect flow ends with: its connect and callback routes
 * land on the new connection's page with `?{provider}=connected`, or on Add connection with
 * `?{provider}=<code>`, and Settings shows the notice as a toast.
 */

/** The providers connected through an OAuth consent screen. */
export const OAUTH_PROVIDERS = ["linear", "slack", "discord"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const CONNECT_NOTICES = [
  "connected",
  "denied",
  "invalid",
  "invalid_state",
  "other_organization",
  "not_configured",
  "error",
] as const;
export type ConnectNotice = (typeof CONNECT_NOTICES)[number];

type Notices = Record<ConnectNotice, { title: string; description: string }>;

const linearNotices: Notices = {
  connected: {
    title: "Linear connected",
    description: "Delegate an issue to the Omniralph app in Linear to start a coding task.",
  },
  denied: {
    title: "Linear wasn't connected",
    description: "The installation was cancelled on Linear's consent screen.",
  },
  invalid: {
    title: "Linear didn't return an authorization code",
    description: "Click Connect to try again.",
  },
  invalid_state: {
    title: "The Linear sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    title: "This Linear workspace belongs to another organization",
    description:
      "A Linear workspace can be connected to one organization only. Disconnect it there first, or connect a different workspace.",
  },
  not_configured: {
    title: "Linear app not configured",
    description: "Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET, then connect again.",
  },
  error: {
    title: "Connecting Linear failed",
    description: "Linear rejected the authorization or couldn't be reached. Try again.",
  },
};

const slackNotices: Notices = {
  connected: {
    title: "Slack connected",
    description: "Mention the Omniralph app in a channel to start a conversation.",
  },
  denied: {
    title: "Slack wasn't connected",
    description: "The installation was cancelled on Slack's install screen.",
  },
  invalid: {
    title: "Slack didn't return an authorization code",
    description: "Click Connect to try again.",
  },
  invalid_state: {
    title: "The Slack sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    title: "This Slack workspace belongs to another organization",
    description:
      "A Slack workspace can be connected to one organization only. Disconnect it there first, or connect a different workspace.",
  },
  not_configured: {
    title: "Slack app not configured",
    description:
      "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET, then connect again.",
  },
  error: {
    title: "Connecting Slack failed",
    description: "Slack rejected the authorization or couldn't be reached. Try again.",
  },
};

const discordNotices: Notices = {
  connected: {
    title: "Discord connected",
    description: "Mention the Omniralph bot in a channel to start a conversation.",
  },
  denied: {
    title: "Discord wasn't connected",
    description: "Adding the bot was cancelled on Discord's authorization screen.",
  },
  invalid: {
    title: "Discord didn't return an authorization code",
    description: "Click Connect to try again.",
  },
  invalid_state: {
    title: "The Discord sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    title: "This Discord server belongs to another organization",
    description:
      "A Discord server can be connected to one organization only. Disconnect it there first, or connect a different server.",
  },
  not_configured: {
    title: "Discord app not configured",
    description:
      "Set DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN and DISCORD_PUBLIC_KEY, then connect again.",
  },
  error: {
    title: "Connecting Discord failed",
    description: "Discord rejected the authorization or couldn't be reached. Try again.",
  },
};

/** Each provider's notices, by the code its routes redirect with. */
export const CONNECT_NOTICE_TEXT: Record<OAuthProvider, Notices> = {
  linear: linearNotices,
  slack: slackNotices,
  discord: discordNotices,
};

/** The code a connect route redirected with, or null for an unknown one. */
export function connectNotice(value: string | null | undefined): ConnectNotice | null {
  return value && (CONNECT_NOTICES as readonly string[]).includes(value)
    ? (value as ConnectNotice)
    : null;
}

/** The toast for a notice: its title and description, success only for `connected`. */
export function connectNoticeToast(
  provider: OAuthProvider,
  notice: ConnectNotice,
): { message: string; variant: "success" | "danger" } {
  const { title, description } = CONNECT_NOTICE_TEXT[provider][notice];
  return {
    message: `${title}. ${description}`,
    variant: notice === "connected" ? "success" : "danger",
  };
}

/** Settings › Connections › Add connection, where a connect flow that didn't connect lands. */
export const ADD_CONNECTION_PATH = "/settings/connections/new";

/** Where a connect flow lands: Add connection with `?{provider}=<code>`. */
export function connectNoticePath(provider: OAuthProvider, notice: ConnectNotice): string {
  return `${ADD_CONNECTION_PATH}?${provider}=${notice}`;
}

/** Where a connect flow that connected lands: the connection's page with `?{provider}=connected`. */
export function connectedPath(provider: OAuthProvider, connectionId: string): string {
  return `/settings/connections/${provider}/${encodeURIComponent(connectionId)}?${provider}=connected`;
}
