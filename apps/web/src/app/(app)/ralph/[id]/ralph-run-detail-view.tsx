"use client";

import * as React from "react";
import Link from "next/link";
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  InlineCode,
  Muted,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import {
  IconAlertTriangle,
  IconClockPause,
  IconExternalLink,
  IconPlayerStop,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Fact, FactStrip } from "@/components/fact-strip";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { RalphRunStatusBadge, RalphStoryStatusBadge } from "@/components/ralph-badges";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import { jobPageHref, shortJobId } from "@/lib/jobs/list";
import {
  linearIssueUrl,
  ralphRunFailure,
  RUN_KIND_DESCRIPTIONS,
  RUN_KIND_LABELS,
  RALPH_MESSAGE_STATE_LABELS,
  roundsLabel,
  runSourceLabel,
  shortSha,
  STOPPABLE_RALPH_RUN_STATUSES,
  truncate,
  type RalphRunDetailView as RalphRunDetail,
} from "@/lib/ralph/display";
import { JOB_STATUS_VARIANTS, RALPH_MESSAGE_STATE_VARIANTS } from "@/lib/state-variants";
import { ProviderIcon } from "../../repositories/repositories-view";
import { stopRalphRun } from "../actions";
import {
  AgentName,
  LinearIssueLink,
  LinearNotConnected,
  PullRequestLink,
} from "../ralph-runs-view";

const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const stack = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
/** Characters of a story's last feedback shown in the table (all of it on hover). */
const FEEDBACK_PREVIEW = 120;
/** Characters of a request or message shown in the tables (all of it on hover). */
const MESSAGE_PREVIEW = 240;

function IssueRef({
  identifier,
  title,
  runUrl,
}: {
  identifier: string;
  title: string;
  runUrl: string | null;
}) {
  return (
    <LinearIssueLink
      identifier={identifier}
      title={title}
      url={linearIssueUrl(runUrl, identifier)}
    />
  );
}

function WaitingOn({ run }: { run: RalphRunDetail }) {
  const waitingOn = run.waitingOn;
  if (!waitingOn || (waitingOn.blockers.length === 0 && waitingOn.manual.length === 0)) {
    return null;
  }
  const list = (items: { identifier: string; title: string }[]) => (
    <ul style={{ margin: 0, paddingLeft: "var(--space-6)", ...stack, gap: "var(--space-1)" }}>
      {items.map((item) => (
        <li key={item.identifier}>
          <IssueRef identifier={item.identifier} title={item.title} runUrl={run.linearUrl} />
        </li>
      ))}
    </ul>
  );
  return (
    <Alert variant="warning">
      <IconClockPause size={16} />
      <AlertTitle as="h2">Waiting</AlertTitle>
      <AlertDescription style={stack}>
        {waitingOn.blockers.length > 0 && (
          <div style={stack}>
            <span>Open blockers outside the epic:</span>
            {list(waitingOn.blockers)}
          </div>
        )}
        {waitingOn.manual.length > 0 && (
          <div style={stack}>
            <span>Manual stories a person has to finish:</span>
            {list(waitingOn.manual)}
          </div>
        )}
        <span>The run resumes by itself when these are completed in Linear.</span>
      </AlertDescription>
    </Alert>
  );
}

