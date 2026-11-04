"use client";

import {
  Button,
  Card,
  EmptyState,
  RadioList,
  SaveBar,
  useStagedCard,
  type RadioListOption,
  type StagedChange,
} from "@omniralph/ui";
import { useMemo } from "react";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { api } from "@/lib/api/client";
import { connectionKeys } from "@/lib/api/keys";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import {
  FEATURE_MAPPING_LABELS,
  FEATURE_MAPPINGS,
  trackerFeatureMappingSchema,
  type FeatureMapping,
  type TrackerFeatureMappingView,
} from "@/lib/api/trackers";
import { useTrackerFeatureMapping } from "./queries";

/** The card's help line. */
export const FEATURE_MAPPING_HELP = "Where a feature, a group of epics planned together, shows up.";

/** Each choice's one-line explanation. */
export const FEATURE_MAPPING_EXPLANATIONS: Record<FeatureMapping, string> = {
  omniralph: "Features live in Omniralph; their epics are filed in the tracker on their own.",
  "parent-issue":
    "Om also creates a parent issue for each feature in the tracker and files its epics under it.",
};

/** Shown under the choices when the tracker can't hold parent issues. */
export const NO_PARENT_ISSUES_NOTE = "This tracker can't hold parent issues.";

interface FeatureMappingDraft {
  featureMapping: FeatureMapping;
}

function toChanges(saved: FeatureMappingDraft, draft: FeatureMappingDraft): StagedChange[] {
  if (saved.featureMapping === draft.featureMapping) return [];
  return [
    {
      id: "featureMapping",
      label: "Features",
      from: FEATURE_MAPPING_LABELS[saved.featureMapping],
      to: FEATURE_MAPPING_LABELS[draft.featureMapping],
    },
  ];
}

function FeatureMappingForm({
  view,
  isAdmin,
  history,
}: {
  view: TrackerFeatureMappingView;
  isAdmin: boolean;
  history: SettingsHistoryEntry | null;
}) {
  const saved = useMemo<FeatureMappingDraft>(
    () => ({ featureMapping: view.featureMapping }),
    [view.featureMapping],
  );
  const card = useStagedCard<FeatureMappingDraft, TrackerFeatureMappingView>({
    label: "Features",
    saved,
    toChanges,
    conflictMessage: "Another admin changed where features show up while you were editing.",
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/trackers/${encodeURIComponent(view.integrationId)}/feature-mapping`,
          trackerFeatureMappingSchema,
          { body: { featureMapping: draft.featureMapping }, organizationId },
        ),
      applyResult: (result, cache) =>
        cache.set<TrackerFeatureMappingView>(
          connectionKeys(cache.keys).featureMapping(view.integrationId),
          () => result,
          { exact: true },
        ),
    }),
    onDirtyChange: useUnsavedCard("Features", "feature-mapping"),
  });
  const options: RadioListOption<FeatureMapping>[] = FEATURE_MAPPINGS.map((mapping) => ({
    value: mapping,
    label: (
      <>
        <strong>{FEATURE_MAPPING_LABELS[mapping]}</strong>
        <span className="or-connection__note"> {FEATURE_MAPPING_EXPLANATIONS[mapping]}</span>
      </>
    ),
    // A tracker without parent issues keeps features in Omniralph (unless already saved).
    disabled: mapping === "parent-issue" && !view.parentIssues && view.featureMapping !== mapping,
  }));
  const error = card.fieldErrors.featureMapping;

  return (
    <Card
      title="Features"
      titleId="feature-mapping"
      titleAddon={
        <ChangeHistoryPopover section="connection" subject={view.integrationId} latest={history} />
      }
    >
      <p className="or-connection__note">{FEATURE_MAPPING_HELP}</p>
      <RadioList<FeatureMapping>
        label="Show features"
        options={options}
        value={card.draft.featureMapping}
        onValueChange={(value) => card.set("featureMapping", value)}
        disabled={!isAdmin || card.saving}
      />
      {!view.parentIssues ? <p className="or-connection__note">{NO_PARENT_ISSUES_NOTE}</p> : null}
      {error ? <p className="or-field-error">{error}</p> : null}
      {isAdmin ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
          conflict={card.conflict}
        />
      ) : null}
      {card.dialog}
    </Card>
  );
}

/**
 * The tracker connection's "Features" card: whether features exist only in Omniralph or also
 * as a parent issue in the tracker that their epics are filed under, each with a one-line
 * explanation. Admins stage the choice and save it in one `PUT …/feature-mapping`, written
 * into the cache from the answer; members see it read-only. A live query: another admin's
 * save arrives through the connection's `connection` event.
 */
export function FeatureMappingCard({
  integrationId,
  isAdmin,
  history,
}: {
  integrationId: string;
  isAdmin: boolean;
  history: SettingsHistoryEntry | null;
}) {
  const query = useTrackerFeatureMapping(integrationId);
  if (query.isPending) {
    return (
      <Card title="Features" titleId="feature-mapping">
        <p aria-busy="true">Loading…</p>
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card title="Features" titleId="feature-mapping">
        <EmptyState
          headingLevel={3}
          title="Couldn't load the feature setting"
          description={query.error.message}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  }
  return <FeatureMappingForm view={query.data} isAdmin={isAdmin} history={history} />;
}
