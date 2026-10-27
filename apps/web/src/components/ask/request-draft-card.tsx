"use client";

import { IconCode } from "@tabler/icons-react";
import { Button, Card, IssueBadge, MetaBadge, RepoBadge, TextLink } from "@omniralph/ui";
import { useState } from "react";
import { TriageNowCheckbox } from "@/components/work-items/triage-now-checkbox";
import { requestDraftAddValue, type RequestDraftView } from "@/lib/api/ask";
import { runHref } from "@/lib/runs/hrefs";
import type { AskCardActionProps } from "./card-actions";
import "./ask-cards.css";

/** The web card's Add to backlog: it sends the Triage now checkbox with the click. */
export const ADD_TO_BACKLOG_ACTION = "request_draft_add";

export interface RequestDraftCardProps extends AskCardActionProps {
  draft: RequestDraftView;
}

/**
 * A request Om drafted, from its `RequestDraftView` (the same model as its Slack and
 * Discord card): the "Request" badge and the repo, the title, then Start request, Add to
 * backlog (with Triage now above the buttons) and Not now while it can be acted on, or what
 * came of it. A click that didn't go through shows its reason in an alert; the buttons stay.
 */
export function RequestDraftCard({ draft, onAction, pending, actionError }: RequestDraftCardProps) {
  const [triageNow, setTriageNow] = useState(true);
  const offersBacklog =
    draft.triageChoice === "inline" && draft.actions.some((a) => a.id === ADD_TO_BACKLOG_ACTION);
  const busy = pending || draft.status === "starting" || draft.status === "adding";
  const error = actionError ?? draft.error;
  return (
    <div className="or-ask-card">
      <Card title={draft.title} headingLevel={3} className="or-ask-card__card">
        <div className="or-ask-card__meta">
          <MetaBadge icon={IconCode} text="Request" />
          {draft.repository ? (
            <RepoBadge host={draft.repository.provider} name={draft.repository.fullPath} />
          ) : null}
        </div>
        {draft.question ? <p className="or-ask-card__question">{draft.question}</p> : null}
        {offersBacklog ? (
          <TriageNowCheckbox checked={triageNow} onChange={setTriageNow} disabled={busy} />
        ) : null}
        {draft.actions.length > 0 ? (
          <div className="or-ask-card__actions">
            {draft.actions.map((action) => (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant={action.style}
                disabled={busy}
                onClick={() =>
                  onAction?.({
                    actionId: action.id,
                    value:
                      action.id === ADD_TO_BACKLOG_ACTION && draft.triageChoice === "inline"
                        ? requestDraftAddValue(draft.id, triageNow)
                        : action.value,
                  })
                }
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
        {draft.outcome ? (
          <p
            className={
              draft.outcome.kind === "dismissed" || draft.outcome.kind === "expired"
                ? "or-ask-card__outcome or-ask-card__outcome--quiet"
                : "or-ask-card__outcome"
            }
          >
            <span>{draft.outcome.text}</span>
            {draft.outcome.run ? (
              <TextLink href={runHref(draft.outcome.run.id)}>Open run</TextLink>
            ) : null}
            {draft.outcome.workItem ? (
              <IssueBadge
                tracker={draft.outcome.workItem.tracker}
                id={draft.outcome.workItem.identifier}
                href={draft.outcome.workItem.url}
              />
            ) : null}
          </p>
        ) : null}
      </Card>
      {error ? (
        <p className="or-ask-card__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
