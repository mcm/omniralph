import "./ask-messages.css";

export interface UserBubbleProps {
  /** What the member wrote, shown as written (line breaks kept). */
  text: string;
}

/** A member's message: a right-aligned bubble. */
export function UserBubble({ text }: UserBubbleProps) {
  return (
    <div className="or-ask-user">
      <p className="or-ask-user__bubble">{text}</p>
    </div>
  );
}
