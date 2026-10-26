"use client";

import {
  BranchBadge,
  Button,
  DetailsSection,
  EmptyState,
  OrgBadge,
  RepoBadge,
  scrollToSection,
  SectionIndex,
  TextLink,
  Toolbar,
  useActiveSection,
  type MenuItem,
} from "@omniralph/ui";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useCurrentUser } from "@/components/current-user";
import { ApiError } from "@/lib/api/client";
import type { RepositoryDetail, RepositoryProblemItem } from "@/lib/api/repositories";
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

/** Shown for a repo that doesn't exist, was removed, or is outside the user's organizations. */
export const REPO_NOT_FOUND = "This repo doesn't exist or isn't in your organizations.";

/** The failed load of a repo. */
export const REPO_DETAIL_FAILED = "Couldn't load this repo.";

/** The detail's sections, in page order: the section index's entries and `?section=` values. */
export const REPO_SECTIONS = [
  { id: "reviews", label: "Reviews" },
  { id: "coding", label: "Coding" },
  { id: "ask", label: "Ask" },
  { id: "agents", label: "Agents" },
  { id: "rules", label: "Rules" },
  { id: "advanced", label: "Advanced" },
] as const;
export type RepoSectionId = (typeof REPO_SECTIONS)[number]["id"];

/** The sections that are one settings card (the card's title names the section). */
const CARD_SECTIONS: Partial<Record<RepoSectionId, true>> = {
  reviews: true,
  coding: true,
  ask: true,
  agents: true,
  rules: true,
};

const SECTION_IDS: readonly RepoSectionId[] = REPO_SECTIONS.map((section) => section.id);

function isSectionId(value: string | null): value is RepoSectionId {
  return value !== null && (SECTION_IDS as readonly string[]).includes(value);
}

/** Writes `?section=<id>` into the URL in place (no navigation, no history entry). */
function writeSectionParam(id: RepoSectionId) {
  const url = new URL(window.location.href);
  url.searchParams.set("section", id);
  window.history.replaceState(window.history.state, "", url);
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

/** Finds the scrolling detail pane around `element`, for the section index's "in view". */
function useScrollRoot(): [RefObject<Element | null>, (element: HTMLElement | null) => void] {
  const root = useRef<Element | null>(null);
  const attach = (element: HTMLElement | null) => {
    root.current = element?.closest(".or-split__detail") ?? null;
  };
  return [root, attach];
}

function RepoDetailContent({ detail }: { detail: RepositoryDetail }) {
  const user = useCurrentUser();
  const searchParams = useSearchParams();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [scrollRoot, attachScrollRoot] = useScrollRoot();
  const active = useActiveSection(SECTION_IDS, scrollRoot);
  const { repository } = detail;
  const showOrganization = user.scope === "all";

  // A deep link (`/repos/{id}?section=coding`) opens on its section, once.
  const requested = searchParams.get("section");
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current) return;
    scrolled.current = true;
    if (isSectionId(requested)) scrollToSection(requested);
  }, [requested]);

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
    <article ref={attachScrollRoot} className="or-repo-detail" aria-label={repository.fullPath}>
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
      <SectionIndex
        className="or-repo-detail__index"
        aria-label="Sections"
        sections={REPO_SECTIONS}
        active={active}
        onNavigate={writeSectionParam}
      />
      {REPO_SECTIONS.map((section) => (
        <section
          key={section.id}
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
      ))}
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
 * when it has some, Design rule 9), the section index (`?section=`) and its sections. A live
 * query: the repo's change events refetch it.
 */
export function RepoDetailView({ repositoryId }: { repositoryId: string }) {
  const detail = useRepositoryDetail(repositoryId);
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
