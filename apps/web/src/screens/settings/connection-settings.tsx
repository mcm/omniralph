"use client";

import {
  BrandMark,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  MetaBadge,
  Sheet,
  SummaryCells,
  StatusText,
  Toolbar,
  useLinkComponent,
  type MenuItem,
  type SummaryCell,
  type ToolbarProps,
} from "@omniralph/ui";
import { IconPencil, IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createElement, useState, type ReactNode } from "react";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { ConnectGitLabForm } from "@/components/connect-gitlab-form";
import { ConnectionHealth, healthLine } from "@/components/connection-health";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  CONNECTION_PROVIDER_LABELS,
  gitLabTokenResultSchema,
  type Connection,
  type ConnectionList,
  type ConnectionProvider,
  type ConnectionRole,
  type GitLabTokenResult,
} from "@/lib/api/connections";
import { connectionKeys } from "@/lib/api/keys";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { hasRole } from "@/lib/auth/roles";
import { withoutWebhookProblems, type ConnectionHealthSummary } from "@/lib/connections/health";
import { navigateTo, openInNewTab } from "@/lib/navigate";
import { useConnections } from "./queries";
import { SETTINGS_PATH } from "./settings-nav";
import { SettingsPage } from "./settings-page";
import { WebhookDeliveriesCard } from "./webhook-deliveries-card";
import { WorkItemStatesCard } from "./work-item-states-card";

/** Shown for a connection the organization doesn't have (removed, or another organization's). */
export const CONNECTION_NOT_FOUND = "This connection doesn't exist.";

/** What each role reads as in "Used as". */
export const USED_AS_LABELS: Record<ConnectionRole, string> = {
  code_host: "Code host",
  tracker: "Tracker",
  chat: "Chat",
};

/** The route that connects Linear, Slack or Discord again (their OAuth flow). */
export const CONNECT_ROUTES: Record<"linear" | "slack" | "discord", string> = {
  linear: "/api/integrations/linear/connect",
  slack: "/api/integrations/slack/connect",
  discord: "/api/integrations/discord/connect",
};

/** The route that disconnects the connection. */
export function disconnectPath(connection: Pick<Connection, "provider" | "id">): string {
  const id = encodeURIComponent(connection.id);
  switch (connection.provider) {
    case "github":
    case "gitlab":
      return `/api/ui/scm-connections/${id}`;
    case "linear":
      return "/api/ui/integrations/linear";
    case "slack":
      return `/api/ui/integrations/slack/${id}`;
    case "discord":
      return `/api/ui/integrations/discord/${id}`;
  }
}

/** The disconnect dialog's text: what goes with a code host, what stops for the others. */
export function disconnectDescription(connection: Connection): string {
  switch (connection.provider) {
    case "github":
    case "gitlab": {
      const count = connection.reposUsing ?? 0;
      return `Removes ${connection.name} and its ${count} ${count === 1 ? "repo" : "repos"}, with their reviews, rules and agent pins.`;
    }
    case "linear":
      return "Om stops picking up work items from Linear.";
    case "slack":
    case "discord":
      return `Om stops answering in ${connection.account ?? connection.name}.`;
  }
}

/** The add-repo sheet on Repos, for this code host's connection (Epic 6). */
export function manageReposHref(connection: Pick<Connection, "provider" | "id">): string {
  return `/repos?add=${connection.provider}&connection=${encodeURIComponent(connection.id)}`;
}

/** Writes `connectionId`'s row of Settings' connections (exactly that query). */
function setConnection(
  cache: MutationCache,
  connectionId: string,
  update: (connection: Connection) => Connection,
) {
  return cache.set<ConnectionList>(
    connectionKeys(cache.keys).list,
    (previous) =>
      previous && {
        ...previous,
        connections: previous.connections.map((connection) =>
          connection.id === connectionId ? update(connection) : connection,
        ),
      },
    { exact: true },
  );
}

function AppLink({ href, children }: { href: string; children: ReactNode }) {
  const link = useLinkComponent();
  return createElement(link, { href, className: "or-link" }, children);
}

