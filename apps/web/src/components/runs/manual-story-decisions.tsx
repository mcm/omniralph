"use client";

import { IssueBadge } from "@omniralph/ui";
import type { RunDetail } from "@/lib/api/runs";
import { useInboxFeed } from "@/screens/inbox/queries";
import { DecisionButtons } from "./decision-buttons";
import { RunReason } from "./run-reason";
import "./manual-story-decisions.css";

/** Whether the run is an epic with a manual story (a step waiting on a person). */
export function hasManualStory(run: Pick<RunDetail, "kind" | "steps">): boolean {
  return (
    run.kind === "epic" &&
    run.steps.some((step) => step.kind === "story" && step.status === "manual")
  );
}

/**
 * An epic's manual stories with the decisions their Inbox items offer (Design rule 6: the
 * same `DecisionButtons` as the Inbox): each story's badge and title, why it waits (unless
 * the run's own reason already says so), then Done, resume epic (Mark story done while the
 * epic still runs), Skip story and Snooze. The items come from the live Needs you feed, so a
 * decision made here or in the Inbox clears both. Nothing for a run without one.
 */
export function ManualStoryDecisions({ run }: { run: RunDetail }) {
  if (!hasManualStory(run)) return null;
  return <Decisions run={run} />;
}

function Decisions({ run }: { run: RunDetail }) {
  const feed = useInboxFeed("needs-you");
  const items = (feed.data?.items ?? []).filter(
    (item) => item.kind === "manual_story" && item.run?.id === run.id,
  );
  return items.map((item) => (
    <section
      key={item.key}
      className="or-story-decision"
      aria-label={`${item.workItem?.identifier ?? "Manual story"}: ${item.title}`}
    >
      <p className="or-story-decision__story">
        {item.workItem ? (
          <IssueBadge
            tracker="linear"
            id={item.workItem.identifier}
            href={item.workItem.url ?? undefined}
          />
        ) : null}
        <span className="or-story-decision__title">{item.title}</span>
      </p>
      {item.reason !== run.reason ? (
        <RunReason
          className="or-story-decision__reason"
          reason={item.reason}
          link={item.reasonLink}
        />
      ) : null}
      <DecisionButtons item={item} />
    </section>
  ));
}
