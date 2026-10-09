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
  InlineCode,
  Muted,
} from "@iamthemcmaster/ui";
import { IconPlugConnected, IconUnlink } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import { disconnectLinear, disconnectSlack } from "./actions";

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
  { title: string; description: string; variant: "success" | "warning" | "destructive" }
>;

const linearNotices: Notices = {
  connected: {
    variant: "success",
    title: "Linear connected",
    description: "Delegate an issue to the Omniralph app in Linear to start a ralph run.",
  },
  denied: {
    variant: "warning",
    title: "Linear wasn't connected",
    description: "The installation was cancelled on Linear's consent screen.",
  },
  invalid: {
    variant: "destructive",
    title: "Linear didn't return an authorization code",
    description: "Click Connect Linear to try again.",
  },
  invalid_state: {
    variant: "destructive",
    title: "The Linear sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect Linear again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    variant: "destructive",
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
    variant: "destructive",
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
    variant: "destructive",
    title: "Slack didn't return an authorization code",
    description: "Click Connect Slack to try again.",
  },
  invalid_state: {
    variant: "destructive",
    title: "The Slack sign-in link was invalid or expired",
    description:
      "For your safety the request was rejected. Click Connect Slack again from this browser and finish within 10 minutes.",
  },
  other_organization: {
    variant: "destructive",
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
    variant: "destructive",
    title: "Connecting Slack failed",
    description: "Slack rejected the authorization or couldn't be reached. Try again.",
  },
};

export interface SlackWorkspace {
  /** The chat connection's ID. */
  id: string;
  name: string;
  /** Slack team ID (or enterprise ID for an org-wide install). */
  workspaceId: string;
  /** Name or email of the admin who installed it, null when unknown. */
  installedBy: string | null;
  /** ISO timestamp. */
  connectedAt: string;
}

export interface LinearConnection {
  name: string;
  workspaceId: string;
  /** ISO timestamp. */
  connectedAt: string;
}

export function IntegrationsView({
  linear,
  linearConfigured,
  notice,
  slack,
  slackConfigured,
  slackNotice,
}: {
  linear: LinearConnection | null;
  linearConfigured: boolean;
  notice: IntegrationNotice | null;
  slack: SlackWorkspace[];
  slackConfigured: boolean;
  slackNotice: IntegrationNotice | null;
}) {
  const { pending, run } = useAction();

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Settings" }, { label: "Integrations" }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: "var(--text-2xl)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            Integrations
          </h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Issue trackers Omniralph works from and chat platforms people talk to it in. Delegating
            a Linear issue to the Omniralph app starts a ralph run.
          </Muted>
        </div>

        {notice && (
          <Alert variant={linearNotices[notice].variant}>
            <AlertTitle>{linearNotices[notice].title}</AlertTitle>
            <AlertDescription>{linearNotices[notice].description}</AlertDescription>
          </Alert>
        )}
        {slackNotice && (
          <Alert variant={slackNotices[slackNotice].variant}>
            <AlertTitle>{slackNotices[slackNotice].title}</AlertTitle>
            <AlertDescription>{slackNotices[slackNotice].description}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              Linear
              {linear ? (
                <Badge variant="success" size="sm">
                  Connected
                </Badge>
              ) : (
                <Badge variant="neutral" size="sm">
                  Not connected
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {linear ? (
                <>
                  Connected to the <strong>{linear.name}</strong> workspace since{" "}
                  {formatDateTime(linear.connectedAt)}.
                </>
              ) : (
                "Install the Omniralph app in one Linear workspace so issues can be delegated to it."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {!linearConfigured && (
              <Alert variant="info">
                <AlertTitle>Linear app not configured</AlertTitle>
                <AlertDescription>
                  Set <InlineCode>LINEAR_CLIENT_ID</InlineCode>,{" "}
                  <InlineCode>LINEAR_CLIENT_SECRET</InlineCode> and{" "}
                  <InlineCode>LINEAR_WEBHOOK_SECRET</InlineCode> to connect Linear (see
                  docs/env.md).
                </AlertDescription>
              </Alert>
            )}
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              {linearConfigured &&
                (linear ? (
                  <Button asChild variant="secondary" disabled={pending}>
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
                    <Button variant="destructive" disabled={pending}>
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
                        onClick={() => run(disconnectLinear, `Disconnected ${linear.name}`)}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              Slack
              {slack.length > 0 ? (
                <Badge variant="success" size="sm">
                  Connected
                </Badge>
              ) : (
                <Badge variant="neutral" size="sm">
                  Not connected
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Install the Omniralph app in a Slack workspace, then mention it in a channel to ask
              about runs, reviews, jobs, agents and repositories.
            </CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            {!slackConfigured && (
              <Alert variant="info">
                <AlertTitle>Slack app not configured</AlertTitle>
                <AlertDescription>
                  Set <InlineCode>SLACK_CLIENT_ID</InlineCode>,{" "}
                  <InlineCode>SLACK_CLIENT_SECRET</InlineCode> and{" "}
                  <InlineCode>SLACK_SIGNING_SECRET</InlineCode> to connect Slack (see docs/env.md).
                </AlertDescription>
              </Alert>
            )}
            {slack.map((workspace) => (
              <div
                key={workspace.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-3)",
                }}
              >
                <div>
                  <strong>{workspace.name}</strong>
                  <Muted style={{ display: "block" }}>
                    Connected {formatDateTime(workspace.connectedAt)}
                    {workspace.installedBy && <> by {workspace.installedBy}</>}
                  </Muted>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={pending}>
                      <IconUnlink size={14} />
                      Disconnect
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect {workspace.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Omniralph forgets the workspace&apos;s bot token and its conversations, and
                        revokes the token. Mentions in Slack are ignored until you connect again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          run(() => disconnectSlack(workspace.id), `Disconnected ${workspace.name}`)
                        }
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              {slackConfigured ? (
                <Button asChild variant={slack.length > 0 ? "secondary" : "primary"}>
                  {/* A plain link: the route redirects to Slack's install screen. */}
                  <a href="/api/integrations/slack/connect">
                    <IconPlugConnected size={14} />
                    {slack.length > 0 ? "Connect another workspace" : "Connect Slack"}
                  </a>
                </Button>
              ) : (
                <Button variant="primary" disabled>
                  <IconPlugConnected size={14} />
                  Connect Slack
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
