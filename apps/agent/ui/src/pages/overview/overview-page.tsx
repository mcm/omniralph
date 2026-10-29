/**
 * Overview (`/`, and `/overview` from the nav): a problem line only when something is wrong,
 * the summary (slots, version, Claude, disk), what runs now and the last finished attempts.
 * `attempts` events refetch the lists, so an attempt moves from Running now to Recent work
 * as it finishes; the summary follows `/api/state`.
 */
import {
  ActivityList,
  Card,
  EmptyState,
  IssueBadge,
  MetaBadge,
  RepoBadge,
  StatusLine,
  StatusText,
  SummaryCells,
  TextLink,
  type ActivityEntry,
} from "@omniralph/ui";
import type { AttemptRecord } from "../../../../src/attempts/history.js";
import { useNow } from "../../format.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import {
  NOTHING_RUNNING,
  NO_RECENT_WORK,
  attemptElapsed,
  claudeCell,
  diskCell,
  overviewProblem,
  slotsText,
  versionDetail,
  type Sentence,
} from "./model.js";
import { useAttempts } from "./queries.js";

export function attemptHref(id: string): string {
  return `/attempts/${encodeURIComponent(id)}`;
}

function toned({ text, tone }: Sentence) {
  return tone ? <StatusText tone={tone}>{text}</StatusText> : text;
}

export function OverviewPage() {
  const state = useAgentState().data;
  const problem = state ? overviewProblem(state) : null;
  return (
    <AgentPage title="Overview">
      {problem ? <StatusLine tone={problem.tone ?? "neutral"}>{problem.text}</StatusLine> : null}
      {state ? <Summary state={state} /> : null}
      <Attempts />
    </AgentPage>
  );
}

function Summary({ state }: { state: AgentUiState }) {
  const version = versionDetail(state);
  const claude = claudeCell(state.claude);
  const disk = diskCell(state.filesystems);
  return (
    <SummaryCells
      aria-label="Summary"
      cells={[
        { id: "slots", label: "Slots", value: slotsText(state) },
        {
          id: "version",
          label: "Version",
          value: <MetaBadge text={state.agent.version} mono />,
          detail: toned(version),
        },
        {
          id: "claude",
          label: "Claude",
          value: toned(claude),
          ...(claude.detail !== undefined && { detail: claude.detail }),
        },
        {
          id: "disk",
          label: "Disk",
          value: toned(disk),
          ...(disk.detail !== undefined && { detail: disk.detail }),
        },
      ]}
    />
  );
}

/** The repo and work item an attempt is about, as badges. */
export function AttemptBadges({ attempt }: { attempt: AttemptRecord }) {
  const items = [...new Set([attempt.workItem, attempt.story])].filter(
    (item): item is string => item !== null,
  );
  if (!attempt.repo && items.length === 0) return null;
  return (
    <span className="agent-attempt__badges">
      {attempt.repo ? (
        <RepoBadge host={attempt.repo.provider} name={attempt.repo.fullPath} />
      ) : null}
      {items.map((item) => (
        <IssueBadge key={item} tracker="linear" id={item} />
      ))}
    </span>
  );
}

function Attempts() {
  const attempts = useAttempts();
  if (attempts.isError) {
    return <EmptyState title="Can't load the attempts" description={attempts.error.message} />;
  }
  if (!attempts.data) return null;
  return (
    <>
      <RunningNow running={attempts.data.running} />
      <RecentWork recent={attempts.data.recent} />
    </>
  );
}

function RunningNow({ running }: { running: AttemptRecord[] }) {
  const now = useNow(1_000);
  return (
    <Card title="Running now">
      {running.length === 0 ? (
        <EmptyState title={NOTHING_RUNNING} headingLevel={3} />
      ) : (
        <ul className="agent-attempts" aria-label="Running now">
          {running.map((attempt) => (
            <li key={attempt.id} className="agent-attempt">
              <TextLink href={attemptHref(attempt.id)} className="agent-attempt__label">
                {attempt.label}
              </TextLink>
              <AttemptBadges attempt={attempt} />
              <span className="agent-attempt__elapsed or-mono">{attemptElapsed(attempt, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentWork({ recent }: { recent: AttemptRecord[] }) {
  const entries: ActivityEntry[] = recent.map((attempt) => ({
    id: attempt.id,
    at: attempt.finishedAt ?? attempt.startedAt,
    text: (
      <TextLink href={attemptHref(attempt.id)}>
        {attempt.outcome === "failed" ? (
          <StatusText tone="fail">{attempt.label}</StatusText>
        ) : (
          attempt.label
        )}
      </TextLink>
    ),
  }));
  return (
    <Card title="Recent work">
      {entries.length === 0 ? (
        <EmptyState title={NO_RECENT_WORK} headingLevel={3} />
      ) : (
        <ActivityList aria-label="Recent work" entries={entries} />
      )}
    </Card>
  );
}
