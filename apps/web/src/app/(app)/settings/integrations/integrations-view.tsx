"use client";

import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Cluster,
  InlineCode,
  Muted,
  Skeleton,
  Stack,
} from "@iamthemcmaster/ui";
import { IconPlugConnected, IconUnlink } from "@tabler/icons-react";
import { redirect, useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { EnvDocsLink } from "@/components/env-docs-link";
import { Timestamp } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type {
  DiscordServer,
  IntegrationsSettings,
  LinearConnection,
  SlackWorkspace,
} from "@/lib/api/integrations";
import { mutationResultSchema } from "@/lib/api/schemas";
import { ACCESS_DENIED_PATH } from "@/lib/auth/routes";
import {
  INTEGRATION_STATE_LABELS,
  INTEGRATION_STATE_VARIANTS,
  integrationState,
} from "@/lib/state-variants";
import { ChatTasksCard } from "./chat-tasks-card";
import { integrationsChanged, useIntegrations } from "./integrations-queries";

export type { DiscordServer, LinearConnection, SlackWorkspace };

export type IntegrationNotice =
  | "connected"
  | "denied"
  | "invalid"
  | "invalid_state"
  | "other_organization"
  | "not_configured"
  | "error";

type Notices = Record<
  IntegrationNotice,
  { title: string; description: string; variant: "success" | "warning" | "danger" }
>;

const linearNotices: Notices = {
  connected: {
    variant: "success",
    title: "Linear connected",
    description: "Delegate an issue to the Omniralph app in Linear to start a coding task.",
  },
  denied: {
    variant: "warning",
    title: "Linear wasn't connected",
    description: "The installation was cancelled on Linear's consent screen.",
  },
  invalid: {
    variant: "danger",
    title: "Linear didn't return an authorization code",
    description: "Click Connect Linear to try again.",
  },
  invalid_state: {
    variant: "danger",
    title: "The Linear sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect Linear again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    variant: "danger",
    title: "This Linear workspace belongs to another organization",
    description:
      "A Linear workspace can be connected to one organization only. Disconnect it there first, or connect a different workspace.",
  },
  not_configured: {
    variant: "warning",
    title: "Linear app not configured",
    description: "Set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET, then connect again.",
  },
  error: {
    variant: "danger",
    title: "Connecting Linear failed",
    description: "Linear rejected the authorization or couldn't be reached. Try again.",
  },
};

const slackNotices: Notices = {
  connected: {
    variant: "success",
    title: "Slack connected",
    description: "Mention the Omniralph app in a channel to start a conversation.",
  },
  denied: {
    variant: "warning",
    title: "Slack wasn't connected",
    description: "The installation was cancelled on Slack's install screen.",
  },
  invalid: {
    variant: "danger",
    title: "Slack didn't return an authorization code",
    description: "Click Connect Slack to try again.",
  },
  invalid_state: {
    variant: "danger",
    title: "The Slack sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect Slack again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    variant: "danger",
    title: "This Slack workspace belongs to another organization",
    description:
      "A Slack workspace can be connected to one organization only. Disconnect it there first, or connect a different workspace.",
  },
  not_configured: {
    variant: "warning",
    title: "Slack app not configured",
    description:
      "Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET, then connect again.",
  },
  error: {
    variant: "danger",
    title: "Connecting Slack failed",
    description: "Slack rejected the authorization or couldn't be reached. Try again.",
  },
};

const discordNotices: Notices = {
  connected: {
    variant: "success",
    title: "Discord connected",
    description: "Mention the Omniralph bot in a channel to start a conversation.",
  },
  denied: {
    variant: "warning",
    title: "Discord wasn't connected",
    description: "Adding the bot was cancelled on Discord's authorization screen.",
  },
  invalid: {
    variant: "danger",
    title: "Discord didn't return an authorization code",
    description: "Click Connect Discord to try again.",
  },
  invalid_state: {
    variant: "danger",
    title: "The Discord sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect Discord again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    variant: "danger",
    title: "This Discord server belongs to another organization",
    description:
      "A Discord server can be connected to one organization only. Disconnect it there first, or connect a different server.",
  },
  not_configured: {
    variant: "warning",
    title: "Discord app not configured",
    description:
      "Set DISCORD_APPLICATION_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN and DISCORD_PUBLIC_KEY, then connect again.",
  },
  error: {
    variant: "danger",
    title: "Connecting Discord failed",
    description: "Discord rejected the authorization or couldn't be reached. Try again.",
  },
};

/** The OAuth outcome a connect route redirects back with (`?linear=connected`, …). */
const toNotice = (value: string | null): IntegrationNotice | null =>
  value && Object.hasOwn(linearNotices, value) ? (value as IntegrationNotice) : null;

function IntegrationsSkeleton() {
  return (
    <Stack gap={4}>
      {[1, 1, 1, 2].map((rows, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <Stack gap={3} asChild>
            <CardContent>
              {Array.from({ length: rows }, (_, row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </CardContent>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

/**
 * Settings › Integrations (admins), live: a connection made in another tab (an OAuth
 * install) or removed elsewhere shows without a reload, and so do chat task changes.
 */
export function IntegrationsView() {
  const { role } = useCurrentUser();
  if (role !== "admin") redirect(`${ACCESS_DENIED_PATH}?reason=forbidden`);
  return <AdminIntegrationsView />;
}

function AdminIntegrationsView() {
  const query = useIntegrations();
  const searchParams = useSearchParams();
  const notice = toNotice(searchParams.get("linear"));
  const slackNotice = toNotice(searchParams.get("slack"));
  const discordNotice = toNotice(searchParams.get("discord"));

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Integrations" }]} />
      <div className="detail-main">
        <PageHeader
          title="Integrations"
          description="Issue trackers Omniralph works from and chat platforms people talk to it in. Delegating a Linear issue to the Omniralph app starts a coding task."
        />

        {notice && (
          <Alert variant={linearNotices[notice].variant}>
            <AlertTitle as="h2">{linearNotices[notice].title}</AlertTitle>
            <AlertDescription>{linearNotices[notice].description}</AlertDescription>
          </Alert>
        )}
        {slackNotice && (
          <Alert variant={slackNotices[slackNotice].variant}>
            <AlertTitle as="h2">{slackNotices[slackNotice].title}</AlertTitle>
            <AlertDescription>{slackNotices[slackNotice].description}</AlertDescription>
          </Alert>
        )}
        {discordNotice && (
          <Alert variant={discordNotices[discordNotice].variant}>
            <AlertTitle as="h2">{discordNotices[discordNotice].title}</AlertTitle>
            <AlertDescription>{discordNotices[discordNotice].description}</AlertDescription>
          </Alert>
        )}

        <QueryBoundary query={query} skeleton={<IntegrationsSkeleton />} what="the integrations">
          {(settings) => <IntegrationsContent {...settings} />}
        </QueryBoundary>
      </div>
    </>
  );
}

/** A disconnect request: the integration's `/api/ui/integrations` path. */
function useDisconnect(path: (id: string) => string) {
  return useApiMutation({
    mutationFn: ({ id }: { id: string; name: string }, { organizationId }) =>
      api.delete(path(id), mutationResultSchema, { organizationId }),
    invalidate: integrationsChanged,
    success: (_, { name }) => `Disconnected ${name}`,
  });
}

/** The integrations' cards, from `GET /api/ui/integrations`. */
export function IntegrationsContent({
  linear,
  linearConfigured,
  slack,
  slackConfigured,
  discord,
  discordConfigured,
  chatTasks,
}: IntegrationsSettings) {
  const linearDisconnect = useDisconnect(() => "/api/ui/integrations/linear");
  const slackDisconnect = useDisconnect((id) => `/api/ui/integrations/slack/${id}`);
  const discordDisconnect = useDisconnect((id) => `/api/ui/integrations/discord/${id}`);
  const linearPending = linearDisconnect.isPending;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="settings-card-title">
            Linear
            <IntegrationBadge connected={Boolean(linear)} configured={linearConfigured} />
          </CardTitle>
          <CardDescription>
            {linear ? (
              <>
                Connected to the <strong>{linear.name}</strong> workspace since{" "}
                <Timestamp iso={linear.connectedAt} inline />.
              </>
            ) : (
              "Install the Omniralph app in one Linear workspace so issues can be delegated to it."
            )}
          </CardDescription>
        </CardHeader>
        <Stack gap={3} asChild>
          <CardContent>
            {!linearConfigured && (
              <AppNotConfiguredAlert
                platform="Linear"
                envVars={["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"]}
                connectedName={linear?.name ?? null}
                ignored="delegations from Linear are rejected"
              />
            )}
            <Cluster>
              {linearConfigured &&
                (linear ? (
                  <Button asChild variant="secondary" disabled={linearPending}>
                    {/* A plain link: the route redirects to Linear's consent screen. */}
                    <a href="/api/integrations/linear/connect">
                      <IconPlugConnected size={14} />
                      Reconnect
                    </a>
                  </Button>
                ) : (
                  <Button asChild variant="primary">
                    <a href="/api/integrations/linear/connect">
                      <IconPlugConnected size={14} />
                      Connect Linear
                    </a>
                  </Button>
                ))}
              {linear && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="danger" disabled={linearPending}>
                      <IconUnlink size={14} />
                      Disconnect
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {linear.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Omniralph forgets the workspace&apos;s tokens and revokes them. Delegations
                        from Linear are ignored until you connect again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="danger"
                        onClick={() => linearDisconnect.mutate({ id: "linear", name: linear.name })}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </Cluster>
          </CardContent>
        </Stack>
      </Card>

      <ChatPlatformCard
        platform="Slack"
        description="Install the Omniralph app in a Slack workspace, then mention it in a channel to ask about runs, reviews, jobs, agents and repositories."
        envVars={["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]}
        configured={slackConfigured}
        connections={slack}
        connectHref="/api/integrations/slack/connect"
        connectAnother="Connect another workspace"
        disconnectDescription="Omniralph forgets the workspace's bot token and its conversations, and revokes the token. Mentions in Slack are ignored until you connect again."
        disconnect={slackDisconnect}
      />

      <ChatPlatformCard
        platform="Discord"
        description="Add the Omniralph bot to a Discord server, then mention it in a channel to ask about runs, reviews, jobs, agents and repositories."
        envVars={[
          "DISCORD_APPLICATION_ID",
          "DISCORD_CLIENT_SECRET",
          "DISCORD_BOT_TOKEN",
          "DISCORD_PUBLIC_KEY",
        ]}
        configured={discordConfigured}
        connections={discord}
        connectHref="/api/integrations/discord/connect"
        connectAnother="Connect another server"
        disconnectDescription="Omniralph forgets the server and its conversations, and the bot leaves it. Mentions in Discord are ignored until you connect again."
        disconnect={discordDisconnect}
      />

      <ChatTasksCard {...chatTasks} />
    </>
  );
}

/** A chat platform's card: its connections with Disconnect each, and Connect. */
function ChatPlatformCard({
  platform,
  description,
  envVars,
  configured,
  connections,
  connectHref,
  connectAnother,
  disconnectDescription,
  disconnect,
}: {
  platform: string;
  description: string;
  envVars: string[];
  configured: boolean;
  connections: Array<{ id: string; name: string; installedBy: string | null; connectedAt: string }>;
  connectHref: string;
  connectAnother: string;
  disconnectDescription: string;
  disconnect: ReturnType<typeof useDisconnect>;
}) {
  const pending = disconnect.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="settings-card-title">
          {platform}
          <IntegrationBadge connected={connections.length > 0} configured={configured} />
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <Stack gap={3} asChild>
        <CardContent>
          {!configured && (
            <AppNotConfiguredAlert
              platform={platform}
              envVars={envVars}
              connectedName={
                connections.length === 0
                  ? null
                  : connections.length === 1
                    ? connections[0]!.name
                    : `${connections.length} connections`
              }
              ignored={`mentions in ${platform} are ignored`}
            />
          )}
          {connections.map((connection) => (
            <Cluster key={connection.id} gap={3} justify="between">
              <div>
                <strong>{connection.name}</strong>
                <Muted>
                  Connected <Timestamp iso={connection.connectedAt} inline />
                  {connection.installedBy && <> by {connection.installedBy}</>}
                </Muted>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="danger" disabled={pending}>
                    <IconUnlink size={14} />
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect {connection.name}?</AlertDialogTitle>
                    <AlertDialogDescription>{disconnectDescription}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="danger"
                      onClick={() => disconnect.mutate(connection)}
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </Cluster>
          ))}
          <Cluster>
            {configured ? (
              <Button asChild variant={connections.length > 0 ? "secondary" : "primary"}>
                {/* A plain link: the route redirects to the platform's install screen. */}
                <a href={connectHref}>
                  <IconPlugConnected size={14} />
                  {connections.length > 0 ? connectAnother : `Connect ${platform}`}
                </a>
              </Button>
            ) : (
              <Button variant="primary" disabled>
                <IconPlugConnected size={14} />
                Connect {platform}
              </Button>
            )}
          </Cluster>
        </CardContent>
      </Stack>
    </Card>
  );
}

/** "Connected", or a warning when the connection is saved but the server can't use it. */
function IntegrationBadge({ connected, configured }: { connected: boolean; configured: boolean }) {
  const state = integrationState(connected, configured);
  return (
    <Badge variant={INTEGRATION_STATE_VARIANTS[state]}>{INTEGRATION_STATE_LABELS[state]}</Badge>
  );
}

/**
 * The platform's app credentials are missing on this server. With a connection
 * still saved, it says how the two relate: the connection is kept, but nothing
 * from the platform reaches Omniralph until the credentials are set.
 */
function AppNotConfiguredAlert({
  platform,
  envVars,
  connectedName,
  ignored,
}: {
  platform: string;
  envVars: string[];
  /** The saved connection(s), or null when there are none. */
  connectedName: string | null;
  /** What happens to the platform's events meanwhile, e.g. "mentions in Slack are ignored". */
  ignored: string;
}) {
  // One per line: inline, the chips break the sentence apart on a phone.
  const vars = (
    <ul className="env-var-list">
      {envVars.map((name) => (
        <li key={name}>
          <InlineCode>{name}</InlineCode>
        </li>
      ))}
    </ul>
  );
  if (connectedName) {
    return (
      <Alert variant="warning">
        <AlertTitle as="h3">Connected, but the {platform} app isn&apos;t configured</AlertTitle>
        <AlertDescription>
          The connection to <strong>{connectedName}</strong> is saved, but this server is missing
          these, so {ignored} until they&apos;re set (see <EnvDocsLink />
          ):
          {vars}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="info">
      <AlertTitle as="h3">{platform} app not configured</AlertTitle>
      <AlertDescription>
        To connect {platform}, set these on the server (see <EnvDocsLink />
        ):
        {vars}
      </AlertDescription>
    </Alert>
  );
}
