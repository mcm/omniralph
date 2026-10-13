"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  Field,
  InlineCode,
  Input,
  Muted,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import {
  IconBrandGithub,
  IconBrandGitlab,
  IconDotsVertical,
  IconExternalLink,
  IconGavel,
  IconGitPullRequest,
  IconPlugConnected,
  IconHistory,
  IconSettings,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { EnvDocsLink } from "@/components/env-docs-link";
import { ExternalRowLink, PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { ListPagination } from "@/components/list-pagination";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import { pageRange, totalPages } from "@/lib/pagination";
import {
  connectGitLab,
  disconnectRepository,
  removeScmConnection,
  setRepositoryEnabled,
} from "./actions";
import { ConnectionHealth, type ConnectionHealthRow } from "./connection-health";

export interface RepositoryRow {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
  webUrl: string;
  enabled: boolean;
  profileName: string;
  pinnedHarnesses: { id: string; name: string }[];
  /** ISO timestamp. */
  lastReviewAt: string | null;
}

export interface ConnectionRow {
  id: string;
  provider: "github" | "gitlab";
  name: string;
  /** GitLab: the last daily check, or null before the first one. */
  health: ConnectionHealthRow | null;
}

export type GitHubNotice =
  "requested" | "invalid" | "invalid_state" | "other_organization" | "error";

interface RepositoriesViewProps {
  /** The current page of connected repositories. */
  repositories: RepositoryRow[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Connected repositories across all pages. */
  total: number;
  /** Admins only: the organization's GitHub App installations and GitLab connections. */
  connections: ConnectionRow[];
  /** Admins only: the app's installation page, or null when the app isn't configured. */
  githubInstallUrl: string | null;
  defaultGitLabUrl: string;
  githubNotice: GitHubNotice | null;
}

export function ProviderIcon({
  provider,
  size = 16,
}: {
  provider: "github" | "gitlab";
  size?: number;
}) {
  const Icon = provider === "github" ? IconBrandGithub : IconBrandGitlab;
  return (
    <Icon
      size={size}
      aria-label={provider === "github" ? "GitHub" : "GitLab"}
      className="shrink-0 text-text-secondary"
    />
  );
}

// ── Connect GitLab ───────────────────────────────────────────────────────────

function ConnectGitLabDialog({ defaultUrl }: { defaultUrl: string }) {
  const router = useRouter();
  const { pending, run } = useAction();
  const [open, setOpen] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState(defaultUrl);
  const [token, setToken] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    let connectionId: string | undefined;
    run(
      async () => {
        const result = await connectGitLab({ baseUrl, token });
        connectionId = result.ok ? result.connectionId : undefined;
        return result;
      },
      "GitLab connected. Pick its projects.",
      () => {
        setOpen(false);
        setToken("");
        if (connectionId) router.push(`/repositories/gitlab/${connectionId}`);
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">
          <IconBrandGitlab size={14} />
          Connect GitLab
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connect GitLab</DialogTitle>
            <DialogDescription>
              Use a service account&apos;s personal access token for the bot identity with the{" "}
              <InlineCode>api</InlineCode> scope and the Maintainer role. Omniralph validates it and
              stores it encrypted; you then pick the projects to review, and each gets a webhook for
              merge request and comment events.
            </DialogDescription>
          </DialogHeader>
          <Stack asChild gap={4}>
            <DialogBody>
              <Field
                label="GitLab URL"
                htmlFor="gitlab-url"
                description="gitlab.com or your self-managed instance."
                required
              >
                <Input
                  id="gitlab-url"
                  type="url"
                  required
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://gitlab.com"
                />
              </Field>
              <Field label="Access token" htmlFor="gitlab-token" required>
                <Input
                  id="gitlab-token"
                  type="password"
                  required
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="glpat-…"
                />
              </Field>
            </DialogBody>
          </Stack>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending || !token.trim()}>
              <IconPlugConnected size={14} />
              {pending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Repository row ───────────────────────────────────────────────────────────

function RepositoryActions({ repo, isAdmin }: { repo: RepositoryRow; isAdmin: boolean }) {
  const { pending, run } = useAction();
  const host = repo.provider === "github" ? "GitHub" : "GitLab";
  const [confirming, setConfirming] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={pending}
            aria-label={`Actions for ${repo.fullPath}`}
            title="Actions"
          >
            <IconDotsVertical size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/repositories/${repo.id}/reviews`}>
              <IconHistory size={14} />
              Reviews
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/repositories/${repo.id}/rules`}>
              <IconGavel size={14} />
              Rules
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/repositories/${repo.id}/settings`}>
              <IconSettings size={14} />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={repo.webUrl} target="_blank" rel="noreferrer">
              <IconExternalLink size={14} />
              Open on {host}
            </a>
          </DropdownMenuItem>
          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="danger" onSelect={() => setConfirming(true)}>
                <IconUnlink size={14} />
                Disconnect…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && (
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {repo.fullPath}?</AlertDialogTitle>
              <AlertDialogDescription>
                Reviews stop and its agent pins are removed
                {repo.provider === "gitlab" ? ", and its GitLab webhook is deleted" : ""}. Its
                review history is kept, and you can connect it again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="danger"
                onClick={() =>
                  run(() => disconnectRepository(repo.id), `Disconnected ${repo.fullPath}`)
                }
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

function RepositoryTableRow({ repo, isAdmin }: { repo: RepositoryRow; isAdmin: boolean }) {
  const { pending, run } = useAction();
  const host = repo.provider === "github" ? "GitHub" : "GitLab";
  return (
    <TableRow>
      <TableCell className="list-col-main">
        <Link href={`/repositories/${repo.id}/reviews`} className="list-title">
          <ProviderIcon provider={repo.provider} size={14} />
          <span className="list-title-text list-title-fill text-numeric">{repo.fullPath}</span>
        </Link>
        <PhoneMeta>
          {repo.lastReviewAt ? (
            <Timestamp iso={repo.lastReviewAt} />
          ) : (
            <span className="list-time">Never reviewed</span>
          )}
        </PhoneMeta>
      </TableCell>
      <TableCell>
        {isAdmin ? (
          <Switch
            checked={repo.enabled}
            disabled={pending}
            aria-label={`Reviews for ${repo.fullPath}`}
            onCheckedChange={(enabled) =>
              run(
                () => setRepositoryEnabled(repo.id, enabled),
                `Reviews ${enabled ? "enabled" : "disabled"} for ${repo.fullPath}`,
              )
            }
          />
        ) : (
          <Badge variant={repo.enabled ? "success" : "neutral"} dot>
            {repo.enabled ? "Enabled" : "Disabled"}
          </Badge>
        )}
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <Badge variant="neutral">{repo.profileName}</Badge>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        {repo.pinnedHarnesses.length > 0 ? (
          <div className="list-filters">
            {repo.pinnedHarnesses.map((agent) => (
              <Badge key={agent.id} variant="info">
                {agent.name}
              </Badge>
            ))}
          </div>
        ) : (
          <Muted>Any agent</Muted>
        )}
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        {repo.lastReviewAt ? <Timestamp iso={repo.lastReviewAt} /> : <Muted>Never</Muted>}
      </TableCell>
      <TableCell className="list-actions">
        <div className="list-actions-group">
          <ExternalRowLink
            href={repo.webUrl}
            label={`Open ${repo.fullPath} on ${host}`}
            className="list-label-wide"
          />
          <RepositoryActions repo={repo} isAdmin={isAdmin} />
        </div>
      </TableCell>
    </TableRow>
  );
}

// ── Connection row ───────────────────────────────────────────────────────────

function ConnectionItem({ connection, isAdmin }: { connection: ConnectionRow; isAdmin: boolean }) {
  const { pending, run } = useAction();
  const kind = connection.provider === "github" ? "GitHub installation" : "GitLab connection";
  return (
    <Stack gap={2} className="repo-panel">
      <div className="repo-row">
        <ProviderIcon provider={connection.provider} size={14} />
        <span className="flex-1 text-sm text-text-primary">{connection.name}</span>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/repositories/${connection.provider}/${connection.id}`}>
            <IconSettings size={14} />
            {connection.provider === "github" ? "Choose repositories" : "Choose projects"}
          </Link>
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={pending}
              aria-label={`Remove ${connection.name}`}
              title={`Remove ${connection.name}`}
              className="list-text-danger"
            >
              <IconTrash size={14} />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {connection.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The {kind} and all of its repositories are removed from this organization, together
                with their reviews, rules, agent pins and ralph runs
                {connection.provider === "gitlab"
                  ? ". The project webhooks are deleted from GitLab"
                  : ". The app stays installed on GitHub until you uninstall it there"}
                . It can then be connected again, from this or another organization.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="danger"
                onClick={() =>
                  run(() => removeScmConnection(connection.id), `Removed ${connection.name}`)
                }
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {connection.provider === "gitlab" && (
        <ConnectionHealth health={connection.health} isAdmin={isAdmin} />
      )}
    </Stack>
  );
}

function repositoriesHref(page: number): string {
  return page > 1 ? `/repositories?page=${page}` : "/repositories";
}

// ── Page ──────────────────────────────────────────────────────────────────────

const githubNotices: Record<
  GitHubNotice,
  { title: string; description: string; variant: "warning" | "danger" }
> = {
  requested: {
    variant: "warning",
    title: "Installation requested",
    description:
      "An organization owner has to approve the GitHub App installation. Once they do, open it again from GitHub or click Connect GitHub.",
  },
  invalid: {
    variant: "warning",
    title: "Unknown GitHub installation",
    description: "GitHub didn't return an installation of this app. Try connecting again.",
  },
  invalid_state: {
    variant: "warning",
    title: "GitHub installation not connected",
    description:
      "The installation didn't come back from a Connect GitHub started in this organization, or the link expired. Click Connect GitHub to try again.",
  },
  other_organization: {
    variant: "danger",
    title: "Installation belongs to another organization",
    description:
      "This GitHub App installation is already connected to another Omniralph organization. An installation can only be connected to one organization: an admin there has to remove it under Code-host connections (or uninstall the app on GitHub) first.",
  },
  error: {
    variant: "danger",
    title: "Couldn't look up the GitHub installation",
    description:
      "Omniralph couldn't authenticate as the GitHub App or reach GitHub. Check the GitHub App configuration (GITHUB_APP_ID and its signing key) and the server logs, then try connecting again.",
  },
};

export function RepositoriesView({
  repositories,
  page,
  pageSize,
  total,
  connections,
  githubInstallUrl,
  defaultGitLabUrl,
  githubNotice,
}: RepositoriesViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const pageCount = totalPages(total, pageSize);
  const { first, last } = pageRange(page, pageSize, repositories.length);

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Repositories" }]} />
      <main className="detail-main">
        <PageHeader
          title="Repositories"
          description="Pull and merge requests in enabled repositories are reviewed automatically when they're opened or pushed to."
          actions={
            isAdmin && (
              <>
                {githubInstallUrl ? (
                  <Button asChild variant="secondary">
                    <a href={githubInstallUrl}>
                      <IconBrandGithub size={14} />
                      Connect GitHub
                    </a>
                  </Button>
                ) : (
                  <Button variant="secondary" disabled title="The GitHub App isn't configured">
                    <IconBrandGithub size={14} />
                    Connect GitHub
                  </Button>
                )}
                <ConnectGitLabDialog defaultUrl={defaultGitLabUrl} />
              </>
            )
          }
        />

        {isAdmin && githubNotice && (
          <Alert variant={githubNotices[githubNotice].variant}>
            <AlertTitle as="h2">{githubNotices[githubNotice].title}</AlertTitle>
            <AlertDescription>{githubNotices[githubNotice].description}</AlertDescription>
          </Alert>
        )}
        {isAdmin && !githubInstallUrl && (
          <Alert variant="info">
            <AlertTitle as="h2">GitHub App not configured</AlertTitle>
            <AlertDescription>
              To connect GitHub repositories, set these on the server (see <EnvDocsLink />
              ):
              <ul className="env-var-list">
                <li>
                  <InlineCode>GITHUB_APP_ID</InlineCode>
                </li>
                <li>
                  a signing key: <InlineCode>GITHUB_APP_KMS_ISSUER_ID</InlineCode> or{" "}
                  <InlineCode>GITHUB_APP_PRIVATE_KEY</InlineCode>
                </li>
                <li>
                  <InlineCode>GITHUB_APP_SLUG</InlineCode> (optional)
                </li>
              </ul>
              The app&apos;s Setup URL must be{" "}
              <InlineCode>/repositories/github/callback</InlineCode> on this control panel.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle as="h2">Connected repositories</CardTitle>
            <CardDescription>
              {isAdmin
                ? "Turn reviews on or off per repository. Disconnecting keeps a repository's review history."
                : "Repositories connected by an admin. Only admins can change them."}
              {repositories.length > 0 &&
                total > pageSize &&
                ` Showing ${first}–${last} of ${total.toLocaleString()}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {repositories.length === 0 && total > 0 ? (
              <Empty
                icon={<IconGitPullRequest size={24} />}
                title="No repositories on this page"
                description="The page is past the last one."
              />
            ) : repositories.length === 0 ? (
              <Empty
                icon={<IconGitPullRequest size={24} />}
                title="No repositories yet"
                description={
                  isAdmin
                    ? "Connect GitHub or GitLab to start reviewing pull and merge requests."
                    : "An admin hasn't connected any repositories yet."
                }
              />
            ) : (
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Reviews</TableHead>
                    <TableHead className={WIDE_COLUMN}>Profile</TableHead>
                    <TableHead className={WIDE_COLUMN}>Pinned harnesses</TableHead>
                    <TableHead className={WIDE_COLUMN}>Last review</TableHead>
                    <TableHead aria-label="Actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {repositories.map((repo) => (
                    <RepositoryTableRow key={repo.id} repo={repo} isAdmin={isAdmin} />
                  ))}
                </TableBody>
              </Table>
            )}
            <ListPagination page={page} pageCount={pageCount} hrefFor={repositoriesHref} />
          </CardContent>
        </Card>

        {isAdmin && connections.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">Code-host connections</CardTitle>
              <CardDescription>
                Choose which repositories of each GitHub installation and projects of each GitLab
                connection are reviewed. Removing a connection deletes its repositories and their
                history from this organization.
              </CardDescription>
            </CardHeader>
            <Stack asChild gap={2}>
              <CardContent>
                {connections.map((connection) => (
                  <ConnectionItem key={connection.id} connection={connection} isAdmin={isAdmin} />
                ))}
                {githubInstallUrl && connections.some((c) => c.provider === "github") && (
                  <Muted className="flex items-center gap-1">
                    <IconExternalLink size={12} />
                    Repositories missing? Add them to the installation on GitHub via Connect GitHub.
                  </Muted>
                )}
              </CardContent>
            </Stack>
          </Card>
        )}
      </main>
    </>
  );
}
