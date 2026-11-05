"use client";

import {
  Button,
  EmptyState,
  IconButton,
  ListRow,
  MetaBadge,
  RowList,
  rowListProps,
  SplitView,
  useSplitWide,
} from "@omniralph/ui";
import { IconPlus } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { FeatureRollupBadge } from "./epic-progress";
import { FeatureDetailView } from "./feature-page";
import { epicCount, FEATURE_STATUS, featureHref, FEATURES_PATH } from "./feature-status";
import { NEW_FEATURE, NewFeatureSheet } from "./new-feature-sheet";
import { useFeatureList } from "./queries";
import "./features.css";

export const NO_FEATURES = "No features yet";
export const NO_FEATURES_DESCRIPTION =
  "A feature is large work planned as a PRFAQ and a Plan, then sharded into epics.";
export const FEATURES_LOAD_FAILED = "Couldn't load features";
export const LOADING_FEATURES = "Loading features…";

export interface FeaturesViewProps {
  /** The open feature (`/features/{id}`); none on `/features`. */
  featureId?: string | null;
  /** The detail beside the list; `FeatureDetailView` by default. */
  renderDetail?: (featureId: string) => ReactNode;
}

function FeatureListSkeleton() {
  return (
    <div className="or-features-skeleton" role="status" data-testid="features-skeleton">
      <span className="or-sr-only">{LOADING_FEATURES}</span>
      <div aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="or-feature-skeleton__row" />
        ))}
      </div>
    </div>
  );
}

/**
 * The Features screen: the list with "Features", the + (New feature, admins) and the active
 * organization's features newest first, each with its name, status, repo, epic count and
 * roll-up of epics and stories done,
 * beside the open feature (on `/features`, the first one, when both panes fit). Archived
 * features come after the others. The list is a live query.
 */
export function FeaturesView({ featureId = null, renderDetail }: FeaturesViewProps) {
  const router = useRouter();
  const admin = useCurrentUser().role === "admin";
  const [creating, setCreating] = useState(false);
  const list = useFeatureList();
  const features = list.data?.features;
  const ordered = features
    ? [
        ...features.filter((feature) => feature.status !== "archived"),
        ...features.filter((feature) => feature.status === "archived"),
      ]
    : [];

  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  const shownId = featureId ?? (wide ? (ordered[0]?.id ?? null) : null);
  const detail = (id: string) =>
    renderDetail ? renderDetail(id) : <FeatureDetailView key={id} featureId={id} />;

  const pane = (
    <div className="or-features__pane">
      <div className="or-features__head or-split__sticky">
        <h1 className="or-features__title">Features</h1>
        {admin ? (
          <IconButton icon={IconPlus} label={NEW_FEATURE} onClick={() => setCreating(true)} />
        ) : null}
      </div>
      <div className="or-features__list">
        {list.isError && !features ? (
          <EmptyState
            headingLevel={2}
            title={FEATURES_LOAD_FAILED}
            description={list.error.message}
            action={
              <Button variant="outline" onClick={() => void list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !features ? (
          <FeatureListSkeleton />
        ) : features.length === 0 ? (
          <EmptyState
            headingLevel={2}
            title={NO_FEATURES}
            description={NO_FEATURES_DESCRIPTION}
            action={
              admin ? (
                <Button variant="outline" onClick={() => setCreating(true)}>
                  {NEW_FEATURE}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div {...rowListProps}>
            <RowList aria-label="Features">
              {ordered.map((feature) => {
                const status = FEATURE_STATUS[feature.status];
                return (
                  <ListRow
                    key={feature.id}
                    href={featureHref(feature.id)}
                    kindLabel={status.label}
                    tone={status.tone}
                    title={feature.name}
                    meta={
                      <>
                        <MetaBadge text={epicCount(feature.epicCount)} />
                        <FeatureRollupBadge feature={feature} />
                        {feature.repository ? (
                          <MetaBadge text={feature.repository.fullPath} mono />
                        ) : null}
                      </>
                    }
                    selected={feature.id === shownId}
                  />
                );
              })}
            </RowList>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <SplitView
        ref={splitRef}
        className="or-features"
        list={pane}
        detail={shownId ? detail(shownId) : null}
        view={featureId ? "detail" : "list"}
        backLink={{ label: "Features", href: FEATURES_PATH }}
        listLabel="Features"
        detailLabel="Feature"
      />
      {creating ? (
        <NewFeatureSheet
          onClose={() => setCreating(false)}
          onCreated={(id) => router.push(featureHref(id))}
        />
      ) : null}
    </>
  );
}
