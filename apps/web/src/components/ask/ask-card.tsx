"use client";

import type { AskCard as AskCardModel } from "@/lib/api/ask";
import type { AskCardActionProps } from "./card-actions";
import { GenericCard } from "./generic-card";
import { LinearIssueDraftCard } from "./linear-issue-draft-card";
import { RequestDraftCard } from "./request-draft-card";

export interface AskCardProps extends AskCardActionProps {
  card: AskCardModel;
}

/** A card in a chat, by its kind. */
export function AskCard({ card, ...actions }: AskCardProps) {
  switch (card.kind) {
    case "request_draft":
      return <RequestDraftCard key={card.draft.id} draft={card.draft} {...actions} />;
    case "tracker_issue_draft":
      return <LinearIssueDraftCard draft={card.draft} {...actions} />;
    case "generic":
      return <GenericCard card={card} {...actions} />;
  }
}
