"use client";

import {
  BrandMark,
  Button,
  Checkbox,
  Field,
  MetaBadge,
  RepoBadge,
  Select,
  Sheet,
  TextInput,
} from "@omniralph/ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconLock,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";
import { ConnectGitHubButton } from "@/components/connect-github-button";
import { ConnectGitLabForm } from "@/components/connect-gitlab-form";
import { ConnectionHealth } from "@/components/connection-health";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api, ApiError } from "@/lib/api/client";
import {
  addedRepositoriesSchema,
  LISTING_FAILED,
  type ScmConnectionList,
  type ScmConnectionListRow,
} from "@/lib/api/repositories";
import { withoutWebhookProblems } from "@/lib/connections/health";
import { useScopeParam } from "../scope";
import { addListRows, dropWebhookProblem } from "./mutations";
import {
  addRepoKeys,
  useRepositorySetup,
  useScmConnections,
  useScmConnectionsOf,
  useSelectableRepositories,
} from "./queries";
import "./add-repo-sheet.css";

type Provider = "github" | "gitlab";

const HOST: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

/** Why connecting GitHub didn't finish: the callback's `/repos?github=<status>`. */
export type GitHubNotice =
  | "requested"
  | "invalid"
  | "invalid_state"
  | "other_organization"
  | "error";

export const GITHUB_NOTICES: Record<GitHubNotice, { title: string; description: string }> = {
  requested: {
    title: "Installation requested",
    description:
      "An organization owner has to approve the GitHub App installation. Once they do, open it again from GitHub or click Connect GitHub.",
  },
  invalid: {
    title: "Unknown GitHub installation",
    description: "GitHub didn't return an installation of this app. Try connecting again.",
  },
  invalid_state: {
    title: "GitHub installation not connected",
    description:
      "The installation didn't come back from a Connect GitHub started in this organization, or the link expired. Click Connect GitHub to try again.",
  },
  other_organization: {
    title: "Installation belongs to another organization",
    description:
      "This GitHub App installation is already connected to another Omniralph organization. An installation can only be connected to one organization: an admin there has to remove its connection (or uninstall the app on GitHub) first.",
  },
  error: {
    title: "Couldn't look up the GitHub installation",
    description:
      "Omniralph couldn't authenticate as the GitHub App or reach GitHub. Check the GitHub App configuration (GITHUB_APP_ID and its signing key) and the server logs, then try connecting again.",
  },
};

export function isGitHubNotice(value: string | null): value is GitHubNotice {
  return value !== null && Object.hasOwn(GITHUB_NOTICES, value);
}

/** Where the sheet opens: a connection's picker, or a GitHub notice above the connections. */
export interface AddRepoStart {
  connection?: { id: string; provider: Provider };
  githubNotice?: GitHubNotice;
}

type PickedConnection = Pick<ScmConnectionListRow, "id" | "provider"> &
  Partial<Pick<ScmConnectionListRow, "name">>;

/** The organizations the user may add repos to: their admin organizations under "All organizations". */
function useAdminOrganizations() {
  const user = useCurrentUser();
  if (user.scope !== "all") return [{ id: user.organization.id, name: user.organization.name }];
  return user.organizations
    .filter((organization) => organization.role === "admin")
    .map(({ id, name }) => ({ id, name }));
}

/** "Added 1 repo", "Add 3 repos". */
function repoCount(count: number): string {
  return `${count} ${count === 1 ? "repo" : "repos"}`;
}

// ── Picker ───────────────────────────────────────────────────────────────────

