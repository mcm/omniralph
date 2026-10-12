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
  Empty,
  Label,
  Muted,
} from "@iamthemcmaster/ui";
import { IconArrowLeft, IconDeviceFloppy } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { ListPagination } from "@/components/list-pagination";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import type { ActionResult } from "@/lib/action-result";
import { pageRange, pageSlice, totalPages } from "@/lib/pagination";

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
  errorTitle: string;
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
  errorTitle,
  repos,
  error,
  save,
  savedMessage,
}: RepoSelectionViewProps) {
  const router = useRouter();
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
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <PageHeader title={title} description={intro} />

        {error && (
          <Alert variant="danger">
            <AlertTitle as="h2">{errorTitle}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle as="h2">Repositories</CardTitle>
            <CardDescription>{listedDescription}</CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {repos.length === 0 ? (
              <Empty
                icon={emptyIcon}
                title="No repositories"
                titleAs="h3"
                description={emptyDescription}
              />
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-2) 0",
                  }}
                >
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
                  <Muted style={{ marginLeft: "auto" }}>
                    {selected.size} selected
                    {pageCount > 1 && ` · showing ${first}–${last} of ${repos.length}`}
                  </Muted>
                </div>
                {shown.map((repo) => (
                  <div
                    key={repo.id}
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
                    <Checkbox
                      id={`repo-${repo.id}`}
                      checked={selected.has(repo.id)}
                      onCheckedChange={(checked) => toggle(repo.id, checked === true)}
                    />
                    <Label
                      htmlFor={`repo-${repo.id}`}
                      style={{
                        flex: 1,
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-sm)",
                      }}
                    >
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
        </Card>

        <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
          <Button asChild variant="ghost">
            <Link href="/repositories">
              <IconArrowLeft size={14} />
              Back
            </Link>
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending || Boolean(error)}>
            <IconDeviceFloppy size={14} />
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </main>
    </>
  );
}
