"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "../actions/button.js";

/** One thing an agent did while it worked: a thought (its text) or an action (a tool call). */
export interface TranscriptEvent {
  /** Keys the row; defaults to its position. */
  id?: string;
  type: "thought" | "action";
  /** A thought's text, or an action's name. */
  body: string;
  /** An action's parameter (e.g. the command); null for thoughts. */
  parameter: string | null;
  /** When it happened (a `Date` or an ISO timestamp). */
  at: Date | string;
}

export interface TranscriptProps {
  /** Oldest first. */
  events: readonly TranscriptEvent[];
  /** When the attempt started: each row shows its offset from it. */
  startedAt: Date | string;
  /** Why the attempt failed: shown last, in coral, as an alert. */
  error?: string | null;
  /** Shown after the rows, before the error (e.g. "12 more events · Show all"). */
  more?: ReactNode;
  /** Names the list. Defaults to "Transcript". */
  "aria-label"?: string;
  className?: string;
}

const toTime = (at: Date | string) => (typeof at === "string" ? new Date(at) : at).getTime();
const pad = (value: number) => String(value).padStart(2, "0");

/** An event's offset from the start: "m:ss", or "h:mm:ss" from an hour ("0:00" before it). */
export function transcriptOffset(at: Date | string, startedAt: Date | string): string {
  const ms = toTime(at) - toTime(startedAt);
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Lines of a long parameter or thought shown before "View more". */
export const TRANSCRIPT_PREVIEW_LINES = 4;

/**
 * The first {@link TRANSCRIPT_PREVIEW_LINES} lines of a text longer than that, or null when it
 * is short enough to show whole. One line past the preview shows whole too: a "View more"
 * that reveals a single line saves nothing.
 */
export function transcriptPreview(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length <= TRANSCRIPT_PREVIEW_LINES + 1) return null;
  return lines.slice(0, TRANSCRIPT_PREVIEW_LINES).join("\n");
}

/**
 * An action's parameter (mono) or a thought (prose). Past the preview it shows its first
 * lines and "View more", which shows it whole, untruncated, until "View less".
 */
function TranscriptText({ text, kind }: { text: string; kind: "param" | "thought" }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const preview = transcriptPreview(text);
  const Tag = kind === "param" ? "code" : "p";
  const className = kind === "param" ? "or-transcript__param or-mono" : "or-transcript__thought";
  if (preview === null) {
    return <Tag className={`or-transcript__text ${className}`}>{text}</Tag>;
  }
  return (
    <div className="or-transcript__text or-transcript__fold">
      <Tag id={id} className={className}>
        {expanded ? text : preview}
      </Tag>
      <Button
        variant="ghost"
        size="sm"
        className="or-transcript__toggle"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? "View less" : "View more"}
      </Button>
    </div>
  );
}

/**
 * What an agent thought and ran, one row per event: its offset from `startedAt`, the action's
 * name or "thinking", and the action's parameter in mono or the thought in prose (past
 * {@link TRANSCRIPT_PREVIEW_LINES} lines, its first lines and "View more"). An `error` comes
 * last, in coral, as an alert.
 */
export function Transcript({
  events,
  startedAt,
  error,
  more,
  "aria-label": label = "Transcript",
  className,
}: TranscriptProps) {
  return (
    <div className={["or-transcript", className].filter(Boolean).join(" ")}>
      {events.length > 0 ? (
        <ol className="or-transcript__list" aria-label={label}>
          {events.map((event, index) => {
            const date = typeof event.at === "string" ? event.at : event.at.toISOString();
            const action = event.type === "action";
            return (
              <li
                key={event.id ?? index}
                className={`or-transcript__row or-transcript__row--${event.type}`}
              >
                <time className="or-transcript__time or-mono" dateTime={date}>
                  {transcriptOffset(event.at, startedAt)}
                </time>
                <span className="or-transcript__name">{action ? event.body : "thinking"}</span>
                {action ? (
                  event.parameter ? (
                    <TranscriptText text={event.parameter} kind="param" />
                  ) : null
                ) : (
                  <TranscriptText text={event.body} kind="thought" />
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
      {more}
      {error ? (
        <pre className="or-transcript__error or-mono" role="alert">
          {error}
        </pre>
      ) : null}
    </div>
  );
}
