"use client";

import {
  BranchBadge,
  Button,
  DetailsSection,
  EmptyState,
  OrgBadge,
  RepoBadge,
  TabPanel,
  Tabs,
  TextLink,
  Toolbar,
  type MenuItem,
} from "@omniralph/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { ApiError } from "@/lib/api/client";
import type { RepositoryDetail, RepositoryProblemItem } from "@/lib/api/repositories";
import { repoHref } from "@/lib/repositories/hrefs";
import { runListHref } from "@/lib/runs/hrefs";
import { AdvancedSection } from "./advanced-section";
import { AgentsCard } from "./agents-card";
import { AskCard } from "./ask-card";
import { CodingCard } from "./coding-card";
import { useProblemAction } from "./mutations";
import { useRepositoryDetail } from "./queries";
import { RemoveRepoDialog } from "./remove-repo-dialog";
import { ReviewsCard } from "./reviews-card";
import { RulesSection } from "./rules-section";
import "./repo-detail.css";
import { useAskContextRepository } from "@/components/ask/ask-context";

/** Shown for a repo that doesn't exist, was removed, or is outside the user's organizations. */
export const REPO_NOT_FOUND = "This repo doesn't exist or isn't in your organizations.";

/** The failed load of a repo. */
export const REPO_DETAIL_FAILED = "Couldn't load this repo.";

/** The detail's sections, in tab order: the tabs and their `?tab=` values. */
export const REPO_SECTIONS = [
  { id: "reviews", label: "Reviews" },
  { id: "coding", label: "Coding" },
  { id: "ask", label: "Ask" },
  { id: "agents", label: "Agents" },
  { id: "rules", label: "Rules" },
  { id: "advanced", label: "Advanced" },
] as const;
export type RepoSectionId = (typeof REPO_SECTIONS)[number]["id"];

/** The tab a repo opens on; it is left out of the URL. */
const DEFAULT_SECTION: RepoSectionId = "reviews";

/** The sections that are one settings card (the card's title names the section). */
const CARD_SECTIONS: Partial<Record<RepoSectionId, true>> = {
  reviews: true,
  coding: true,
  ask: true,
  agents: true,
  rules: true,
};

const SECTION_IDS: readonly RepoSectionId[] = REPO_SECTIONS.map((section) => section.id);

function isSectionId(value: string | null | undefined): value is RepoSectionId {
  return value != null && (SECTION_IDS as readonly string[]).includes(value);
}

/**
 * The tab a repo's URL names: `?tab=`, else the older `?section=` (links already sent, e.g.
 * by the chat agent); Reviews when neither names a section.
 */
export function parseRepoSection(params: Pick<URLSearchParams, "get">): RepoSectionId {
  for (const candidate of [params.get("tab"), params.get("section")]) {
    if (isSectionId(candidate)) return candidate;
  }
  return DEFAULT_SECTION;
}

/** A repo's URL on a tab: `/repos/{id}?tab=` (no `?tab=` for Reviews). */
export function repoSectionHref(repositoryId: string, section: RepoSectionId): string {
  return section === DEFAULT_SECTION
    ? repoHref(repositoryId)
    : `${repoHref(repositoryId)}?tab=${section}`;
}

const providerName = (provider: RepositoryDetail["repository"]["provider"]) =>
  provider === "gitlab" ? "GitLab" : "GitHub";

/** A problem of the repo with its action: a button that posts, or a link. */
function ProblemItem({
  repositoryId,
  problem,
}: {
  repositoryId: string;
  problem: RepositoryProblemItem;
}) {
  const run = useProblemAction(repositoryId);
  const { action } = problem;
  return (
    <li className="or-repo-problems__item">
      <span className="or-repo-problems__message">{problem.message}</span>
      {action?.type === "post" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={run.isPending}
          onClick={() => run.mutate(problem)}
        >
          {action.label}
        </Button>
      ) : action?.type === "link" ? (
        <TextLink href={action.href}>{action.label}</TextLink>
      ) : null}
    </li>
  );
}

