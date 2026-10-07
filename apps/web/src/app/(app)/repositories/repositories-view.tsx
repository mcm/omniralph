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
  Empty,
  Field,
  InlineCode,
  Input,
  Muted,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@iamthemcmaster/ui";
import {
  IconBrandGithub,
  IconBrandGitlab,
  IconExternalLink,
  IconGitPullRequest,
  IconPlugConnected,
  IconHistory,
  IconListCheck,
  IconSettings,
  IconTrash,
  IconUnlink,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ListPagination } from "@/components/list-pagination";
import { useAction } from "@/components/use-action";
import { pageRange, totalPages } from "@/lib/pagination";
import {
  connectGitLab,
  disconnectRepository,
  removeScmConnection,
  setRepositoryEnabled,
} from "./actions";

export interface RepositoryRow {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
  webUrl: string;
  enabled: boolean;
  profileName: string;
  pinnedAgents: { id: string; name: string }[];
  /** ISO timestamp. */
  lastReviewAt: string | null;
}

export interface ConnectionRow {
  id: string;
  provider: "github" | "gitlab";
  name: string;
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
      style={{ color: "var(--text-secondary)", flexShrink: 0 }}
    />
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── Connect GitLab ───────────────────────────────────────────────────────────

function ConnectGitLabDialog({ defaultUrl }: { defaultUrl: string }) {
  const router = useRouter();
  const { pending, run } = useAction();
  const [open, setOpen] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState(defaultUrl);
  const [token, setToken] = React.useState("");
  const [projectPaths, setProjectPaths] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const pickProjects = !projectPaths.trim();
    let connectionId: string | undefined;
    run(
      async () => {
        const result = await connectGitLab({ baseUrl, token, projectPaths });
        connectionId = result.ok ? result.connectionId : undefined;
        return result;
      },
      pickProjects ? "GitLab connected. Pick its projects." : "GitLab projects connected",
      () => {
        setOpen(false);
        setToken("");
        setProjectPaths("");
        // Without paths, continue to the connection's project list.
        if (pickProjects && connectionId) router.push(`/repositories/gitlab/${connectionId}`);
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
            <DialogTitle>Connect GitLab projects</DialogTitle>
            <DialogDescription>
              Use a group or project access token for the bot identity with the{" "}
              <InlineCode>api</InlineCode> scope and the Maintainer role. Omniralph validates it,
              stores it encrypted and adds a webhook for merge request and comment events to each
              project. Leave the project paths empty to pick the projects from a list next.
            </DialogDescription>
          </DialogHeader>
          <DialogBody style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <Field
              label="GitLab URL"
              htmlFor="gitlab-url"
              hint="gitlab.com or your self-managed instance."
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
            <Field
              label="Project paths"
              htmlFor="gitlab-projects"
              hint="Optional. One per line, e.g. group/subgroup/project."
            >
              <Textarea
                id="gitlab-projects"
                rows={4}
                value={projectPaths}
                onChange={(e) => setProjectPaths(e.target.value)}
                placeholder={"group/project\ngroup/subgroup/other-project"}
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </Field>
          </DialogBody>
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

function RepositoryTableRow({ repo, isAdmin }: { repo: RepositoryRow; isAdmin: boolean }) {
  const { pending, run } = useAction();
  return (
    <TableRow>
      <TableCell>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <ProviderIcon provider={repo.provider} />
          <a
            href={repo.webUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              textDecoration: "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {repo.fullPath}
          </a>
        </div>
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
      <TableCell>
        <Badge variant="outline">{repo.profileName}</Badge>
      </TableCell>
      <TableCell>
        {repo.pinnedAgents.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
            {repo.pinnedAgents.map((agent) => (
              <Badge key={agent.id} variant="info">
                {agent.name}
              </Badge>
            ))}
          </div>
        ) : (
          <Muted>Any agent</Muted>
        )}
      </TableCell>
      <TableCell>
        {repo.lastReviewAt ? (
          <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
            {formatDateTime(repo.lastReviewAt)}
          </span>
        ) : (
          <Muted>Never</Muted>
        )}
      </TableCell>
      <TableCell style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label={`Reviews of ${repo.fullPath}`}
          title={`Reviews of ${repo.fullPath}`}
        >
          <Link href={`/repositories/${repo.id}/reviews`}>
            <IconHistory size={14} />
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label={`Rules of ${repo.fullPath}`}
          title={`Rules of ${repo.fullPath}`}
        >
          <Link href={`/repositories/${repo.id}/rules`}>
            <IconListCheck size={14} />
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label={`Settings for ${repo.fullPath}`}
          title={`Settings for ${repo.fullPath}`}
        >
          <Link href={`/repositories/${repo.id}/settings`}>
            <IconSettings size={14} />
          </Link>
        </Button>
        {isAdmin && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={pending}
                aria-label={`Disconnect ${repo.fullPath}`}
                title={`Disconnect ${repo.fullPath}`}
                style={{ color: "var(--error)" }}
              >
                <IconUnlink size={14} />
              </Button>
            </AlertDialogTrigger>
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
      </TableCell>
    </TableRow>
  );
}

// ── Connection row ───────────────────────────────────────────────────────────

function ConnectionItem({ connection }: { connection: ConnectionRow }) {
  const { pending, run } = useAction();
  const kind = connection.provider === "github" ? "GitHub installation" : "GitLab connection";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
        background: "var(--bg-raised)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <ProviderIcon provider={connection.provider} size={14} />
      <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
        {connection.name}
      </span>
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
            style={{ color: "var(--error)" }}
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
  );
}

function repositoriesHref(page: number): string {
  return page > 1 ? `/repositories?page=${page}` : "/repositories";
}

// ── Page ──────────────────────────────────────────────────────────────────────

const githubNotices: Record<
  GitHubNotice,
  { title: string; description: string; variant: "warning" | "destructive" }
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
    variant: "destructive",
    title: "Installation belongs to another organization",
    description:
      "This GitHub App installation is already connected to another Omniralph organization. An installation can only be connected to one organization: an admin there has to remove it under Code-host connections (or uninstall the app on GitHub) first.",
  },
  error: {
    variant: "destructive",
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
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>
              Repositories
            </h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              Pull and merge requests in enabled repositories are reviewed automatically when
              they&apos;re opened or pushed to.
            </Muted>
          </div>
          {isAdmin && (
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
            </div>
          )}
        </div>

        {isAdmin && githubNotice && (
          <Alert variant={githubNotices[githubNotice].variant}>
            <AlertTitle>{githubNotices[githubNotice].title}</AlertTitle>
            <AlertDescription>{githubNotices[githubNotice].description}</AlertDescription>
          </Alert>
        )}
        {isAdmin && !githubInstallUrl && (
          <Alert variant="info">
            <AlertTitle>GitHub App not configured</AlertTitle>
            <AlertDescription>
              Set <InlineCode>GITHUB_APP_ID</InlineCode>, a signing key (
              <InlineCode>GITHUB_APP_KMS_ISSUER_ID</InlineCode> or{" "}
              <InlineCode>GITHUB_APP_PRIVATE_KEY</InlineCode>) and optionally{" "}
              <InlineCode>GITHUB_APP_SLUG</InlineCode> to connect GitHub repositories. The
              app&apos;s Setup URL must be <InlineCode>/repositories/github/callback</InlineCode> on
              this control panel.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Connected repositories</CardTitle>
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Reviews</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Pinned agents</TableHead>
                    <TableHead>Last review</TableHead>
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
              <CardTitle>Code-host connections</CardTitle>
              <CardDescription>
                Choose which repositories of each GitHub installation and projects of each GitLab
                connection are reviewed. Removing a connection deletes its repositories and their
                history from this organization.
              </CardDescription>
            </CardHeader>
            <CardContent
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              {connections.map((connection) => (
                <ConnectionItem key={connection.id} connection={connection} />
              ))}
              {githubInstallUrl && connections.some((c) => c.provider === "github") && (
                <Muted style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                  <IconExternalLink size={12} />
                  Repositories missing? Add them to the installation on GitHub via Connect GitHub.
                </Muted>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </>
  );
}
