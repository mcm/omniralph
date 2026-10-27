"use client";

import { Button, Card, Markdown } from "@omniralph/ui";
import type { AskCard } from "@/lib/api/ask";
import type { AskCardActionProps } from "./card-actions";
import "./ask-cards.css";

export interface GenericCardProps extends AskCardActionProps {
  card: Extract<AskCard, { kind: "generic" }>;
}

/** Any other card Om posts: its title, its text and its buttons. */
export function GenericCard({ card, onAction, pending, actionError }: GenericCardProps) {
  return (
    <div className="or-ask-card">
      <Card title={card.title} headingLevel={3} className="or-ask-card__card">
        {card.text.trim() ? <Markdown>{card.text}</Markdown> : null}
        {card.actions.length > 0 ? (
          <div className="or-ask-card__actions">
            {card.actions.map((action) => (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => onAction?.({ actionId: action.id, value: action.value })}
              >
                {action.label}
              </Button>
            ))}
          </div>
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
