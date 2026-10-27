/** A click on a card's button, as `POST /api/ui/ask/chats/{id}/actions` takes it (with the message ID). */
export interface AskCardClick {
  actionId: string;
  value: string | null;
}

/** What every card component takes to act: the click handler and whether a click is in flight. */
export interface AskCardActionProps {
  /** Sends a click; the chat view posts it and applies the returned message. */
  onAction?: (click: AskCardClick) => void;
  /** A click is in flight: the buttons are disabled. */
  pending?: boolean;
  /** Why the last click couldn't be sent (e.g. the network failed); shown under the card. */
  actionError?: string | null;
}
