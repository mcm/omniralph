"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Badge,
  Cluster,
  Empty,
  InlineCode,
  Label,
  Muted,
  Skeleton,
  Spinner,
  Stack,
} from "@iamthemcmaster/ui";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconDeviceFloppy,
  IconRefresh,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ListPagination } from "@/components/list-pagination";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary, QueryError } from "@/components/query-boundary";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { api, ApiError } from "@/lib/api/client";
import {
  addedRepositoriesSchema,
  LISTING_FAILED,
  scmConnectionSchema,
  selectableRepositoriesSchema,
  type SelectableRepoRow,
  type SelectableRepositories,
} from "@/lib/api/repositories";
import { pageRange, pageSlice, totalPages } from "@/lib/pagination";
import { isRetryable, listingFailure, type ListingFailure } from "@/lib/scm/listing-error";

export type { SelectableRepoRow };

type Provider = "github" | "gitlab";

/** Repositories per page; selections are kept across pages. */
const PAGE_SIZE = 25;

/** Placeholder rows while the list loads. */
const LOADING_ROWS = 5;

/** The connection (`GET /api/ui/scm-connections/{id}`), for the header; switches organization if needed. */
function useScmConnection(provider: Provider, connectionId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  const pathname = usePathname();
  return useQuery({
    queryKey: keys.connections.detail(connectionId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/scm-connections/${connectionId}`, scmConnectionSchema, {
        params: { provider, next: pathname },
        organizationId: organization.id,
        signal,
      }),
    refetchInterval: false,
  });
}

/**
 * What the code host lists for the connection. An external API call: it loads once per
 * visit and on Refresh, never on an interval or focus, and isn't retried (Refresh is).
 */
export function useSelectableRepositories(provider: Provider, connectionId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.connections.part(connectionId, "selectable"),
    queryFn: ({ signal }) =>
      api.get(
        `/api/ui/scm-connections/${connectionId}/repositories`,
        selectableRepositoriesSchema,
        { params: { provider, organization: organization.id }, signal },
      ),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** The repository IDs connected here, sorted (so a refetch in another order isn't an edit). */
function connectedIds(listing: SelectableRepositories | undefined): number[] {
  return (listing?.repos ?? [])
    .filter((repo) => repo.connected)
    .map((repo) => repo.id)
    .sort((a, b) => a - b);
}

/** The list while the code host answers. */
function ListLoading() {
  return (
    <div aria-busy="true" className="repo-selection-loading">
      <div className="repo-select-all">
        <Spinner size="sm" variant="neutral" label="Loading repositories…" />
        <Muted aria-hidden="true">Loading repositories…</Muted>
      </div>
      {Array.from({ length: LOADING_ROWS }, (_, index) => (
        <div key={index} className="repo-panel repo-row" aria-hidden="true">
          <Skeleton width={4} height={4} radius="sm" />
          <Skeleton width={`${40 + ((index * 17) % 30)}%`} />
        </div>
      ))}
    </div>
  );
}

interface RepoSelectionViewProps {
  provider: Provider;
  /** Breadcrumb after "Repositories", e.g. `GitHub · acme`, from the connection's name. */
  breadcrumb: (name: string) => string;
  /** Under the title: what's picked here. */
  intro: string;
  /** Card description: which repositories are listed (and where to change that). */
  listedDescription: (listing: SelectableRepositories | undefined) => React.ReactNode;
  emptyIcon: React.ReactNode;
  emptyDescription: string;
  /** The error's title and cause (what to check) for each kind of listing failure. */
  describeError: (failure: ListingFailure) => { title: string; cause: React.ReactNode };
  /** The success toast, from the connection's name. */
  savedMessage: (name: string) => string;
}

/**
 * Checkbox list of a code-host connection's repositories (the connection is the route's
 * `connectionId`): the ticked ones that aren't connected yet are added (connected ones stay
 * ticked). Saving refetches the repositories list before going back to it, so it shows the
 * added repositories on arrival.
 */
export function RepoSelectionView({
  provider,
  breadcrumb,
  intro,
  listedDescription,
  emptyIcon,
  emptyDescription,
  describeError,
  savedMessage,
}: RepoSelectionViewProps) {
  const { connectionId } = useParams<{ connectionId: string }>();
  const router = useRouter();
  const connection = useScmConnection(provider, connectionId);
  const listing = useSelectableRepositories(provider, connectionId);
  const name = connection.data?.name ?? "";
  const title = listing.data?.account ?? name;

  const listingError =
    listing.data === undefined && listing.error instanceof ApiError ? listing.error : null;
  const failure =
    listingError?.code === LISTING_FAILED ? listingFailure(listingError.message) : null;
  const errorCopy = failure ? describeError(failure) : null;

  const repos = React.useMemo(() => listing.data?.repos ?? [], [listing.data]);
  const loading = listing.data === undefined;
  const refreshing = listing.isFetching && !loading;
  const [draft, setDraft] = useSeededDraft(connectedIds(listing.data));
  const selected = React.useMemo(() => new Set(draft), [draft]);
  const connected = React.useMemo(() => new Set(connectedIds(listing.data)), [listing.data]);
  const toAdd = draft.filter((id) => !connected.has(id));
  const allSelected = repos.length > 0 && selected.size === repos.length;
  const [page, setPage] = React.useState(1);
  const pageCount = totalPages(repos.length, PAGE_SIZE);
  const currentPage = Math.min(page, pageCount);
  const shown = pageSlice(repos, currentPage, PAGE_SIZE);
  const { first, last } = pageRange(currentPage, PAGE_SIZE, shown.length);

  const toggle = (id: number, checked: boolean) =>
    setDraft((current) =>
      checked
        ? [...new Set([...current, id])].sort((a, b) => a - b)
        : current.filter((value) => value !== id || connected.has(value)),
    );

  const save = useApiMutation({
    mutationFn: (ids: number[], { organizationId }) =>
      api.post(`/api/ui/scm-connections/${connectionId}/repositories`, addedRepositoriesSchema, {
        body: { provider, ids, organizationId },
      }),
    invalidate: (keys) => [
      // The repositories page (not mounted here) is refetched before going there, so it
      // never shows its cached list without the saved repositories.
      { queryKey: keys.repositories.lists, refetchType: "all" },
      keys.agents.all,
    ],
    success: () => savedMessage(name),
    onSuccess: () => router.push("/repositories"),
  });
  const pending = save.isPending;

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: name ? breadcrumb(name) : "…" },
        ]}
      />
      <div className="detail-main">
        <PageHeader
          title={title || (provider === "github" ? "GitHub installation" : "GitLab connection")}
          description={intro}
        />

        <QueryBoundary query={connection} skeleton={<ListLoading />} what="the connection">
          {() =>
            errorCopy && failure && listingError ? (
              // Only the error: an empty list here would blame the wrong thing.
              <Alert variant="danger">
                <IconAlertTriangle size={16} />
                <AlertTitle as="h2">{errorCopy.title}</AlertTitle>
                <AlertDescription className="repo-selection-error">
                  <span>{errorCopy.cause}</span>
                  {/* A missing setting is already named in the cause. */}
                  {failure.kind !== "config" && (
                    <span>
                      Error:{" "}
                      <InlineCode className="repo-selection-error-detail">
                        {listingError.message}
                      </InlineCode>
                    </span>
                  )}
                  <span className="repo-selection-error-actions">
                    {/* A missing setting or refused credentials don't fix themselves on a retry. */}
                    {isRetryable(failure) && (
                      <Button
                        variant="secondary"
                        disabled={listing.isFetching}
                        onClick={() => void listing.refetch()}
                      >
                        <IconRefresh size={14} />
                        {listing.isFetching ? "Retrying…" : "Retry"}
                      </Button>
                    )}
                    <Button asChild variant={isRetryable(failure) ? "ghost" : "secondary"}>
                      <Link href="/repositories">
                        <IconArrowLeft size={14} />
                        Back to repositories
                      </Link>
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : listing.isError && loading ? (
              <QueryError
                title="Couldn't load the repositories"
                error={listing.error}
                retrying={listing.isFetching}
                onRetry={() => void listing.refetch()}
              />
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <Cluster justify="between" align="start">
                      <CardTitle as="h2">Repositories</CardTitle>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={listing.isFetching || pending}
                        onClick={() => void listing.refetch()}
                        title={`Reload the list from ${provider === "github" ? "GitHub" : "GitLab"}`}
                      >
                        <IconRefresh size={14} />
                        {refreshing ? "Refreshing…" : "Refresh"}
                      </Button>
                    </Cluster>
                    <CardDescription>{listedDescription(listing.data)}</CardDescription>
                  </CardHeader>
                  <Stack asChild gap={2}>
                    <CardContent>
                      {loading ? (
                        <ListLoading />
                      ) : repos.length === 0 ? (
                        <Empty
                          icon={emptyIcon}
                          title="No repositories"
                          titleAs="h3"
                          description={emptyDescription}
                        />
                      ) : (
                        <Stack gap={2} className="list-pending" aria-busy={refreshing}>
                          <div className="repo-select-all">
                            <Checkbox
                              id="select-all"
                              checked={allSelected}
                              onCheckedChange={(checked) =>
                                setDraft(
                                  checked === true
                                    ? repos.map((repo) => repo.id).sort((a, b) => a - b)
                                    : [...connected].sort((a, b) => a - b),
                                )
                              }
                            />
                            <Label htmlFor="select-all">Select all ({repos.length})</Label>
                            <Muted className="ml-auto">
                              {selected.size} selected
                              {pageCount > 1 && ` · showing ${first}–${last} of ${repos.length}`}
                            </Muted>
                          </div>
                          {shown.map((repo) => (
                            <div key={repo.id} className="repo-panel repo-row">
                              <Checkbox
                                id={`repo-${repo.id}`}
                                checked={selected.has(repo.id)}
                                disabled={repo.connected}
                                onCheckedChange={(checked) => toggle(repo.id, checked === true)}
                              />
                              <Label htmlFor={`repo-${repo.id}`} className="repo-select-name">
                                {repo.fullPath}
                              </Label>
                              {repo.private && <Badge variant="neutral">Private</Badge>}
                              {repo.connected && <Badge variant="success">Connected</Badge>}
                            </div>
                          ))}
                          <ListPagination
                            page={currentPage}
                            pageCount={pageCount}
                            hrefFor={(p) => `#page-${p}`}
                            onSelect={setPage}
                          />
                        </Stack>
                      )}
                    </CardContent>
                  </Stack>
                </Card>

                <Cluster justify="end">
                  <Button asChild variant="ghost">
                    <Link href="/repositories">
                      <IconArrowLeft size={14} />
                      Back
                    </Link>
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => save.mutate(toAdd)}
                    disabled={
                      pending || loading || refreshing || !connection.data || toAdd.length === 0
                    }
                  >
                    <IconDeviceFloppy size={14} />
                    {pending ? "Saving…" : "Save"}
                  </Button>
                </Cluster>
              </>
            )
          }
        </QueryBoundary>
      </div>
    </>
  );
}
