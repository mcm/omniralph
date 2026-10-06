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
import {
  IconArrowLeft,
  IconBrandGithub,
  IconDeviceFloppy,
  IconExternalLink,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { ListPagination } from "@/components/list-pagination";
import { useAction } from "@/components/use-action";
import { pageRange, pageSlice, totalPages } from "@/lib/pagination";
import { saveGitHubRepositories } from "../../actions";

export interface InstallationRepoRow {
  id: number;
  fullPath: string;
  private: boolean;
  htmlUrl: string;
  /** Connected and enabled for reviews. */
  enabled: boolean;
}

/** Repositories per page; selections are kept across pages. */
const PAGE_SIZE = 25;

interface GitHubReposViewProps {
  connectionId: string;
  account: string;
  /** Installation settings on GitHub (add or remove repositories there). */
  manageUrl: string | null;
  repos: InstallationRepoRow[];
  error: string | null;
}

export function GitHubReposView({
  connectionId,
  account,
  manageUrl,
  repos,
  error,
}: GitHubReposViewProps) {
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

  const save = () =>
    run(
      () => saveGitHubRepositories(connectionId, [...selected]),
      `Saved repositories for ${account}`,
      () => router.push("/repositories"),
    );

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: `GitHub · ${account}` },
        ]}
      />
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
        <div>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>{account}</h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Pick the repositories of this GitHub App installation that Omniralph reviews.
          </Muted>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t load the installation</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
            <CardDescription>
              Only repositories the installation can access are listed.
              {manageUrl && (
                <>
                  {" "}
                  <a
                    href={manageUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: "var(--text-accent)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Change them on GitHub
                    <IconExternalLink size={12} />
                  </a>
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {repos.length === 0 ? (
              <Empty
                icon={<IconBrandGithub size={24} />}
                title="No repositories"
                description="The installation can't access any repositories."
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
          <Button variant="primary" onClick={save} disabled={pending || Boolean(error)}>
            <IconDeviceFloppy size={14} />
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </main>
    </>
  );
}