function StopRunButton({ run }: { run: RalphRunDetail }) {
  const { pending, run: runAction } = useAction();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="danger" disabled={pending}>
          <IconPlayerStop size={14} />
          Stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop the run of {runSourceLabel(run)}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its queued or running job is canceled (a running job stops after its agent&apos;s next
            heartbeat) and the Linear agent session is told. Finished stories stay done; reply with
            guidance in the agent session to resume the run.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction
            variant="danger"
            onClick={() => runAction(() => stopRalphRun(run.id), "Run stopped")}
          >
            Stop run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type RalphStoryRow = RalphRunDetail["stories"][number];
type RalphLane = RalphRunDetail["lanes"][number];

function StoriesTable({ run, stories }: { run: RalphRunDetail; stories: RalphStoryRow[] }) {
  return (
    <Table className="list-table">
      <TableHeader>
        <TableRow>
          <TableHead>Story</TableHead>
          <TableHead className={WIDE_COLUMN}>Status</TableHead>
          <TableHead className={WIDE_COLUMN}>Attempts</TableHead>
          <TableHead className={WIDE_COLUMN}>Commit</TableHead>
          <TableHead className={WIDE_COLUMN}>Last feedback</TableHead>
          <TableHead className={WIDE_COLUMN}>Last job</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stories.map((story) => (
          <TableRow key={story.id}>
            <TableCell>
              <IssueRef identifier={story.identifier} title={story.title} runUrl={run.linearUrl} />
              <PhoneMeta>
                <RalphStoryStatusBadge status={story.status} />
                <span className="list-time text-numeric">
                  {story.attempts} {story.attempts === 1 ? "attempt" : "attempts"}
                </span>
                {story.lastJobId && (
                  <JobLink id={story.lastJobId} label={shortJobId(story.lastJobId)} />
                )}
              </PhoneMeta>
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <RalphStoryStatusBadge status={story.status} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <span style={cellText}>{story.attempts}</span>
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              {story.commitSha ? (
                <InlineCode title={story.commitSha}>{shortSha(story.commitSha)}</InlineCode>
              ) : (
                <Muted>—</Muted>
              )}
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              {story.lastFeedback ? (
                <Muted
                  title={story.lastFeedback}
                  style={{ maxWidth: "calc(var(--space-8) * 12)", overflowWrap: "anywhere" }}
                >
                  {truncate(story.lastFeedback, FEEDBACK_PREVIEW)}
                </Muted>
              ) : (
                <Muted>—</Muted>
              )}
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              {story.lastJobId ? (
                <Link
                  href={jobPageHref(story.lastJobId)}
                  style={{ ...mono, color: "var(--text-accent)", textDecoration: "none" }}
                >
                  {shortJobId(story.lastJobId)}
                </Link>
              ) : (
                <Muted>—</Muted>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The stories of a lane: its own, plus (main lane) those without a lane that aren't elsewhere. */
function laneStories(run: RalphRunDetail, lane: RalphLane): RalphStoryRow[] {
  const known = new Set(run.lanes.map((l) => l.id));
  return run.stories.filter((s) =>
    s.laneId && known.has(s.laneId) ? s.laneId === lane.id : lane.main && !s.elsewhere,
  );
}

function LaneCard({ run, lane }: { run: RalphRunDetail; lane: RalphLane }) {
  const stories = laneStories(run, lane);
  const done = stories.filter((s) => s.status === "completed").length;
  // With one repository the fact strip already shows it, its branch and its PR/MR.
  const single = run.lanes.length === 1;
  const rounds = (
    <>
      {done} of {stories.length} {stories.length === 1 ? "story" : "stories"} done
      {" · "}
      Review rounds {roundsLabel(lane.reviewRounds)}
      {" · "}
      CI fix rounds {roundsLabel(lane.ciFixRounds)}
      {lane.cleanup ? ` · ${lane.cleanup}` : null}
    </>
  );
  return (
    <Card>
      <CardHeader>
        {single ? (
          <CardTitle as="h2">Stories</CardTitle>
        ) : (
          <CardTitle as="h2" className="run-lane-title">
            <ProviderIcon provider={lane.repository.provider} />
            <span className="fact-mono">{lane.repository.fullPath}</span>
            {lane.main ? <Badge variant="neutral">Main</Badge> : null}
          </CardTitle>
        )}
        <CardDescription>
          {!single && (
            <>
              <InlineCode>{lane.branch}</InlineCode> from{" "}
              {lane.baseBranch ? <InlineCode>{lane.baseBranch}</InlineCode> : "—"}
              {" · "}
              {lane.repository.provider === "gitlab" ? "Merge request" : "Pull request"}{" "}
              {/* Not <PullRequestLink>: its empty state is a <p>, invalid inside this <p>. */}
              {lane.pullRequest ? <PullRequestLink pullRequest={lane.pullRequest} /> : "—"}
              {" · "}
            </>
          )}
          {rounds}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {stories.length === 0 ? (
          <Muted>No stories in this repository yet.</Muted>
        ) : (
          <StoriesTable run={run} stories={stories} />
        )}
      </CardContent>
    </Card>
  );
}

/** Stories that belong in a repository Omniralph doesn't have: manual steps for a person. */
function ElsewhereCard({ run }: { run: RalphRunDetail }) {
  const stories = run.stories.filter((s) => s.elsewhere);
  if (stories.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Not in a repository here</CardTitle>
        <CardDescription>
          Treated like manual steps: nothing is run for them, and stories that depend on them wait
          until a person finishes them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul style={{ margin: 0, paddingLeft: "var(--space-6)", ...stack }}>
          {stories.map((story) => (
            <li key={story.id} style={{ fontSize: "var(--text-sm)" }}>
              <IssueRef identifier={story.identifier} title={story.title} runUrl={run.linearUrl} />{" "}
              <Muted>({story.elsewhere})</Muted>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** One section per lane (repository), or a single stories table before the run has one. */
function StoriesCard({ run }: { run: RalphRunDetail }) {
  if (run.lanes.length > 0) {
    return (
      <>
        {run.lanes.map((lane) => (
          <LaneCard key={lane.id} run={run} lane={lane} />
        ))}
        <ElsewhereCard run={run} />
      </>
    );
  }
  // Without stories, the page's line of empty sections says so.
  if (run.stories.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Stories</CardTitle>
        <CardDescription>
          {run.storyCounts.completed} of {run.storyCounts.total} done, in sub-issue order.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StoriesTable run={run} stories={run.stories} />
      </CardContent>
    </Card>
  );
}

/** The repository a request or message is for (null lane: the main lane's). */
function laneRepository(run: RalphRunDetail, laneId: string | null): string | null {
  const lane = run.lanes.find((l) => (laneId ? l.id === laneId : l.main));
  return lane?.repository.fullPath ?? run.repository?.fullPath ?? null;
}

const textCell: React.CSSProperties = {
  ...cellText,
  display: "block",
  maxWidth: "calc(var(--space-8) * 16)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

function JobLink({ id, label }: { id: string; label: string }) {
  return (
    <Link
      href={jobPageHref(id)}
      style={{ ...mono, color: "var(--text-accent)", textDecoration: "none" }}
    >
      {label}
    </Link>
  );
}

/** Requests the run hasn't handled yet, per lane (repository). */
function PendingRequestsCard({ run }: { run: RalphRunDetail }) {
  const multiLane = run.lanes.length > 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Pending requests</CardTitle>
        <CardDescription>
          Requests from Linear, review findings, <InlineCode>@bot</InlineCode> comments and failed
          CI that the run hasn&apos;t handled yet. They run as request jobs when no story runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              {multiLane && <TableHead className={WIDE_COLUMN}>Repository</TableHead>}
              <TableHead>Request</TableHead>
              <TableHead className={WIDE_COLUMN}>Author</TableHead>
              <TableHead className={WIDE_COLUMN}>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.pendingRequests.map((request) => (
              <TableRow key={request.id}>
                {multiLane && (
                  <TableCell className={WIDE_COLUMN}>
                    <span style={mono}>{laneRepository(run, request.laneId) ?? "—"}</span>
                  </TableCell>
                )}
                <TableCell>
                  <span style={textCell} title={request.text}>
                    {truncate(request.text, MESSAGE_PREVIEW)}
                  </span>
                  <PhoneMeta>
                    {request.author && <span className="list-time">{request.author}</span>}
                    <Timestamp iso={request.createdAt} />
                  </PhoneMeta>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  {request.author ? (
                    <span style={cellText}>{request.author}</span>
                  ) : (
                    <Muted>—</Muted>
                  )}
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <span style={cellText}>{formatDateTime(request.createdAt)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Linear replies and mentions sent to running jobs' live sessions. */
function MessagesCard({ run }: { run: RalphRunDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Messages</CardTitle>
        <CardDescription>
          Replies passed to the agent that was working at the time, through its heartbeat, newest
          first (the latest {run.messageLimit}).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              <TableHead className={WIDE_COLUMN}>Kind</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className={WIDE_COLUMN}>Author</TableHead>
              <TableHead className={WIDE_COLUMN}>Job</TableHead>
              <TableHead className={WIDE_COLUMN}>State</TableHead>
              <TableHead className={WIDE_COLUMN}>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.messages.map((message) => {
              const settledAt = message.deliveredAt ?? message.consumedAt;
              return (
                <TableRow key={message.id}>
                  <TableCell className={WIDE_COLUMN}>
                    <Badge variant="neutral">{message.kind}</Badge>
                  </TableCell>
                  <TableCell>
                    <span style={textCell} title={message.text}>
                      {truncate(message.text, MESSAGE_PREVIEW)}
                    </span>
                    <PhoneMeta>
                      <Badge variant={RALPH_MESSAGE_STATE_VARIANTS[message.state]} dot>
                        {RALPH_MESSAGE_STATE_LABELS[message.state]}
                      </Badge>
                      <Timestamp iso={message.createdAt} />
                    </PhoneMeta>
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    {message.author ? (
                      <span style={cellText}>{message.author}</span>
                    ) : (
                      <Muted>—</Muted>
                    )}
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    <JobLink id={message.job.id} label={message.job.type} />
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    <div className="list-cell-stack">
                      <Badge variant={RALPH_MESSAGE_STATE_VARIANTS[message.state]} dot>
                        {RALPH_MESSAGE_STATE_LABELS[message.state]}
                      </Badge>
                      {settledAt && (
                        <Muted style={{ fontSize: "var(--text-xs)" }}>
                          {formatDateTime(settledAt)}
                        </Muted>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    <span style={cellText}>{formatDateTime(message.createdAt)}</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function JobsCard({ run, isAdmin }: { run: RalphRunDetail; isAdmin: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Jobs</CardTitle>
        <CardDescription>Every job of the run, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead className={WIDE_COLUMN}>Status</TableHead>
              <TableHead className={WIDE_COLUMN}>Deliveries</TableHead>
              <TableHead className={WIDE_COLUMN}>Harness</TableHead>
              <TableHead className={WIDE_COLUMN}>Created</TableHead>
              <TableHead className={WIDE_COLUMN}>Finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Link
                    href={jobPageHref(job.id)}
                    style={{ ...mono, color: "var(--text-primary)", textDecoration: "none" }}
                  >
                    {job.type}
                  </Link>
                  <PhoneMeta>
                    <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot>
                      {job.status}
                    </Badge>
                    <Timestamp iso={job.finishedAt ?? job.createdAt} />
                  </PhoneMeta>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <div className="list-cell-stack">
                    <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot>
                      {job.status}
                      {job.status === "running" && job.cancelRequested ? " (canceling)" : ""}
                    </Badge>
                    {job.error && (
                      <Muted title={job.error} className="list-error">
                        {truncate(job.error, 80)}
                      </Muted>
                    )}
                  </div>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <span style={cellText}>{job.deliveryCount}</span>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <AgentName agent={job.agent} isAdmin={isAdmin} />
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <span style={cellText}>{formatDateTime(job.createdAt)}</span>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  {job.finishedAt ? (
                    <span style={cellText}>{formatDateTime(job.finishedAt)}</span>
                  ) : (
                    <Muted>—</Muted>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** The run's empty sections, named for the one muted line that stands in for their cards. */
function emptySections(run: RalphRunDetail): string[] {
  return [
    run.lanes.length === 0 && run.stories.length === 0 && "stories",
    run.pendingRequests.length === 0 && "pending requests",
    run.messages.length === 0 && "messages",
    run.guidance.length === 0 && "guidance",
    !run.progress.trim() && "progress log",
    run.jobs.length === 0 && "jobs",
  ].filter((name): name is string => Boolean(name));
}

const EMPTY_SECTION_HINTS: Record<string, string> = {
  stories: "Stories appear once the run has loaded the epic from Linear.",
  "pending requests": "Requests from Linear, review findings, @bot comments and failed CI.",
  messages: "Replies passed to the agent working at the time.",
  guidance: "Replies in the agent session, applied to the next story attempts.",
  "progress log": "Appended to after every finished story.",
  jobs: "Every job the run enqueues.",
};

function EmptySections({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(names);
  return (
    <Muted
      className="run-empty-sections"
      title={names.map((name) => `${name}: ${EMPTY_SECTION_HINTS[name]}`).join("\n")}
    >
      Nothing yet in {list}.
    </Muted>
  );
}

/** What failed, the job to look at, and how to go on. */
function RunErrorAlert({ run }: { run: RalphRunDetail }) {
  if (!run.error) return null;
  const failure = ralphRunFailure(run);
  return (
    <Alert variant="danger">
      <IconAlertTriangle size={16} />
      <AlertTitle as="h2">{failure.title}</AlertTitle>
      <AlertDescription className="run-error">
        <span className="run-error-text">{run.error}</span>
        {failure.job && (
          <span>
            Last failing job:{" "}
            <Link href={jobPageHref(failure.job.id)} className="run-job-link">
              {failure.job.type} {shortJobId(failure.job.id)}
            </Link>
            {failure.job.finishedAt && <> · {formatDateTime(failure.job.finishedAt)}</>}
          </span>
        )}
        <span>{failure.resume}</span>
      </AlertDescription>
    </Alert>
  );
}

/** The run's key facts, each once: the lane cards below carry the rest. */
function RunFacts({ run, isAdmin }: { run: RalphRunDetail; isAdmin: boolean }) {
  const singleRepository = run.lanes.length <= 1;
  return (
    <FactStrip label="Run facts">
      {singleRepository ? (
        <>
          <Fact label="Repository" wide>
            {run.repository ? (
              <span className="fact-mono fact-repo">
                <ProviderIcon provider={run.repository.provider} size={14} />
                <span>{run.repository.fullPath}</span>
              </span>
            ) : (
              <Muted>Not chosen yet</Muted>
            )}
          </Fact>
          <Fact label="Branch" wide>
            {run.branch ? (
              <span className="fact-inline">
                <InlineCode>{run.branch}</InlineCode>
                {run.baseBranch && (
                  <>
                    <span className="fact-secondary">from</span>
                    <InlineCode>{run.baseBranch}</InlineCode>
                  </>
                )}
              </span>
            ) : (
              <Muted>—</Muted>
            )}
          </Fact>
          <Fact label={run.repository?.provider === "gitlab" ? "Merge request" : "Pull request"}>
            <PullRequestLink pullRequest={run.pullRequest} />
          </Fact>
        </>
      ) : (
        <Fact label="Repositories">
          <span className="text-numeric">{run.lanes.length}</span>
        </Fact>
      )}
      <Fact label="Harness">
        <AgentName agent={run.agent} isAdmin={isAdmin} />
      </Fact>
      <Fact label="Stories done">
        <span className="text-numeric">
          {run.storyCounts.completed} / {run.storyCounts.total}
        </span>
      </Fact>
      <Fact label="Jobs enqueued">
        <span className="text-numeric">{run.iterations}</span>
      </Fact>
      <Fact label="Started">
        <Timestamp iso={run.createdAt} />
      </Fact>
      <Fact label="Last updated">
        <Timestamp iso={run.updatedAt} />
      </Fact>
    </FactStrip>
  );
}

export function RalphRunDetailView({
  run,
  linearConnected,
}: {
  run: RalphRunDetail;
  /** False while no Linear workspace is connected. */
  linearConnected: boolean;
}) {
  const isAdmin = useCurrentUser().role === "admin";
  const stoppable = STOPPABLE_RALPH_RUN_STATUSES.includes(run.status);
  const empty = emptySections(run);

  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Ralph runs", href: "/ralph" }, { label: runSourceLabel(run) }]}
      />
      <main className="detail-main">
        <PageHeader
          title={
            <>
              <span className="text-numeric">{runSourceLabel(run)}</span>
              {run.linearTitle && <> {run.linearTitle}</>}
            </>
          }
          meta={
            <>
              <RalphRunStatusBadge status={run.status} />
              <Badge variant="neutral" title={RUN_KIND_DESCRIPTIONS[run.kind]}>
                {RUN_KIND_LABELS[run.kind]}
              </Badge>
            </>
          }
          actions={
            <>
              {run.origin === "linear" && run.linearUrl && (
                <Button asChild variant="ghost">
                  <a href={run.linearUrl} target="_blank" rel="noreferrer">
                    <IconExternalLink size={14} />
                    Open in Linear
                  </a>
                </Button>
              )}
              {isAdmin && stoppable && <StopRunButton run={run} />}
            </>
          }
        />

        {!linearConnected && <LinearNotConnected isAdmin={isAdmin} />}

        <RunErrorAlert run={run} />

        <WaitingOn run={run} />

        <RunFacts run={run} isAdmin={isAdmin} />

        <StoriesCard run={run} />

        <EmptySections names={empty} />

        {run.pendingRequests.length > 0 && <PendingRequestsCard run={run} />}

        {run.messages.length > 0 && <MessagesCard run={run} />}

        {run.guidance.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">Guidance</CardTitle>
              <CardDescription>
                Replies in the agent session, applied to the next story attempts (the latest ten).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="run-guidance">
                {run.guidance.map((g, i) => (
                  <li key={`${g.at}-${i}`} className="run-guidance-item">
                    <Timestamp iso={g.at} />
                    <span className="run-guidance-text">{g.text}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}

        {run.progress.trim() && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">Progress log</CardTitle>
              <CardDescription>Appended to after every finished story.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="run-code-block">{run.progress}</pre>
            </CardContent>
          </Card>
        )}

        {run.jobs.length > 0 && <JobsCard run={run} isAdmin={isAdmin} />}
      </main>
    </>
  );
}
