import type { ReactNode } from "react";

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

/**
 * What an agent thought and ran, one row per event: its offset from `startedAt`, the action's
 * name or "thinking", and the action's parameter in mono or the thought in prose. An
 * `error` comes last, in coral, as an alert.
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
                    <code className="or-transcript__text or-transcript__param or-mono">
                      {event.parameter}
                    </code>
                  ) : null
                ) : (
                  <p className="or-transcript__text or-transcript__thought">{event.body}</p>
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
