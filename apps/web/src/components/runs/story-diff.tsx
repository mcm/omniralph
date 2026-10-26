"use client";

import { Button, DiffView } from "@omniralph/ui";
import type { RunDetail, RunStep } from "@/lib/api/runs";
import type { StepPanelTab } from "./step-panel";
import { useStoryDiff } from "./use-story-diff";

/** The step panel's Diff tab (`?tab=diff`). */
export const STEP_PANEL_DIFF = "diff";

/** The failed load of a story's diff, when the server gives no reason. */
export const STORY_DIFF_FAILED = "Couldn't load the diff.";

const PROVIDER_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

/**
 * The story's commit as a diff, loaded when shown: a skeleton while it loads, the server's
 * reason (e.g. "This commit isn't on GitHub yet.") with Retry when it fails.
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
      <p className="or-run-error" role="alert">
        {diff.error.message || STORY_DIFF_FAILED}
        <Button
          variant="outline"
          size="sm"
          disabled={diff.isFetching}
          onClick={() => void diff.refetch()}
        >
          Retry
        </Button>
      </p>
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
