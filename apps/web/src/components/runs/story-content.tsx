"use client";

import { Button, Markdown } from "@omniralph/ui";
import { useWorkItemDetail } from "@/components/work-items/use-work-item-detail";
import type { RunDetail, RunStep } from "@/lib/api/runs";
import type { WorkItemDetail } from "@/lib/api/work-items";
import type { StepPanelTab } from "./step-panel";

/** The step panel's Story tab (`?tab=story`). */
export const STEP_PANEL_STORY = "story";

/** The failed load of the work item the story is read from. */
export const STORY_CONTENT_FAILED = "Couldn't load the story.";

/** A story with no content, or one the work item doesn't list. */
export const STORY_CONTENT_EMPTY = "This story has no content.";

/**
 * The story `identifier` names in the work item's detail: the listed story's content, or, for
 * a single-issue run whose only step is the work item itself, the work item's description.
 * Empty when neither is found.
 */
export function storyContentOf(detail: WorkItemDetail, identifier: string): string {
  const story = detail.stories.find((entry) => entry.identifier === identifier);
  if (story) return story.content;
  return detail.identifier === identifier ? detail.description : "";
}

/**
 * The story's content as Markdown, read from the work item's detail (the query View PRD
 * shares), loaded when shown: a skeleton while it loads, Retry when it fails.
 */
export function StoryContentView({
  workItemId,
  identifier,
}: {
  workItemId: string;
  identifier: string;
}) {
  const detail = useWorkItemDetail(workItemId);
  if (detail.isPending) {
    return (
      <div className="or-step-panel__loading" aria-busy="true" data-testid="story-skeleton">
        <div className="or-run-skeleton__line" />
        <div className="or-run-skeleton__line or-run-skeleton__line--short" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <p className="or-run-error" role="alert">
        {STORY_CONTENT_FAILED}
        <Button
          variant="outline"
          size="sm"
          disabled={detail.isFetching}
          onClick={() => void detail.refetch()}
        >
          Retry
        </Button>
      </p>
    );
  }
  const content = storyContentOf(detail.data, identifier);
  if (!content.trim()) return <p className="or-step-panel__empty">{STORY_CONTENT_EMPTY}</p>;
  return <Markdown>{content}</Markdown>;
}

/** The Story tab for an epic run's story with a work item; none for other steps. */
export function storyContentTabs(run: RunDetail, step: RunStep): StepPanelTab[] {
  if (run.kind !== "epic" || step.kind !== "story" || !run.workItem) return [];
  return [
    {
      value: STEP_PANEL_STORY,
      label: "Story",
      content: (
        <StoryContentView workItemId={run.workItem.id} identifier={step.workItem.identifier} />
      ),
    },
  ];
}
