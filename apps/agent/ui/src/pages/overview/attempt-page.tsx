/**
 * An attempt (`/attempts/[id]`): how it stands, its label with the repo and work item, a link
 * to its run in the control panel, its transcript and its log. While it runs, `transcript`
 * events append to the transcript and `logs` events to the log; its `attempts` event when it
 * finishes refetches it, so the status line changes.
 */
import {
  DetailsSection,
  EmptyState,
  StatusLine,
  TextLink,
  Toolbar,
  Transcript,
} from "@omniralph/ui";
import { IconExternalLink } from "@tabler/icons-react";
import type { LogEntry } from "../../../../src/logs/entries.js";
import { LocalApiError } from "../../api.js";
import { useNow } from "../../format.js";
import { AGENT_SECTIONS } from "../../nav.js";
import { useAgentState } from "../../state.js";
import { AgentPage } from "../page.js";
import {
  ATTEMPT_NOT_FOUND,
  NO_LOG_LINES,
  NO_TRANSCRIPT,
  OPEN_RUN,
  TRANSCRIPT_PENDING,
  attemptLog,
  attemptStatus,
  clockTimeSeconds,
  runUrl,
} from "./model.js";
import { AttemptBadges } from "./overview-page.js";
import { useAttempt, useLiveLogTail, type AttemptPageState } from "./queries.js";

const BACK = (
  <TextLink href={AGENT_SECTIONS.overview.href} className="agent-back">
    ‹ Overview
  </TextLink>
);

export function AttemptPage({ id }: { id: string }) {
  const attempt = useAttempt(id);
  if (attempt.data) return <AttemptView attempt={attempt.data} />;
  if (attempt.isError) {
    const missing = attempt.error instanceof LocalApiError && attempt.error.status === 404;
    return (
      <AgentPage title="Attempt">
        {BACK}
        <EmptyState
          title={missing ? ATTEMPT_NOT_FOUND : "Can't load this attempt"}
          {...(!missing && { description: attempt.error.message })}
        />
      </AgentPage>
    );
  }
  return <AgentPage title="Attempt">{BACK}</AgentPage>;
}

function AttemptView({ attempt }: { attempt: AttemptPageState }) {
  const server = useAgentState().data?.agent.server ?? null;
  const now = useNow(1_000);
  const status = attemptStatus(attempt, now);
  const running = attempt.outcome === null;
  const live = useLiveLogTail();
  const log = attemptLog(attempt.id, attempt.log, live);
  return (
    <AgentPage
      title={attempt.label}
      actions={
        attempt.runId !== null && server !== null ? (
          <Toolbar
            label="Attempt actions"
            actions={[
              {
                label: OPEN_RUN,
                icon: IconExternalLink,
                href: runUrl(server, attempt.runId),
                target: "_blank",
                rel: "noreferrer",
              },
            ]}
          />
        ) : undefined
      }
    >
      {BACK}
      <StatusLine tone={status.tone ?? "neutral"}>{status.text}</StatusLine>
      <AttemptBadges attempt={attempt} />
      <section className="agent-attempt__transcript" aria-label="Transcript">
        <Transcript
          events={attempt.events}
          startedAt={attempt.startedAt}
          error={attempt.outcome === "failed" ? attempt.error : null}
        />
        {attempt.events.length === 0 ? (
          <p className="agent-card-description">{running ? TRANSCRIPT_PENDING : NO_TRANSCRIPT}</p>
        ) : null}
      </section>
      <DetailsSection title="Log">
        <AttemptLog lines={log} />
      </DetailsSection>
    </AgentPage>
  );
}

function AttemptLog({ lines }: { lines: LogEntry[] }) {
  if (lines.length === 0) return <p className="agent-card-description">{NO_LOG_LINES}</p>;
  return (
    <ol className="agent-log or-mono" aria-label="Log">
      {lines.map((line, index) => (
        <li key={index} className={`agent-log__line agent-log__line--${line.level}`}>
          <time className="agent-log__time" dateTime={new Date(line.time).toISOString()}>
            {clockTimeSeconds(line.time)}
          </time>
          <span className="agent-log__level">{line.level}</span>
          <span className="agent-log__msg">{line.msg}</span>
        </li>
      ))}
    </ol>
  );
}
