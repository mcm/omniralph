"use client";

import {
  Button,
  EmptyState,
  IconButton,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  rowLinkProps,
  rowListProps,
  SplitView,
  StatusIndicator,
  useLinkComponent,
  useSplitWide,
} from "@omniralph/ui";
import {
  IconCode,
  IconEye,
  IconFolder,
  IconMessageQuestion,
  IconPlus,
  type TablerIcon,
} from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { useCurrentUser, type SessionUser } from "@/components/current-user";
import type { RepositoryListItem } from "@/lib/api/repositories";
import { REPOS_PATH, repoHref } from "@/lib/repositories/hrefs";
import { AddRepoSheet, isGitHubNotice, type AddRepoStart } from "./add-repo-sheet";
import { useRepositoryList } from "./queries";
import { RepoDetailView } from "./repo-detail-view";
import "./repos.css";

export { REPOS_PATH, repoHref };

/** The query parameters that open the add-repo sheet: `add` + `connection`, or `github`. */
const ADD_REPO_PARAMS = ["add", "connection", "github"] as const;

/**
 * Where `/repos?add=<provider>&connection=<id>` (a connection's picker) or
 * `/repos?github=<status>` (why connecting GitHub didn't finish) opens the sheet; null
 * without them.
 */
export function addRepoStart(search: URLSearchParams): AddRepoStart | null {
  const add = search.get("add");
  const connection = search.get("connection");
  const github = search.get("github");
  if ((add === "github" || add === "gitlab") && connection) {
    return { connection: { id: connection, provider: add } };
  }
  if (isGitHubNotice(github)) return { githubNotice: github };
  return null;
}

/** Whether the user may add repos to an organization of their scope (an admin there). */
function canAddRepos(user: SessionUser): boolean {
  if (user.scope === "all") return user.organizations.some((entry) => entry.role === "admin");
  return user.role === "admin";
}

/** A Reviews, Coding or Ask switch on a rail row (Design rule 2): dimmed when off. */
function SwitchIcon({ icon: Icon, name, on }: { icon: TablerIcon; name: string; on: boolean }) {
  return (
    <Icon
      className={["or-repo-row__switch", on ? null : "or-repo-row__switch--off"]
        .filter(Boolean)
        .join(" ")}
      size={16}
      stroke={1.75}
      role="img"
      aria-label={`${name} ${on ? "on" : "off"}`}
      focusable="false"
    />
  );
}

/**
 * What the row's dot means, its tooltip: the first problem ("No agent online and 1 more" when
 * there are others), else "2 running"; null for no dot.
 */
export function rowDotMeaning(status: RepositoryListItem["status"]): string | null {
  const [problem, ...others] = status.problems;
  if (problem) {
    return others.length > 0 ? `${problem.message} and ${others.length} more` : problem.message;
  }
  return status.running > 0 ? `${status.running} running` : null;
}

/**
 * The row's dot (Design rule 9): coral with the first problem when the repo has one, else
 * mint while its work runs, else none. Its tooltip says what it means; the trigger adds no
 * tab stop, so the row stays a single link.
 */
function RowDot({ status }: { status: RepositoryListItem["status"] }) {
  const meaning = rowDotMeaning(status);
  if (meaning === null) return null;
  const problem = status.problems[0];
  return (
    <StatusIndicator
      variant="dot"
      className="or-repo-row__dot"
      tone={problem ? "fail" : "run"}
      label={problem ? problem.message : meaning}
      tooltip={meaning}
    />
  );
}

/**
 * One rail row, a single link to the repo: organization (All organizations), repo and group
 * badges, the Reviews, Coding and Ask icons and the status dot. It holds nothing interactive.
 */
function RepoRow({
  repository,
  selected,
  showOrganization,
}: {
  repository: RepositoryListItem;
  selected: boolean;
  showOrganization: boolean;
}) {
  // The provider's link component (Next.js in the app), created with `createElement`: it
  // comes from a hook, and JSX would read as a component made during render.
  const link = useLinkComponent();
  return (
    <li className="or-repo-row">
      {createElement(
        link,
        {
          ...rowLinkProps,
          href: repoHref(repository.id),
          className: "or-repo-row__link",
          "aria-current": selected ? "page" : undefined,
        },
        <span className="or-repo-row__badges">
          {showOrganization ? <OrgBadge name={repository.organization.name} /> : null}
          <RepoBadge host={repository.provider} name={repository.name} strong />
          {repository.group ? <MetaBadge icon={IconFolder} text={repository.group} /> : null}
        </span>,
        <span className="or-repo-row__switches">
          <SwitchIcon icon={IconEye} name="Reviews" on={repository.reviewsEnabled} />
          <SwitchIcon icon={IconCode} name="Coding" on={repository.codingEnabled} />
          <SwitchIcon icon={IconMessageQuestion} name="Ask" on={repository.askEnabled} />
        </span>,
        <RowDot status={repository.status} />,
      )}
    </li>
  );
}

