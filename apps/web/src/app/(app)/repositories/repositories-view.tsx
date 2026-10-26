"use client";

import * as React from "react";
import { REVIEW_DEPTHS } from "@omniralph/shared";
import { Link } from "@/components/link";
import { useRouter, useSearchParams } from "next/navigation";
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
  Skeleton,
  Stack,
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
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { EnvDocsLink } from "@/components/env-docs-link";
import { Freshness } from "@/components/freshness";
import { ExternalRowLink, PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { ListPagination } from "@/components/list-pagination";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { ProviderIcon } from "@/components/provider-icon";
import { QueryBoundary } from "@/components/query-boundary";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  connectedGitLabSchema,
  repositoryListSchema,
  repositorySetupSchema,
  type ConnectionRow,
  type RepositoryList,
  type RepositoryRow,
} from "@/lib/api/repositories";
import { mutationResultSchema } from "@/lib/api/schemas";
import { pageRange, parsePage, totalPages } from "@/lib/pagination";
import { ConnectionHealth } from "./connection-health";

export type { ConnectionRow, RepositoryRow };

export type GitHubNotice =
  "requested" | "invalid" | "invalid_state" | "other_organization" | "error";

/** A page of the organization's repositories (and, for admins, its connections), live. */
export function useRepositoryList(page: number) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.repositories.list({ page }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/repositories", repositoryListSchema, {
        params: { page: page > 1 ? page : undefined },
        organizationId: organization.id,
        signal,
      }),
    // The previous page stays (dimmed) while the next one loads.
    placeholderData: keepPreviousData,
  });
}

/** What the Connect buttons need (admins). It may ask GitHub for the app's slug: loaded once. */
function useRepositorySetup(enabled: boolean) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: [...keys.connections.all, "setup"],
    queryFn: ({ signal }) =>
      api.get("/api/ui/repositories/setup", repositorySetupSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
}

// ── Connect GitLab ───────────────────────────────────────────────────────────

function ConnectGitLabDialog({ defaultUrl }: { defaultUrl: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState(defaultUrl);
  const [token, setToken] = React.useState("");
  const connect = useApiMutation({
    mutationFn: (form: { baseUrl: string; token: string }, { organizationId }) =>
      api.post("/api/ui/gitlab-connections", connectedGitLabSchema, {
        body: form,
        organizationId,
      }),
    invalidate: (keys) => [keys.repositories.lists, keys.connections.all],
    success: "GitLab connected. Pick its projects.",
    onSuccess: ({ connectionId }) => {
      setOpen(false);
      setToken("");
      router.push(`/repositories/gitlab/${connectionId}`);
    },
  });
  const pending = connect.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    connect.mutate({ baseUrl, token });
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
                  placeholder="e.g. https://gitlab.com"
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
  const disconnect = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(`/api/ui/repositories/${repo.id}`, mutationResultSchema, { organizationId }),
    // Its pins go too: the harness pages list them.
    invalidate: (keys) => [keys.repositories.all, keys.agents.all],
    success: `Disconnected ${repo.fullPath}`,
  });
  const pending = disconnect.isPending;
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
              <AlertDialogAction variant="danger" onClick={() => disconnect.mutate()}>
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

const TASK_TYPE_BADGES = [
  { key: "reviews", label: "Reviews" },
  { key: "coding", label: "Coding" },
  { key: "ask", label: "Ask" },
] as const;

/** A repository's switches: on in green, off in grey. */
export function TaskTypeBadges({ taskTypes }: { taskTypes: RepositoryRow["taskTypes"] }) {
  return (
    <div className="list-filters">
      {TASK_TYPE_BADGES.map(({ key, label }) => {
        const on = taskTypes[key];
        const state = on ? "On" : "Off";
        return (
          <Badge
            key={key}
            variant={on ? "success" : "neutral"}
            dot
            title={`${label}: ${state}`}
            aria-label={`${label}: ${state}`}
          >
            {label}
          </Badge>
        );
      })}
    </div>
  );
}

