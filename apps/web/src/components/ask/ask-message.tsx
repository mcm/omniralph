"use client";

import type { AskMessageView } from "@/lib/api/ask";
import { AskCard } from "./ask-card";
import type { AskCardActionProps } from "./card-actions";
import { OmMessage } from "./om-message";
import { UserBubble } from "./user-bubble";

export interface AskMessageProps extends AskCardActionProps {
  message: AskMessageView;
  /** What Om is doing while this message streams. */
  status?: string | null;
}

/** One message of a chat: the member's bubble, Om's card, or Om's answer. */
export function AskMessage({ message, status, ...actions }: AskMessageProps) {
  if (message.author === "user") return <UserBubble text={message.markdown} />;
  if (message.card) return <AskCard card={message.card} {...actions} />;
  return <OmMessage message={message} status={status} />;
}
