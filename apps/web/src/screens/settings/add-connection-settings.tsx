"use client";

import { BrandMark, Button, buttonClassName, Card, EmptyState, Sheet } from "@omniralph/ui";
import { IconCheck, IconPlugConnected } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ConnectGitHubButton } from "@/components/connect-github-button";
import { ConnectGitLabForm } from "@/components/connect-gitlab-form";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import {
  CONNECTION_PROVIDER_LABELS,
  CONNECTION_PROVIDERS,
  type Connection,
  type ConnectionList,
  type ConnectionProvider,
} from "@/lib/api/connections";
import { connectionKeys } from "@/lib/api/keys";
import type { ScmConnectionListRow } from "@/lib/api/repositories";
import { hasRole } from "@/lib/auth/roles";
import { useRepositorySetup } from "../repos/queries";
import { CONNECT_ROUTES } from "./connection-settings";
import { useConnections } from "./queries";
import { connectionHref } from "./settings-nav";
import { SettingsPage } from "./settings-page";

/** What a member sees instead of the providers. */
export const ADD_CONNECTION_MEMBER = "Ask an admin to add a connection.";

/** One sentence per provider on what connecting it does. */
export const PROVIDER_DESCRIPTIONS: Record<ConnectionProvider, string> = {
  github: "Reviews pull requests and builds in GitHub repos.",
  gitlab: "Reviews merge requests and builds in GitLab repos.",
  linear: "Picks up work items delegated to Omniralph.",
  slack: "Answers questions and starts work from Slack.",
  discord: "Answers questions and starts work from Discord.",
};

/** The GitHub card's button text. */
export const INSTALL_GITHUB_APP = "Install the GitHub App";

/** A link to an OAuth connect route: a full page load, since the route redirects away. */
function ConnectLink({ href }: { href: string }) {
  return (
    <a className={buttonClassName("outline", "md", "or-btn--with-icon")} href={href}>
      <IconPlugConnected className="or-btn__icon" size={16} stroke={1.75} aria-hidden="true" />
      Connect
    </a>
  );
}

function ProviderCard({ provider, action }: { provider: ConnectionProvider; action: ReactNode }) {
  return (
    <Card
      className="or-add-connection__card"
      title={
        <>
          <span className="or-add-connection__mark" aria-hidden="true">
            <BrandMark brand={provider} size={16} />
          </span>
          {CONNECTION_PROVIDER_LABELS[provider]}
        </>
      }
      actions={action}
    >
      <p className="or-add-connection__description">{PROVIDER_DESCRIPTIONS[provider]}</p>
    </Card>
  );
}

/**
 * The new GitLab connection's entry, until the list's refetch (its `connection` event)
 * brings the full row: the section nav lists it and its page opens at once.
 */
function provisionalGitLabConnection(row: ScmConnectionListRow): Connection {
  return {
    provider: "gitlab",
    id: row.id,
    name: row.name,
    host: row.host,
    account: null,
    health: row.health,
    reposUsing: 0,
    usedAs: "code_host",
    failedDeliveries: 0,
    linkedAccounts: null,
    instanceUrl: null,
    installationUrl: null,
    history: null,
  };
}

function AdminAddConnection() {
  const { organization } = useCurrentUser();
  const router = useRouter();
  const client = useQueryClient();
  const keys = useQueryKeys();
  const setup = useRepositorySetup(organization.id);
  const connections = useConnections().data?.connections;
  const [connectingGitLab, setConnectingGitLab] = useState(false);
  const linearConnected = connections?.some((entry) => entry.provider === "linear") ?? false;

  const gitLabConnected = (row: ScmConnectionListRow) => {
    const listKey = connectionKeys(keys).list;
    client.setQueryData<ConnectionList>(
      listKey,
      (previous) =>
        previous && {
          ...previous,
          connections: previous.connections.some((entry) => entry.id === row.id)
            ? previous.connections
            : [...previous.connections, provisionalGitLabConnection(row)],
        },
    );
    void client.invalidateQueries({ queryKey: listKey, exact: true });
    setConnectingGitLab(false);
    router.push(connectionHref({ provider: "gitlab", id: row.id }));
  };

  const actions: Record<ConnectionProvider, ReactNode> = {
    github: (
      <ConnectGitHubButton installPath={setup.data?.githubInstallPath} label={INSTALL_GITHUB_APP} />
    ),
    gitlab: (
      <Button
        icon={IconPlugConnected}
        disabled={setup.data === undefined}
        onClick={() => setConnectingGitLab(true)}
      >
        Connect
      </Button>
    ),
    linear: linearConnected ? (
      <Button icon={IconCheck} disabled>
        Connected
      </Button>
    ) : (
      <ConnectLink href={CONNECT_ROUTES.linear} />
    ),
    slack: <ConnectLink href={CONNECT_ROUTES.slack} />,
    discord: <ConnectLink href={CONNECT_ROUTES.discord} />,
  };

  return (
    <>
      {CONNECTION_PROVIDERS.map((provider) => (
        <ProviderCard key={provider} provider={provider} action={actions[provider]} />
      ))}
      <Sheet
        title="Connect GitLab"
        description="Connects gitlab.com or a self-managed instance with a bot's access token."
        open={connectingGitLab}
        onOpenChange={setConnectingGitLab}
      >
        {connectingGitLab && setup.data ? (
          <ConnectGitLabForm
            organizationId={organization.id}
            defaultGitLabUrl={setup.data.defaultGitLabUrl}
            onConnected={gitLabConnected}
            onCancel={() => setConnectingGitLab(false)}
          />
        ) : null}
      </Sheet>
    </>
  );
}

/**
 * Connections › Add connection (admins): one card per provider with its mark, what it does
 * and its action — install the GitHub App, connect GitLab with a bot token in a sheet (then
 * open the new connection), or go through Linear's, Slack's or Discord's consent screen,
 * whose callback lands on the new connection. Linear reads "Connected" once the organization
 * has it, live through the `connection` event. Members are asked to find an admin.
 */
export function AddConnectionSettings() {
  const user = useCurrentUser();
  return (
    <SettingsPage title="Add connection">
      {hasRole(user, "admin") ? (
        <AdminAddConnection />
      ) : (
        <EmptyState headingLevel={3} title={ADD_CONNECTION_MEMBER} />
      )}
    </SettingsPage>
  );
}