function RepositoryTableRow({ repo, isAdmin }: { repo: RepositoryRow; isAdmin: boolean }) {
  const host = repo.provider === "github" ? "GitHub" : "GitLab";
  return (
    <TableRow>
      <TableCell className="list-col-main">
        <Link href={`/repositories/${repo.id}/reviews`} className="list-title repositories-title">
          <ProviderIcon provider={repo.provider} size={14} />
          <MonoValue value={repo.fullPath} className="list-title-text list-title-fill" />
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
        <TaskTypeBadges taskTypes={repo.taskTypes} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <Badge variant="neutral">{REVIEW_DEPTHS[repo.depth].label}</Badge>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        {repo.pinnedAgents.length > 0 ? (
          <div className="list-filters">
            {repo.pinnedAgents.map((agent) => (
              <Badge key={agent.id} variant="neutral">
                {agent.name}
              </Badge>
            ))}
          </div>
        ) : (
          <Muted>Any harness</Muted>
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
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(`/api/ui/scm-connections/${connection.id}`, mutationResultSchema, {
        organizationId,
      }),
    // Its repositories go with it, and their reviews and pins.
    invalidate: (keys) => [keys.all],
    success: `Removed ${connection.name}`,
  });
  const pending = remove.isPending;
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
                with their reviews, rules, agent pins and coding tasks
                {connection.provider === "gitlab"
                  ? ". The project webhooks are deleted from GitLab"
                  : ". The app stays installed on GitHub until you uninstall it there"}
                . It can then be connected again, from this or another organization.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="danger" onClick={() => remove.mutate()}>
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

const GITHUB_NOTICES = new Set<string>(Object.keys(githubNotices));

const SKELETON_ROWS = 4;

/** The repositories table while it first loads: a name, its task types and the wide columns. */
function RepositoriesSkeleton() {
  return (
    <Table className="list-table">
      <TableBody>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <TableRow key={index}>
            <TableCell className="list-col-main">
              <Skeleton width={`${45 + ((index * 17) % 35)}%`} />
            </TableCell>
            <TableCell>
              <Skeleton width="9rem" height="1.25rem" radius="full" />
            </TableCell>
            {Array.from({ length: 3 }, (_, column) => (
              <TableCell key={column} className={WIDE_COLUMN}>
                <Skeleton width={`${40 + (((index + column) * 13) % 40)}%`} />
              </TableCell>
            ))}
            <TableCell />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RepositoriesTable({
  list,
  isAdmin,
  loadingPage,
}: {
  list: RepositoryList;
  isAdmin: boolean;
  /** Another page is loading: this one stays, dimmed. */
  loadingPage: boolean;
}) {
  const { repositories, page, pageSize, total } = list;
  const pageCount = totalPages(total, pageSize);
  return (
    <div className="list-pending" aria-busy={loadingPage}>
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
              <TableHead>Task types</TableHead>
              <TableHead className={WIDE_COLUMN}>Review depth</TableHead>
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
    </div>
  );
}

function GitHubNotConfigured() {
  return (
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
        The app&apos;s Setup URL must be <InlineCode>/repositories/github/callback</InlineCode> on
        this control panel.
      </AlertDescription>
    </Alert>
  );
}

function ConnectActions({
  githubInstallPath,
  defaultGitLabUrl,
}: {
  /** `undefined` while it loads. */
  githubInstallPath: string | null | undefined;
  defaultGitLabUrl: string | undefined;
}) {
  return (
    <>
      {githubInstallPath ? (
        <Button asChild variant="secondary">
          <a href={githubInstallPath}>
            <IconBrandGithub size={14} />
            Connect GitHub
          </a>
        </Button>
      ) : (
        <Button
          variant="secondary"
          disabled
          title={githubInstallPath === null ? "The GitHub App isn't configured" : undefined}
        >
          <IconBrandGithub size={14} />
          Connect GitHub
        </Button>
      )}
      {defaultGitLabUrl === undefined ? (
        <Button variant="secondary" disabled>
          <IconBrandGitlab size={14} />
          Connect GitLab
        </Button>
      ) : (
        <ConnectGitLabDialog defaultUrl={defaultGitLabUrl} />
      )}
    </>
  );
}

/** The Repositories page: connected repositories (live, paginated in the URL) and, for admins, the code-host connections. */
export function RepositoriesView() {
  const isAdmin = useCurrentUser().role === "admin";
  const searchParams = useSearchParams();
  const page = parsePage(searchParams.get("page") ?? undefined);
  const notice = searchParams.get("github");
  const githubNotice = notice && GITHUB_NOTICES.has(notice) ? (notice as GitHubNotice) : null;
  const list = useRepositoryList(page);
  const setup = useRepositorySetup(isAdmin);
  const data = list.data;
  const { first, last } = pageRange(
    data?.page ?? page,
    data?.pageSize ?? 1,
    data?.repositories.length ?? 0,
  );
  const githubInstallPath = setup.data?.githubInstallPath;

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Repositories" }]} />
      <div className="detail-main">
        <PageHeader
          title="Repositories"
          description="Pull and merge requests in repositories with reviews on are reviewed automatically when they're opened or pushed to. Set each repository's task types in its settings."
          meta={<Freshness query={list} />}
          actions={
            isAdmin && (
              <ConnectActions
                githubInstallPath={githubInstallPath}
                defaultGitLabUrl={setup.data?.defaultGitLabUrl}
              />
            )
          }
        />

        {isAdmin && githubNotice && (
          <Alert variant={githubNotices[githubNotice].variant}>
            <AlertTitle as="h2">{githubNotices[githubNotice].title}</AlertTitle>
            <AlertDescription>{githubNotices[githubNotice].description}</AlertDescription>
          </Alert>
        )}
        {isAdmin && githubInstallPath === null && <GitHubNotConfigured />}

        <Card>
          <CardHeader>
            <CardTitle as="h2">Connected repositories</CardTitle>
            <CardDescription>
              {isAdmin
                ? "Turn reviews on or off per repository. Disconnecting keeps a repository's review history."
                : "Repositories connected by an admin. Only admins can change them."}
              {data &&
                data.repositories.length > 0 &&
                data.total > data.pageSize &&
                ` Showing ${first}–${last} of ${data.total.toLocaleString()}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QueryBoundary query={list} skeleton={<RepositoriesSkeleton />} what="repositories">
              {(loaded) => (
                <RepositoriesTable
                  list={loaded}
                  isAdmin={isAdmin}
                  loadingPage={list.isPlaceholderData}
                />
              )}
            </QueryBoundary>
          </CardContent>
        </Card>

        {isAdmin && data && data.connections.length > 0 && (
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
                {data.connections.map((connection) => (
                  <ConnectionItem key={connection.id} connection={connection} isAdmin={isAdmin} />
                ))}
                {githubInstallPath && data.connections.some((c) => c.provider === "github") && (
                  <Muted className="flex items-center gap-1">
                    <IconExternalLink size={12} />
                    Repositories missing? Add them to the installation on GitHub via Connect GitHub.
                  </Muted>
                )}
              </CardContent>
            </Stack>
          </Card>
        )}
      </div>
    </>
  );
}
