"use client";

import { Button, Card, IssueBadge, Markdown, MetaBadge, type ButtonVariant } from "@omniralph/ui";
import type { AskWorkItemDraft } from "@/lib/api/ask";
import { trackerLabel } from "@/lib/api/trackers";
import type { AskCardActionProps } from "./card-actions";
import "./ask-cards.css";

/**
 * The card's buttons, as the chat's issue draft names them (`lib/chat/issue-draft.ts`; the
 * IDs are kept as they were, since posted cards carry them).
 */
const BUTTON_VARIANTS: Record<string, ButtonVariant> = {
  linear_issue_create: "solid",
  linear_issue_create_delegate: "outline",
  linear_issue_cancel: "ghost",
};

export interface WorkItemDraftCardProps extends AskCardActionProps {
  draft: AskWorkItemDraft;
}

/** What came of a draft that can't be acted on anymore, else null. */
function outcomeText(draft: AskWorkItemDraft): string | null {
  switch (draft.status) {
    case "created":
      return `Created in ${trackerLabel(draft.tracker)}`;
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "This draft expired";
    case "creating":
      return `Creating the work item in ${trackerLabel(draft.tracker)}`;
    case "pending":
      return null;
  }
}

/**
 * A work item Om drafted, labelled with its tracker's name ("<tracker> work item"): its title, team, project, labels,
 * priority, screenshots and description preview, with Create, Create and delegate and
 * Cancel while it's pending, then what came of it (the created work item's badge,
 * Cancelled, or expired), as Slack's card shows it.
 */
export function WorkItemDraftCard({
  draft,
  onAction,
  pending,
  actionError,
}: WorkItemDraftCardProps) {
  const outcome = outcomeText(draft);
  const facts = [
    { label: "Project", value: draft.project },
    { label: "Priority", value: draft.priority },
    { label: "Screenshots", value: draft.screenshots.join(", ") || null },
  ].filter((fact): fact is { label: string; value: string } => !!fact.value);
  return (
    <div className="or-ask-card">
      <Card title={draft.title} headingLevel={3} className="or-ask-card__card">
        <div className="or-ask-card__meta">
          <MetaBadge text={`${trackerLabel(draft.tracker)} work item`} />
          <MetaBadge text={draft.team} mono />
          {draft.labels.map((label) => (
            <MetaBadge key={label} text={label} />
          ))}
        </div>
        {facts.length > 0 ? (
          <dl className="or-ask-card__facts">
            {facts.map((fact) => (
              <div key={fact.label} className="or-ask-card__fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <Markdown className="or-ask-card__preview">{draft.description}</Markdown>
        {draft.actions.length > 0 ? (
          <div className="or-ask-card__actions">
            {draft.actions.map((action) => (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant={BUTTON_VARIANTS[action.id] ?? "outline"}
                disabled={pending}
                onClick={() => onAction?.({ actionId: action.id, value: action.value })}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
        {outcome ? (
          <p
            className={
              draft.status === "created"
                ? "or-ask-card__outcome"
                : "or-ask-card__outcome or-ask-card__outcome--quiet"
            }
          >
            <span>{outcome}</span>
            {draft.status === "created" && draft.issue ? (
              <IssueBadge
                tracker={draft.tracker}
                id={draft.issue.identifier}
                href={draft.issue.url ?? undefined}
              />
            ) : null}
          </p>
        ) : null}
      </Card>
      {actionError ? (
        <p className="or-ask-card__error" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
