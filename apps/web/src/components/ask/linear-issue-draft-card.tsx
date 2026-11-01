"use client";

import { Button, Card, IssueBadge, Markdown, MetaBadge, type ButtonVariant } from "@omniralph/ui";
import type { AskLinearIssueDraft } from "@/lib/api/ask";
import type { AskCardActionProps } from "./card-actions";
import "./ask-cards.css";

/** The card's buttons, as the chat's Linear issue draft names them (`lib/chat/issue-draft.ts`). */
const BUTTON_VARIANTS: Record<string, ButtonVariant> = {
  linear_issue_create: "solid",
  linear_issue_create_delegate: "outline",
  linear_issue_cancel: "ghost",
};

export interface LinearIssueDraftCardProps extends AskCardActionProps {
  draft: AskLinearIssueDraft;
}

/** What came of a draft that can't be acted on anymore, else null. */
function outcomeText(draft: AskLinearIssueDraft): string | null {
  switch (draft.status) {
    case "created":
      return "Created";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "This draft expired";
    case "creating":
      return "Creating the work item";
    case "pending":
      return null;
  }
}

/**
 * A Linear issue Om drafted (`draft_linear_issue`): its title, team, project, labels,
 * priority, screenshots and description preview, with Create, Create and delegate and
 * Cancel while it's pending, then what came of it (the created work item's badge,
 * Cancelled, or expired), as Slack's card shows it.
 */
export function LinearIssueDraftCard({
  draft,
  onAction,
  pending,
  actionError,
}: LinearIssueDraftCardProps) {
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
          <MetaBadge text="Work item" />
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
                tracker="linear"
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
