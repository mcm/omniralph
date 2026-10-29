"use client";

import { DiffView } from "@omniralph/ui";
import { LoadError } from "./load-error";
import type { RunDetail, RunStep } from "@/lib/api/runs";
import type { StepPanelTab } from "./step-panel";
import { useStoryDiff } from "./use-story-diff";

/** The step panel's Diff tab (`?tab=diff`). */
export const STEP_PANEL_DIFF = "diff";

const PROVIDER_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

/**
 * The story's commit as a diff, loaded when shown: a skeleton while it loads, the server's
 * reason (e.g. "Couldn't load the diff. This commit isn't on GitHub yet.") with Reload diff
 * when it fails.
 */
export function StoryDiffView({
  runId,
  stepId,
  commit,
}: {
  runId: string;
  stepId: string;
  commit: string;
}) {
  const diff = useStoryDiff(runId, stepId, commit);
  if (diff.isPending) {
    return (
      <div className="or-step-panel__loading" aria-busy="true" data-testid="diff-skeleton">
        <div className="or-run-skeleton__line" />
        <div className="or-run-skeleton__line or-run-skeleton__line--short" />
      </div>
    );
  }
  if (diff.isError) {
    return (
      <LoadError
        what="diff"
        error={diff.error}
        reloading={diff.isFetching}
        onReload={() => void diff.refetch()}
      />
    );
  }
  const { files, truncated, url, provider } = diff.data;
  return (
    <DiffView
      files={files}
      truncated={truncated}
      url={url}
      urlLabel={`Open on ${PROVIDER_NAMES[provider]}`}
      aria-label="Changed files"
    />
  );
}

/** The Diff tab for an epic story with a commit; none for other steps. */
export function storyDiffTabs(run: RunDetail, step: RunStep): StepPanelTab[] {
  if (run.kind !== "epic" || step.kind !== "story" || !step.commit) return [];
  return [
    {
      value: STEP_PANEL_DIFF,
      label: "Diff",
      content: <StoryDiffView runId={run.id} stepId={step.id} commit={step.commit} />,
    },
  ];
}