/** The summary: Token, Repos using it (or Linked accounts) and Used as, with its ⓘ. */
function connectionSummaryCells(connection: Connection): SummaryCell[] {
  const { label, tone } = healthLine(connection.health);
  const cells: SummaryCell[] = [
    {
      id: "token",
      label: "Token",
      value: <StatusText tone={tone}>{label}</StatusText>,
      info: (
        <ChangeHistoryPopover
          section="connection"
          subject={connection.id}
          latest={connection.history}
        />
      ),
    },
  ];
  if (connection.usedAs === "chat") {
    cells.push({ id: "linked", label: "Linked accounts", value: connection.linkedAccounts ?? 0 });
  } else {
    cells.push({
      id: "repos",
      label: "Repos using it",
      value: connection.reposUsing ?? 0,
      detail:
        connection.usedAs === "code_host" ? (
          <AppLink href={manageReposHref(connection)}>Manage</AppLink>
        ) : undefined,
    });
  }
  cells.push({ id: "used-as", label: "Used as", value: USED_AS_LABELS[connection.usedAs] });
  return cells;
}

/** The page's toolbar (admins): Rotate token for GitLab, then ⋯ Edit connection and Disconnect…. */
function ConnectionToolbar({
  connection,
  onEdit,
  onDisconnect,
}: {
  connection: Connection;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  const rotate = useApiMutation<GitLabTokenResult, void>({
    mutationFn: () =>
      api.post(
        `/api/ui/connections/gitlab/${encodeURIComponent(connection.id)}/rotate`,
        gitLabTokenResultSchema,
      ),
    applyResult: (result, cache) =>
      setConnection(cache, connection.id, (row) => ({ ...row, health: result.health })),
    invalidate: (keys) => [connectionKeys(keys).list, keys.connections.all],
    success: "Token rotated",
  });
  const actions: ToolbarProps["actions"] =
    connection.provider === "gitlab"
      ? [
          {
            label: rotate.isPending ? "Rotating token…" : "Rotate token",
            icon: IconRefresh,
            disabled: rotate.isPending,
            onSelect: () => rotate.mutate(),
          },
        ]
      : [];
  const menu: MenuItem[] = [
    { label: "Edit connection", icon: IconPencil, onSelect: onEdit },
    "separator",
    { label: "Disconnect…", icon: IconPlugConnectedX, destructive: true, onSelect: onDisconnect },
  ];
  return <Toolbar label="Connection actions" actions={actions} menu={menu} />;
}

/** Edit connection for GitLab: replace the bot token on the same instance. */
function ReplaceTokenSheet({
  connection,
  open,
  onOpenChange,
}: {
  connection: Connection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  const replaced = (result: GitLabTokenResult) => {
    client.setQueryData<ConnectionList>(
      connectionKeys(keys).list,
      (previous) =>
        previous && {
          ...previous,
          connections: previous.connections.map((row) =>
            row.id === connection.id ? { ...row, health: result.health } : row,
          ),
        },
    );
    onOpenChange(false);
  };
  return (
    <Sheet
      title="Edit connection"
      description="Replaces the bot token with a new one of the same GitLab user."
      open={open}
      onOpenChange={onOpenChange}
    >
      {open ? (
        <ConnectGitLabForm
          organizationId={organization.id}
          defaultGitLabUrl={connection.instanceUrl ?? `https://${connection.host ?? ""}`}
          replaceConnectionId={connection.id}
          onReplaced={replaced}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </Sheet>
  );
}

function ConnectionView({
  connection,
  label,
  isAdmin,
  onDisconnect,
}: {
  connection: Connection;
  label: string;
  isAdmin: boolean;
  onDisconnect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const edit = () => {
    switch (connection.provider) {
      case "gitlab":
        setEditing(true);
        return;
      case "github":
        if (connection.installationUrl) openInNewTab(connection.installationUrl);
        return;
      default:
        navigateTo(CONNECT_ROUTES[connection.provider]);
    }
  };
  const recreated = (repositoryId: string, cache: MutationCache) =>
    setConnection(cache, connection.id, (row) => ({
      ...row,
      health: withoutWebhookProblems(row.health as ConnectionHealthSummary, repositoryId),
    }));
  const codeHost = connection.usedAs === "code_host";
  return (
    <SettingsPage
      title={label}
      mark={<BrandMark brand={connection.provider} size={18} />}
      badges={
        connection.host || connection.account ? (
          <>
            {connection.host ? <MetaBadge text={connection.host} mono /> : null}
            {connection.account ? <MetaBadge text={connection.account} /> : null}
          </>
        ) : undefined
      }
      actions={
        isAdmin ? (
          <ConnectionToolbar
            connection={connection}
            onEdit={edit}
            onDisconnect={() => setConfirming(true)}
          />
        ) : undefined
      }
    >
      <SummaryCells aria-label="Connection summary" cells={connectionSummaryCells(connection)} />
      {connection.health.state === "needs_attention" ? (
        <Card title="Problems" titleId="connection-problems">
          <ConnectionHealth
            health={connection.health}
            canRecreateWebhook={isAdmin}
            onWebhookRecreated={recreated}
          />
        </Card>
      ) : null}
      {connection.provider === "linear" ? (
        <WorkItemStatesCard
          integrationId={connection.id}
          isAdmin={isAdmin}
          history={connection.history}
        />
      ) : null}
      {connection.provider === "github" ||
      connection.provider === "gitlab" ||
      connection.provider === "linear" ? (
        <WebhookDeliveriesCard connection={connection} />
      ) : null}
      {isAdmin && connection.provider === "gitlab" ? (
        <ReplaceTokenSheet connection={connection} open={editing} onOpenChange={setEditing} />
      ) : null}
      {isAdmin ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={`Disconnect ${connection.name}?`}
          description={disconnectDescription(connection)}
          confirmLabel="Disconnect"
          destructive
          typedConfirmation={codeHost ? connection.name : undefined}
          onConfirm={onDisconnect}
        />
      ) : null}
    </SettingsPage>
  );
}

/**
 * A connection's page (Design board Settings): the provider's mark and name with badges for
 * the host and account, the admins' toolbar (Rotate token for GitLab; ⋯ Edit connection and
 * Disconnect…), the summary (Token, Repos using it or Linked accounts, Used as), the token's
 * problems, for Linear the work item states and, for code hosts and Linear, the webhook
 * deliveries with Replay (Slack and Discord deliveries aren't logged). One the organization doesn't have (removed,
 * or another organization's) says so; the list is live, so another admin's rotate, the daily
 * check or a disconnect elsewhere shows at once.
 */
export function ConnectionSettings({
  provider,
  connectionId,
}: {
  provider: ConnectionProvider;
  connectionId: string;
}) {
  const user = useCurrentUser();
  const router = useRouter();
  const list = useConnections();
  const [leaving, setLeaving] = useState(false);
  const connections = list.data?.connections;
  const connection = connections?.find(
    (entry) => entry.provider === provider && entry.id === connectionId,
  );
  const disconnect = useApiMutation<MutationResult, Connection>({
    mutationFn: (target, { organizationId }) =>
      api.delete(disconnectPath(target), mutationResultSchema, { organizationId }),
    // The entry leaves the section nav at once; a refusal puts it back.
    optimistic: (target, cache) =>
      cache.set<ConnectionList>(
        connectionKeys(cache.keys).list,
        (previous) =>
          previous && {
            ...previous,
            connections: previous.connections.filter((row) => row.id !== target.id),
          },
        { exact: true },
      ),
    onMutate: () => setLeaving(true),
    invalidate: (keys) => [connectionKeys(keys).list, keys.connections.all, keys.repositories.all],
    success: (_result, target) => `Disconnected ${target.name}`,
    onSuccess: () => router.push(SETTINGS_PATH),
    onError: () => setLeaving(false),
  });

  if (list.isError && !connections) {
    return (
      <EmptyState
        headingLevel={2}
        title="Couldn't load this connection"
        description={list.error.message}
        action={
          <Button variant="outline" onClick={() => void list.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!connections) return null;
  if (!connection) {
    // Its own disconnect: the page is on its way to Settings.
    if (leaving) return null;
    return <EmptyState headingLevel={2} title={CONNECTION_NOT_FOUND} />;
  }
  return (
    <ConnectionView
      connection={connection}
      label={CONNECTION_PROVIDER_LABELS[connection.provider]}
      isAdmin={hasRole(user, "admin")}
      onDisconnect={() => disconnect.mutate(connection)}
    />
  );
}
