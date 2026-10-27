"use client";

import { IconArrowUp } from "@tabler/icons-react";
import { IconButton, Textarea } from "@omniralph/ui";
import * as React from "react";
import "./ask-chat.css";

/** The composer grows from this many rows to the most, then scrolls. */
export const COMPOSER_MIN_ROWS = 2;
export const COMPOSER_MAX_ROWS = 8;

/** Rows for `text`: one per line (and per wrapped line, when measured), from 2 to 8. */
export function composerRows(text: string, measuredRows = 0): number {
  const lines = text.split("\n").length;
  return Math.min(COMPOSER_MAX_ROWS, Math.max(COMPOSER_MIN_ROWS, lines, measuredRows));
}

/** How many rows the textarea's content takes, wrapped lines included (0 when unmeasurable). */
function measuredRows(textarea: HTMLTextAreaElement): number {
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
  if (!lineHeight || !textarea.scrollHeight) return 0;
  const previous = textarea.rows;
  textarea.rows = COMPOSER_MIN_ROWS;
  const style = getComputedStyle(textarea);
  const padding =
    (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const rows = Math.round((textarea.scrollHeight - padding) / lineHeight);
  textarea.rows = previous;
  return rows;
}

export interface AskComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Sends the text (never blank, never while `streaming`). */
  onSend: () => void;
  /** A turn is streaming: Send is disabled until it ends. */
  streaming?: boolean;
  placeholder?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Ask's composer, pinned at the bottom of a chat: the "Message" field (2 to 8 rows,
 * growing with the text) and Send. Enter sends, Shift+Enter adds a line; Send is disabled
 * while the text is blank or a turn is streaming.
 */
export function AskComposer({
  value,
  onChange,
  onSend,
  streaming = false,
  placeholder = "Ask a follow-up…",
  textareaRef,
}: AskComposerProps) {
  const id = React.useId();
  const fallback = React.useRef<HTMLTextAreaElement | null>(null);
  const own = textareaRef ?? fallback;
  const [measured, setMeasured] = React.useState(0);
  const canSend = value.trim().length > 0 && !streaming;

  const submit = () => {
    if (canSend) onSend();
  };

  return (
    <form
      className="or-ask-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="or-sr-only">
        Message
      </label>
      <Textarea
        id={id}
        ref={own}
        className="or-ask-composer__input"
        rows={composerRows(value, value ? measured : 0)}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          setMeasured(measuredRows(event.target));
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          submit();
        }}
      />
      <IconButton
        type="submit"
        label="Send"
        icon={IconArrowUp}
        variant="solid"
        disabled={!canSend}
        className="or-ask-composer__send"
      />
    </form>
  );
}
