"use client";

import * as React from "react";
import Link from "next/link";
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
  IconUnlink,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { useAction } from "@/components/use-action";
import { connectGitLab, disconnectRepository, setRepositoryEnabled } from "./actions";

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

export type GitHubNotice = "requested" | "invalid" | "error";

interface RepositoriesViewProps {
  repositories: RepositoryRow[];
  /** Admins only: stored GitHub App installations. */
  githubInstallations: { id: string; name: string }[];
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
  const { pending, run } = useAction();
  const [open, setOpen] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState(defaultUrl);
  const [token, setToken] = React.useState("");
  const [projectPaths, setProjectPaths] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () => connectGitLab({ baseUrl, token, projectPaths }),
      "GitLab projects connected",
      () => {
        setOpen(false);
        setToken("");
        setProjectPaths("");
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
              project.
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
              hint="One per line, e.g. group/subgroup/project."
              required
            >
              <Textarea
                id="gitlab-projects"
                required
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
            <Button
              type="submit"
              variant="primary"
              disabled={pending || !token.trim() || !projectPaths.trim()}
            >
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
  error: {
    variant: "destructive",
    title: "Couldn't look up the GitHub installation",
    description:
      "Omniralph couldn't authenticate as the GitHub App or reach GitHub. Check the GitHub App configuration (GITHUB_APP_ID and its signing key) and the server logs, then try connecting again.",
  },
};

export function RepositoriesView({
  repositories,
  githubInstallations,
  githubInstallUrl,
  defaultGitLabUrl,
  githubNotice,
}: RepositoriesViewProps) {
  const isAdmin = useCurrentUser().role === "admin";

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
            </CardDescription>
          </CardHeader>
          <CardContent>
            {repositories.length === 0 ? (
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
          </CardContent>
        </Card>

        {isAdmin && githubInstallations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>GitHub installations</CardTitle>
              <CardDescription>
                Choose which repositories of each installation are reviewed.
              </CardDescription>
            </CardHeader>
            <CardContent
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
            >
              {githubInstallations.map((installation) => (
                <div
                  key={installation.id}
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
                  <ProviderIcon provider="github" size={14} />
                  <span
                    style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--text-primary)" }}
                  >
                    {installation.name}
                  </span>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/repositories/github/${installation.id}`}>
                      <IconSettings size={14} />
                      Choose repositories
                    </Link>
                  </Button>
                </div>
              ))}
              {githubInstallUrl && (
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