/** What is wrong with the repo (Design rule 9): shown only when something is. */
function RepoProblems({ repository }: { repository: RepositoryDetail }) {
  const { problems } = repository.status;
  if (problems.length === 0) return null;
  return (
    <section className="or-repo-problems" aria-label="Problems">
      <ul className="or-repo-problems__list">
        {problems.map((problem) => (
          <ProblemItem
            key={problem.code}
            repositoryId={repository.repository.id}
            problem={problem}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * The selected tab: the URL's (`parseRepoSection`), shown at once on a click while the URL
 * catches up. A `#section` anchor followed on the page (the unsaved changes bar's links)
 * opens its tab too, and the anchor leaves the URL so the same link works again.
 */
function useRepoSection(
  repositoryId: string,
  searchParams: Pick<URLSearchParams, "get">,
  replace: (href: string) => void,
): [RepoSectionId, (section: RepoSectionId) => void] {
  const fromUrl = parseRepoSection(searchParams);
  const [selected, setSelected] = useState(fromUrl);
  // The URL changed (back/forward, a link): it wins over the clicked tab.
  const [seenUrl, setSeenUrl] = useState(fromUrl);
  if (seenUrl !== fromUrl) {
    setSeenUrl(fromUrl);
    setSelected(fromUrl);
  }

  const select = (section: RepoSectionId) => {
    setSelected(section);
    replace(repoSectionHref(repositoryId, section));
  };
  const selectRef = useLatest(select);

  useEffect(() => {
    const followHash = () => {
      const id = window.location.hash.replace(/^#/, "");
      if (!isSectionId(id)) return;
      selectRef.current(id);
      // After the tab shows, bring its section into view.
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    };
    // A link that arrived with `#coding` (read after hydration: the server has no hash).
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, [selectRef]);

  return [selected, select];
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

function RepoDetailContent({ detail }: { detail: RepositoryDetail }) {
  const user = useCurrentUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const { repository } = detail;
  const showOrganization = user.scope === "all";
  const [tab, selectTab] = useRepoSection(repository.id, searchParams, (href) =>
    router.replace(href, { scroll: false }),
  );

  const menu: MenuItem[] = [
    { label: "View runs for this repo", href: runListHref({ repository: [repository.id] }) },
    {
      label: `Open in ${providerName(repository.provider)}`,
      onSelect: () => window.open(repository.webUrl, "_blank", "noopener,noreferrer"),
    },
    ...(detail.canEdit
      ? [{ label: "Remove repo…", destructive: true, onSelect: () => setConfirmRemove(true) }]
      : []),
  ];

  const organization = showOrganization ? <OrgBadge name={repository.organization.name} /> : null;
  const branch = repository.defaultBranch ? <BranchBadge name={repository.defaultBranch} /> : null;

  return (
    <article className="or-repo-detail" aria-label={repository.fullPath}>
      <header className="or-repo-detail__head">
        <div className="or-repo-detail__badges">
          {organization ? <span className="or-repo-detail__context">{organization}</span> : null}
          <RepoBadge host={repository.provider} name={repository.fullPath} strong />
          {branch ? <span className="or-repo-detail__context">{branch}</span> : null}
        </div>
        <Toolbar label="Repo actions" menu={menu} />
      </header>
      {organization || branch ? (
        <DetailsSection className="or-repo-detail__details">
          <div className="or-repo-detail__badges">
            {organization}
            {branch}
          </div>
        </DetailsSection>
      ) : null}
      <RepoProblems repository={detail} />
      <Tabs<RepoSectionId>
        aria-label="Sections"
        className="or-repo-detail__tabs"
        tabs={REPO_SECTIONS.map(({ id, label }) => ({ value: id, label }))}
        value={tab}
        onValueChange={selectTab}
      >
        {REPO_SECTIONS.map((section) => (
          // Kept mounted: an edit in progress on one tab survives a look at another.
          <TabPanel key={section.id} value={section.id} keepMounted>
            <section
              id={section.id}
              className="or-repo-section"
              // A card section is the card's own region (named by its title): not a second one.
              aria-labelledby={
                section.id in CARD_SECTIONS ? undefined : `or-repo-section-${section.id}`
              }
            >
              {section.id === "reviews" ? (
                <ReviewsCard detail={detail} titleId={`or-repo-section-${section.id}`} />
              ) : section.id === "coding" ? (
                <CodingCard detail={detail} titleId={`or-repo-section-${section.id}`} />
              ) : section.id === "ask" ? (
                <AskCard detail={detail} titleId={`or-repo-section-${section.id}`} />
              ) : section.id === "agents" ? (
                <AgentsCard detail={detail} titleId={`or-repo-section-${section.id}`} />
              ) : section.id === "rules" ? (
                <RulesSection detail={detail} titleId={`or-repo-section-${section.id}`} />
              ) : (
                <AdvancedSection
                  detail={detail}
                  titleId={`or-repo-section-${section.id}`}
                  onRemove={() => setConfirmRemove(true)}
                />
              )}
            </section>
          </TabPanel>
        ))}
      </Tabs>
      {detail.canEdit ? (
        <RemoveRepoDialog
          repository={repository}
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
        />
      ) : null}
    </article>
  );
}

function RepoDetailSkeleton() {
  return (
    <div className="or-repo-detail" aria-busy="true" data-testid="repo-detail-skeleton">
      <div className="or-repo-skeleton" aria-hidden="true">
        <div className="or-repo-skeleton__line or-repo-skeleton__line--short" />
        <div className="or-repo-skeleton__line" />
        <div className="or-repo-skeleton__line" />
      </div>
    </div>
  );
}

/**
 * A repo on the Repos screen (Design board Repos): its header badges (organization under
 * All organizations, the repo, its default branch once known; on phone the organization and
 * branch move into "Details") and ⋯ menu (Design rule 5), the notice of its problems (only
 * when it has some, Design rule 9), and its sections as tabs (`?tab=`), one at a time. A live
 * query: the repo's change events refetch it.
 */
export function RepoDetailView({ repositoryId }: { repositoryId: string }) {
  const detail = useRepositoryDetail(repositoryId);
  useAskContextRepository(repositoryId);
  if (detail.isPending) return <RepoDetailSkeleton />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <EmptyState className="or-repo-detail__empty" title={REPO_NOT_FOUND} />;
    }
    return (
      <div className="or-repo-detail">
        <p className="or-repo-error" role="alert">
          {REPO_DETAIL_FAILED}
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return <RepoDetailContent detail={detail.data} />;
}