export interface ReposViewProps {
  /** The open repo (`/repos/{id}`), whose row is current; none on `/repos`. */
  repositoryId?: string | null;
  /** The detail beside the rail; `RepoDetailView` by default. */
  renderDetail?: (repositoryId: string) => ReactNode;
}

const defaultDetail = (repositoryId: string) => (
  <RepoDetailView key={repositoryId} repositoryId={repositoryId} />
);

/**
 * The Repos screen (Design board Repos): the rail with "Repos", "Add repo" (admins) and
 * every repo of the user's scope, beside the open repo's detail (on `/repos`, the first
 * repo's, when both panes fit). Below 880 px only one pane shows: the rail on `/repos`, the
 * detail with "‹ Repos" on `/repos/{id}`. The list is a live query; the screen has no live
 * indicator or notice of its own (the shell's `LiveNotice` covers stopped updates).
 */
export function ReposView({ repositoryId = null, renderDetail = defaultDetail }: ReposViewProps) {
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const admin = canAddRepos(user);
  const list = useRepositoryList();
  const repositories = list.data?.repositories;
  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  // Without a repo in the URL, a wide container shows the first repo beside the rail.
  const shownId = repositoryId ?? (wide ? (repositories?.[0]?.id ?? null) : null);

  const router = useRouter();
  const search = useSearchParams();
  // Opened from a link (the GitHub App's callback, a connection's "Manage"): admins only.
  const [start, setStart] = useState(() => (admin ? addRepoStart(search) : null));
  const [adding, setAdding] = useState(start !== null);
  useEffect(() => {
    // The sheet has read them: drop them, so a reload or Back doesn't open it again.
    const url = new URL(window.location.href);
    if (!ADD_REPO_PARAMS.some((name) => url.searchParams.has(name))) return;
    for (const name of ADD_REPO_PARAMS) url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  const addRepo = (
    <IconButton
      label="Add repo"
      icon={IconPlus}
      variant="outline"
      size="sm"
      onClick={() => setAdding(true)}
    />
  );

  const rail = (
    <div className="or-repos__rail">
      <div className="or-repos__head">
        <h1 className="or-repos__title">Repos</h1>
        {admin ? addRepo : null}
      </div>
      <div className="or-repos__list">
        {list.isError && !repositories ? (
          <EmptyState
            headingLevel={2}
            title="Couldn't load repos"
            description={list.error.message}
            action={
              <Button variant="outline" onClick={() => void list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : repositories === undefined ? null : repositories.length === 0 ? (
          <EmptyState
            headingLevel={2}
            title="No repos yet"
            action={
              admin ? (
                <Button variant="outline" onClick={() => setAdding(true)}>
                  Add repo
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul {...rowListProps} className="or-repos__rows" aria-label="Repos">
              {repositories.map((repository) => (
                <RepoRow
                  key={repository.id}
                  repository={repository}
                  selected={repository.id === shownId}
                  showOrganization={showOrganization}
                />
              ))}
            </ul>
            {list.data?.truncated ? (
              <p className="or-repos__truncated">Showing the first {repositories.length} repos.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <SplitView
        ref={splitRef}
        className="or-repos"
        list={rail}
        detail={shownId ? renderDetail(shownId) : null}
        view={repositoryId ? "detail" : "list"}
        backLink={{ label: "Repos", href: REPOS_PATH }}
        listLabel="Repos"
        detailLabel="Repo"
      />
      {admin ? (
        <AddRepoSheet
          open={adding}
          onOpenChange={(open) => {
            setAdding(open);
            // Opened again with "Add repo", it starts at the connections.
            if (!open) setStart(null);
          }}
          start={start}
          onAdded={(id) => {
            setAdding(false);
            setStart(null);
            router.push(repoHref(id));
          }}
        />
      ) : null}
    </>
  );
}