function ListingError({
  error,
  provider,
  retrying,
  onRetry,
}: {
  error: Error;
  provider: Provider;
  retrying: boolean;
  onRetry: () => void;
}) {
  const fromHost = error instanceof ApiError && error.code === LISTING_FAILED;
  return (
    <div role="alert" className="or-add-repos__alert or-add-repos__alert--fail">
      <p className="or-add-repos__alert-title">
        {fromHost ? `${HOST[provider]} couldn't list the repos` : "Couldn't load the repos"}
      </p>
      <p className="or-add-repos__alert-text or-mono">{error.message}</p>
      <Button variant="outline" size="sm" icon={IconRefresh} disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

function RepoPicker({
  organizationId,
  connection,
  onBack,
  onAdded,
}: {
  organizationId: string;
  connection: PickedConnection;
  onBack: () => void;
  onAdded: (repositoryId: string) => void;
}) {
  const scope = useScopeParam();
  const listing = useSelectableRepositories(connection, organizationId);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const repos = listing.data?.repos ?? [];
  const connected = new Set(repos.filter((repo) => repo.connected).map((repo) => repo.id));
  const toAdd = [...selected].filter((id) => !connected.has(id)).sort((a, b) => a - b);
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? repos.filter((repo) => repo.fullPath.toLowerCase().includes(needle))
    : repos;

  const add = useApiMutation<z.infer<typeof addedRepositoriesSchema>, number[]>({
    // No organization header: the organization may not be the active one.
    mutationFn: (ids) =>
      api.post(
        `/api/ui/scm-connections/${encodeURIComponent(connection.id)}/repositories`,
        addedRepositoriesSchema,
        { body: { provider: connection.provider, ids, organizationId } },
      ),
    applyResult: (result, cache) => addListRows(cache, scope, result.repositories),
    // The added repos' change events reconcile the rail.
    invalidate: () => [],
    success: (result) => `Added ${repoCount(result.added.length)}`,
    onSuccess: (result) => {
      const [first] = result.added;
      if (first) onAdded(first.id);
    },
  });
  const pending = add.isPending;
  const refreshing = listing.isFetching;
  const host = HOST[connection.provider];

  const toggle = (id: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="or-add-repos__picker">
      <div className="or-add-repos__picker-head">
        <Button variant="ghost" size="sm" icon={IconChevronLeft} onClick={onBack}>
          Connections
        </Button>
        <h3 className="or-add-repos__picker-title">
          <BrandMark brand={connection.provider} />
          <span>{listing.data?.account ?? connection.name ?? host}</span>
        </h3>
      </div>

      {listing.error && !listing.data ? (
        <ListingError
          error={listing.error}
          provider={connection.provider}
          retrying={refreshing}
          onRetry={() => void listing.refetch()}
        />
      ) : listing.data === undefined ? (
        <p className="or-add-repos__muted" aria-busy="true">
          Loading repos from {host}…
        </p>
      ) : (
        <>
          <Field label="Filter repos" stacked>
            <TextInput
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter repos"
              autoComplete="off"
            />
          </Field>
          {repos.length === 0 ? (
            <p className="or-add-repos__muted">
              {connection.provider === "github"
                ? "The installation can't access any repos."
                : "The bot token's user isn't a Maintainer of any project."}
            </p>
          ) : shown.length === 0 ? (
            <p className="or-add-repos__muted">No repos match the filter.</p>
          ) : (
            <ul className="or-add-repos__repos" aria-label="Repos" aria-busy={refreshing}>
              {shown.map((repo) => (
                <li key={repo.id} className="or-add-repos__repo">
                  <Checkbox
                    checked={repo.connected || selected.has(repo.id)}
                    disabled={repo.connected || pending}
                    onCheckedChange={(checked) => toggle(repo.id, checked)}
                    label={
                      <span className="or-add-repos__repo-badges">
                        <RepoBadge host={connection.provider} name={repo.fullPath} />
                        {repo.private ? <MetaBadge icon={IconLock} text="Private" /> : null}
                        {repo.connected ? <MetaBadge text="Added" /> : null}
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {listing.data.truncated ? (
            <p className="or-add-repos__muted">Showing the first {repoCount(repos.length)}.</p>
          ) : null}
          {listing.data.manageUrl ? (
            <a
              className="or-link or-add-repos__external"
              href={listing.data.manageUrl}
              target="_blank"
              rel="noreferrer"
            >
              Manage access on GitHub
              <IconExternalLink size={14} stroke={1.75} aria-hidden="true" />
            </a>
          ) : null}
        </>
      )}

      <div className="or-add-repos__actions">
        <Button
          variant="outline"
          icon={IconRefresh}
          disabled={refreshing || pending}
          onClick={() => void listing.refetch()}
        >
          {refreshing && listing.data ? "Refreshing…" : "Refresh"}
        </Button>
        <Button
          variant="solid"
          icon={IconPlus}
          disabled={toAdd.length === 0 || pending || listing.data === undefined}
          onClick={() => add.mutate(toAdd)}
        >
          {pending ? "Adding…" : `Add ${repoCount(toAdd.length)}`}
        </Button>
      </div>
    </div>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

function Connections({
  organizationId,
  onPick,
}: {
  organizationId: string;
  onPick: (connection: ScmConnectionListRow) => void;
}) {
  const client = useQueryClient();
  const keys = useQueryKeys();
  const connections = useScmConnections(organizationId);
  const setup = useRepositorySetup(organizationId);
  const [connectingGitLab, setConnectingGitLab] = useState(false);
  const listKey = addRepoKeys(keys).connections(organizationId);

  const recreated = async (repositoryId: string, cache: MutationCache) => {
    await cache.set<ScmConnectionList>(
      listKey,
      (previous) =>
        previous && {
          connections: previous.connections.map((connection) => ({
            ...connection,
            health: withoutWebhookProblems(connection.health, repositoryId),
          })),
        },
      { exact: true },
    );
    await dropWebhookProblem(cache, repositoryId);
  };

  const connected = (connection: ScmConnectionListRow) => {
    client.setQueryData<ScmConnectionList>(listKey, (previous) =>
      previous
        ? {
            connections: [
              ...previous.connections.filter((entry) => entry.id !== connection.id),
              connection,
            ].sort((a, b) => a.name.localeCompare(b.name)),
          }
        : previous,
    );
    setConnectingGitLab(false);
    onPick(connection);
  };

  const list = connections.data?.connections;
  return (
    <div className="or-add-repos__connections">
      {connections.error && !list ? (
        <div role="alert" className="or-add-repos__alert or-add-repos__alert--fail">
          <p className="or-add-repos__alert-title">Couldn&apos;t load the connections</p>
          <p className="or-add-repos__alert-text">{connections.error.message}</p>
          <Button
            variant="outline"
            size="sm"
            icon={IconRefresh}
            disabled={connections.isFetching}
            onClick={() => void connections.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : list === undefined ? (
        <p className="or-add-repos__muted" aria-busy="true">
          Loading connections…
        </p>
      ) : list.length === 0 ? (
        <p className="or-add-repos__muted">No GitHub or GitLab connections yet.</p>
      ) : (
        <ul className="or-add-repos__connection-list" aria-label="Connections">
          {list.map((connection) => (
            <li key={connection.id} className="or-add-repos__connection">
              <button
                type="button"
                className="or-add-repos__connection-pick"
                aria-label={`${HOST[connection.provider]} ${connection.name}`}
                onClick={() => onPick(connection)}
              >
                <BrandMark brand={connection.provider} />
                <span className="or-add-repos__connection-name">{connection.name}</span>
                <span className="or-add-repos__connection-host" aria-hidden="true">
                  {connection.host}
                </span>
                <IconChevronRight size={16} stroke={1.75} aria-hidden="true" />
              </button>
              <ConnectionHealth
                health={connection.health}
                canRecreateWebhook
                onWebhookRecreated={recreated}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="or-add-repos__connect">
        <ConnectGitHubButton installPath={setup.data?.githubInstallPath} />
        <Button
          variant="outline"
          aria-expanded={connectingGitLab}
          disabled={setup.data === undefined}
          onClick={() => setConnectingGitLab((open) => !open)}
        >
          <span className="or-btn__icon" aria-hidden="true">
            <BrandMark brand="gitlab" />
          </span>
          Connect GitLab
        </Button>
      </div>
      {connectingGitLab && setup.data ? (
        <ConnectGitLabForm
          organizationId={organizationId}
          defaultGitLabUrl={setup.data.defaultGitLabUrl}
          onConnected={connected}
          onCancel={() => setConnectingGitLab(false)}
        />
      ) : null}
    </div>
  );
}

// ── Sheet ────────────────────────────────────────────────────────────────────

function AddRepoFlow({
  start,
  onAdded,
}: {
  start: AddRepoStart | null;
  onAdded: (repositoryId: string) => void;
}) {
  const user = useCurrentUser();
  const organizations = useAdminOrganizations();
  const choosing = user.scope === "all";
  const [organizationId, setOrganizationId] = useState(
    () =>
      organizations.find((organization) => organization.id === user.organization.id)?.id ??
      organizations[0]?.id ??
      user.organization.id,
  );
  const [picked, setPicked] = useState<PickedConnection | null>(start?.connection ?? null);

  // Opened on a connection under "All organizations": find which organization has it.
  const [locating, setLocating] = useState(choosing && start?.connection !== undefined);
  const lists = useScmConnectionsOf(
    organizations.map((organization) => organization.id),
    locating,
  );
  if (locating && start?.connection) {
    const index = lists.findIndex((list) =>
      list.data?.connections.some((connection) => connection.id === start.connection!.id),
    );
    if (index >= 0) {
      setLocating(false);
      setOrganizationId(organizations[index]!.id);
    } else if (lists.every((list) => list.data || list.error)) {
      setLocating(false);
    }
  }

  const connections = useScmConnections(organizationId, !locating);
  const pickedRow = picked
    ? connections.data?.connections.find((connection) => connection.id === picked.id)
    : undefined;
  const notice = start?.githubNotice ? GITHUB_NOTICES[start.githubNotice] : null;

  return (
    <div className="or-add-repos">
      {notice ? (
        <div role="alert" className="or-add-repos__alert">
          <p className="or-add-repos__alert-title">{notice.title}</p>
          <p className="or-add-repos__alert-text">{notice.description}</p>
        </div>
      ) : null}
      {choosing ? (
        <Field label="Organization" stacked>
          <Select
            value={organizationId}
            disabled={locating}
            onChange={(event) => {
              setOrganizationId(event.target.value);
              setPicked(null);
            }}
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {locating ? (
        <p className="or-add-repos__muted" aria-busy="true">
          Loading connections…
        </p>
      ) : picked ? (
        <RepoPicker
          key={`${organizationId}:${picked.id}`}
          organizationId={organizationId}
          connection={{ ...picked, name: pickedRow?.name ?? picked.name }}
          onBack={() => setPicked(null)}
          onAdded={onAdded}
        />
      ) : (
        <Connections organizationId={organizationId} onPick={setPicked} />
      )}
    </div>
  );
}

export interface AddRepoSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where it opens (`/repos?add=…&connection=…` or `/repos?github=…`); the connections otherwise. */
  start?: AddRepoStart | null;
  /** After repos were added: the first one, to open. */
  onAdded: (repositoryId: string) => void;
}

/**
 * "Add repos" (admins): the organization's GitHub and GitLab connections with their health,
 * Connect GitHub and Connect GitLab, and a connection's picker, which adds the chosen repos
 * (add-only). Under "All organizations" it starts with the organization to add to.
 */
export function AddRepoSheet({ open, onOpenChange, start = null, onAdded }: AddRepoSheetProps) {
  return (
    <Sheet title="Add repos" open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open: every opening starts over. */}
      <AddRepoFlow start={start} onAdded={onAdded} />
    </Sheet>
  );
}
