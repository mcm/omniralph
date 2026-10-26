"use client";

import {
  Button,
  EmptyState,
  IconButton,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  SplitView,
  StatusDot,
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
import { createElement, useRef, type ReactNode } from "react";
import { useCurrentUser, type SessionUser } from "@/components/current-user";
import type { RepositoryListItem } from "@/lib/api/repositories";
import { useRepositoryList } from "./queries";
import { RepoDetailView } from "./repo-detail-view";
import "./repos.css";

/** The Repos screen's list. */
export const REPOS_PATH = "/repos";

/** A repo's page on the Repos screen. */
export function repoHref(repositoryId: string): string {
  return `${REPOS_PATH}/${repositoryId}`;
}

/**
 * Where "Add repo" goes: today's connections and repository pickers, until the add-repo
 * sheet (TOOL-717) replaces them.
 */
export const ADD_REPO_HREF = "/repositories";

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
 * The row's dot (Design rule 9): coral with the first problem when the repo has one, else
 * mint while its work runs, else none.
 */
function RowDot({ status }: { status: RepositoryListItem["status"] }) {
  const problem = status.problems[0];
  if (problem)
    return <StatusDot className="or-repo-row__dot" tone="fail" label={problem.message} />;
  if (status.running > 0) {
    return (
      <StatusDot className="or-repo-row__dot" tone="run" label={`${status.running} running`} />
    );
  }
  return null;
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

  const addRepo = (
    <IconButton label="Add repo" icon={IconPlus} variant="outline" size="sm" href={ADD_REPO_HREF} />
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
                <Button variant="outline" href={ADD_REPO_HREF}>
                  Add repo
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className="or-repos__rows" aria-label="Repos">
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
  );
}
