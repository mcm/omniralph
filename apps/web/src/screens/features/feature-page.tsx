"use client";

import { Button, EmptyState, MetaBadge, StatusText, TabPanel, Tabs } from "@omniralph/ui";
import { IconArchive, IconArchiveOff } from "@tabler/icons-react";
import { useCurrentUser } from "@/components/current-user";
import { ApiError } from "@/lib/api/client";
import type { FeatureRow } from "@/lib/api/features";
import { AttachmentsPanel } from "./attachments-panel";
import { DocumentEditor } from "./document-editor";
import { epicCount, FEATURE_DOCUMENTS, FEATURE_STATUS, FEATURES_PATH } from "./feature-status";
import { useArchiveFeature } from "./mutations";
import { useFeature } from "./queries";
import { ShardPanel } from "./shard-review";

export const FEATURE_NOT_FOUND = "That feature doesn't exist";
export const FEATURE_LOAD_FAILED = "Couldn't load the feature";
export const LOADING_FEATURE = "Loading the feature…";
export const READ_ONLY_MEMBER = "Only admins can change features.";
export const ARCHIVED_NOTE = "This feature is archived. Restore it to change it.";

function FeatureSkeleton() {
  return (
    <div className="or-feature" role="status" data-testid="feature-skeleton">
      <span className="or-sr-only">{LOADING_FEATURE}</span>
      <div aria-hidden="true">
        <div className="or-feature-skeleton__line or-feature-skeleton__line--title" />
        <div className="or-feature-skeleton__line or-feature-skeleton__line--short" />
        {[0, 1, 2].map((index) => (
          <div key={index} className="or-feature-skeleton__row" />
        ))}
      </div>
    </div>
  );
}

export interface FeatureDetailViewProps {
  featureId: string;
  /** Overrides the documents' autosave delay (tests). */
  autosaveDelay?: number;
}

/**
 * One feature beside the Features list: a skeleton while it loads, "That feature doesn't
 * exist" for an unknown ID, a retry when it can't load, else the feature. A live query.
 */
export function FeatureDetailView({ featureId, autosaveDelay }: FeatureDetailViewProps) {
  const feature = useFeature(featureId);
  if (feature.isPending) return <FeatureSkeleton />;
  if (feature.isError) {
    if (feature.error instanceof ApiError && feature.error.status === 404) {
      return (
        <EmptyState
          className="or-feature__empty"
          title={FEATURE_NOT_FOUND}
          action={
            <Button variant="outline" href={FEATURES_PATH}>
              Back to Features
            </Button>
          }
        />
      );
    }
    return (
      <EmptyState
        className="or-feature__empty"
        title={FEATURE_LOAD_FAILED}
        description={feature.error.message}
        action={
          <Button variant="outline" onClick={() => void feature.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return <FeaturePage feature={feature.data} autosaveDelay={autosaveDelay} />;
}

/**
 * A feature: its name, status, repo and epic count; its PRFAQ and Plan, one tab each (kept
 * mounted, so an edit survives switching); its attachments; and its epics, sharded from the
 * Plan and reviewed before they are filed (`ShardPanel`). Admins edit everything and
 * archive or restore it; members read. An archived feature reads only until restored.
 */
function FeaturePage({ feature, autosaveDelay }: { feature: FeatureRow; autosaveDelay?: number }) {
  const admin = useCurrentUser().role === "admin";
  const archive = useArchiveFeature(feature);
  const archived = feature.status === "archived";
  const editable = admin && !archived;
  const status = FEATURE_STATUS[feature.status];

  return (
    <article className="or-feature" aria-label={feature.name}>
      <header className="or-feature__head">
        <div className="or-feature__title-row">
          <h2 className="or-feature__title">{feature.name}</h2>
          {admin ? (
            <Button
              variant="outline"
              size="sm"
              icon={archived ? IconArchiveOff : IconArchive}
              disabled={archive.isPending}
              onClick={() => archive.mutate(!archived)}
            >
              {archived ? "Restore" : "Archive"}
            </Button>
          ) : null}
        </div>
        <div className="or-feature__badges">
          <StatusText tone={status.tone}>{status.label}</StatusText>
          {feature.repository ? <MetaBadge text={feature.repository.fullPath} mono /> : null}
          <MetaBadge text={epicCount(feature.epicCount)} />
        </div>
      </header>

      {archived ? (
        <p className="or-feature__note">{ARCHIVED_NOTE}</p>
      ) : !admin ? (
        <p className="or-feature__note">{READ_ONLY_MEMBER}</p>
      ) : null}

      <Tabs
        aria-label="Documents"
        tabs={FEATURE_DOCUMENTS.map(({ kind, label }) => ({ value: kind, label }))}
        defaultValue="prfaq"
      >
        {FEATURE_DOCUMENTS.map(({ kind }) => (
          <TabPanel key={kind} value={kind} keepMounted>
            <DocumentEditor
              featureId={feature.id}
              kind={kind}
              editable={editable}
              autosaveDelay={autosaveDelay}
            />
          </TabPanel>
        ))}
      </Tabs>

      <AttachmentsPanel featureId={feature.id} editable={editable} />

      <ShardPanel feature={feature} editable={editable} />
    </article>
  );
}
