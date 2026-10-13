"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  Stack,
} from "@iamthemcmaster/ui";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconDeviceFloppy,
  IconRefresh,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { ListPagination } from "@/components/list-pagination";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import type { ActionResult } from "@/lib/action-result";
import { pageRange, pageSlice, totalPages } from "@/lib/pagination";
import { isRetryable, listingFailure, type ListingFailure } from "@/lib/scm/listing-error";

/** A repository (GitHub) or project (GitLab) the connection can access. */
export interface SelectableRepoRow {
  id: number;
  fullPath: string;
  private: boolean;
  htmlUrl: string;
  /** Connected and enabled for reviews. */
  enabled: boolean;
}

/** Repositories per page; selections are kept across pages. */
const PAGE_SIZE = 25;

interface RepoSelectionViewProps {
  /** Breadcrumb after "Repositories", e.g. `GitHub · acme`. */
  breadcrumb: string;
  title: string;
  /** Under the title: what's picked here. */
  intro: string;
  /** Card description: which repositories are listed (and where to change that). */
  listedDescription: React.ReactNode;
  emptyIcon: React.ReactNode;
  emptyDescription: string;
  /** The error's title and cause (what to check) for each kind of listing failure. */
  describeError: (failure: ListingFailure) => { title: string; cause: React.ReactNode };
  repos: SelectableRepoRow[];
  error: string | null;
  /** Saves the selected repository IDs. */
  save: (selectedIds: number[]) => Promise<ActionResult>;
  savedMessage: string;
}

/** Checkbox list of a code-host connection's repositories, saved as the reviewed ones. */
export function RepoSelectionView({
  breadcrumb,
  title,
  intro,
  listedDescription,
  emptyIcon,
  emptyDescription,
  describeError,
  repos,
  error,
  save,
  savedMessage,
}: RepoSelectionViewProps) {
  const router = useRouter();
  const failure = error ? listingFailure(error) : null;
  const errorCopy = failure ? describeError(failure) : null;
  const [retrying, startRetry] = React.useTransition();
  const { pending, run } = useAction();
  const [selected, setSelected] = React.useState(
    () => new Set(repos.filter((repo) => repo.enabled).map((repo) => repo.id)),
  );
  const allSelected = repos.length > 0 && selected.size === repos.length;
  const [page, setPage] = React.useState(1);
  const pageCount = totalPages(repos.length, PAGE_SIZE);
  const currentPage = Math.min(page, pageCount);
  const shown = pageSlice(repos, currentPage, PAGE_SIZE);
  const { first, last } = pageRange(currentPage, PAGE_SIZE, shown.length);

  const toggle = (id: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const submit = () =>
    run(
      () => save([...selected]),
      savedMessage,
      () => router.push("/repositories"),
    );

  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Repositories", href: "/repositories" }, { label: breadcrumb }]}
      />
      <main className="detail-main">
        <PageHeader title={title} description={intro} />

        {errorCopy && failure ? (
          // Only the error: an empty list here would blame the wrong thing.
          <Alert variant="danger">
            <IconAlertTriangle size={16} />
            <AlertTitle as="h2">{errorCopy.title}</AlertTitle>
            <AlertDescription className="repo-selection-error">
              <span>{errorCopy.cause}</span>
              {/* A missing setting is already named in the cause. */}
              {failure.kind !== "config" && (
                <span>
                  Error: <InlineCode className="repo-selection-error-detail">{error}</InlineCode>
                </span>
              )}
              <span className="repo-selection-error-actions">
                {/* A missing setting or refused credentials don't fix themselves on a retry. */}
                {isRetryable(failure) && (
                  <Button
                    variant="secondary"
                    disabled={retrying}
                    onClick={() => startRetry(() => router.refresh())}
                  >
                    <IconRefresh size={14} />
                    {retrying ? "Retrying…" : "Retry"}
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
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle as="h2">Repositories</CardTitle>
                <CardDescription>{listedDescription}</CardDescription>
              </CardHeader>
              <Stack asChild gap={2}>
                <CardContent>
                  {repos.length === 0 ? (
                    <Empty
                      icon={emptyIcon}
                      title="No repositories"
                      titleAs="h3"
                      description={emptyDescription}
                    />
                  ) : (
                    <>
                      <div className="repo-select-all">
                        <Checkbox
                          id="select-all"
                          checked={allSelected}
                          onCheckedChange={(checked) =>
                            setSelected(
                              checked === true ? new Set(repos.map((repo) => repo.id)) : new Set(),
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
                            onCheckedChange={(checked) => toggle(repo.id, checked === true)}
                          />
                          <Label htmlFor={`repo-${repo.id}`} className="repo-select-name">
                            {repo.fullPath}
                          </Label>
                          {repo.private && <Badge variant="neutral">Private</Badge>}
                          {repo.enabled && <Badge variant="success">Enabled</Badge>}
                        </div>
                      ))}
                      <ListPagination
                        page={currentPage}
                        pageCount={pageCount}
                        hrefFor={(p) => `#page-${p}`}
                        onSelect={setPage}
                      />
                    </>
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
              <Button variant="primary" onClick={submit} disabled={pending}>
                <IconDeviceFloppy size={14} />
                {pending ? "Saving…" : "Save"}
              </Button>
            </Cluster>
          </>
        )}
      </main>
    </>
  );
}
