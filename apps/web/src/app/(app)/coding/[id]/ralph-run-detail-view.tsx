"use client";

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
  Stack,
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
import { ListErrorRow, useListErrorId } from "@/components/list-error";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import {
  JobStatusBadge,
  RalphRunStatusBadge,
  RalphStoryStatusBadge,
} from "@/components/ralph-badges";
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
import { RALPH_MESSAGE_STATE_VARIANTS, stateLabel } from "@/lib/state-variants";
import { ProviderIcon } from "@/components/provider-icon";
import { stopRalphRun } from "../actions";
import {
  AgentName,
  LinearIssueLink,
  LinearNotConnected,
  PullRequestLink,
} from "../ralph-runs-view";
import { EmptyValue } from "@/components/empty-value";

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
    <Stack asChild gap={1} className="run-issue-list">
      <ul>
        {items.map((item) => (
          <li key={item.identifier}>
            <IssueRef identifier={item.identifier} title={item.title} runUrl={run.linearUrl} />
          </li>
        ))}
      </ul>
    </Stack>
  );
  return (
    <Alert variant="warning">
      <IconClockPause size={16} />
      <AlertTitle as="h2">Waiting</AlertTitle>
      <Stack asChild gap={3}>
        <AlertDescription>
          {waitingOn.blockers.length > 0 && (
            <Stack gap={3}>
              <span>Open blockers outside the epic:</span>
              {list(waitingOn.blockers)}
            </Stack>
          )}
          {waitingOn.manual.length > 0 && (
            <Stack gap={3}>
              <span>Manual stories a person has to finish:</span>
              {list(waitingOn.manual)}
            </Stack>
          )}
          <span>The run resumes by itself when these are completed in Linear.</span>
        </AlertDescription>
      </Stack>
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
                <span className="list-time">
                  <span className="text-numeric">{story.attempts}</span>{" "}
                  {story.attempts === 1 ? "attempt" : "attempts"}
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
              <span className="list-text">{story.attempts}</span>
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              {story.commitSha ? (
                <InlineCode title={story.commitSha}>{shortSha(story.commitSha)}</InlineCode>
              ) : (
                <EmptyValue />
              )}
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              {story.lastFeedback ? (
                <Muted title={story.lastFeedback} className="run-feedback-preview">
                  {truncate(story.lastFeedback, FEEDBACK_PREVIEW)}
                </Muted>
              ) : (
                <EmptyValue />
              )}
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              {story.lastJobId ? (
                <JobLink id={story.lastJobId} label={shortJobId(story.lastJobId)} />
              ) : (
                <EmptyValue />
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
  // With one repository the fact strip already shows it, its branch, its PR/MR
  // and the stories done; with several, each lane's count is for its repository.
  const single = run.lanes.length === 1;
  const rounds = (
    <>
      {!single && (
        <>
          <span className="text-numeric">{done}</span> of{" "}
          <span className="text-numeric">{stories.length}</span>{" "}
          {stories.length === 1 ? "story" : "stories"} done in this repository
          {" · "}
        </>
      )}
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
            <MonoValue value={lane.repository.fullPath} className="fact-mono" />
            {lane.main ? <Badge variant="neutral">Main</Badge> : null}
          </CardTitle>
        )}
        <CardDescription>
          {!single && (
            <>
              <InlineCode>{lane.branch}</InlineCode> from{" "}
              {lane.baseBranch ? <InlineCode>{lane.baseBranch}</InlineCode> : <EmptyValue />}
              {" · "}
              {lane.repository.provider === "gitlab" ? "Merge request" : "Pull request"}{" "}
              {/* Not <PullRequestLink>: its empty state is a <p>, invalid inside this <p>. */}
              {lane.pullRequest ? (
                <PullRequestLink pullRequest={lane.pullRequest} />
              ) : (
                <EmptyValue />
              )}
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
        <Stack asChild gap={3} className="run-issue-list">
          <ul>
            {stories.map((story) => (
              <li key={story.id} className="text-sm">
                <IssueRef
                  identifier={story.identifier}
                  title={story.title}
                  runUrl={run.linearUrl}
                />{" "}
                <Muted>({story.elsewhere})</Muted>
              </li>
            ))}
          </ul>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** Advice the stories' sessions gave for other projects or repositories: shown, never filed. */
export function RecommendationsCard({ run }: { run: RalphRunDetail }) {
  const items = run.stories.flatMap((story) =>
    story.recommendations.map((recommendation) => ({ story, recommendation })),
  );
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Recommendations</CardTitle>
        <CardDescription>
          Changes to other projects or repositories that stories suggested, e.g. an upstream fix
          that would let a workaround go. They aren&apos;t filed as issues and don&apos;t hold
          stories up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="run-guidance">
          {items.map(({ story, recommendation }) => (
            <li key={`${story.id}-${recommendation.title}`} className="run-guidance-item">
              <span className="text-sm font-medium">{recommendation.title}</span>
              <Muted>
                From{" "}
                <IssueRef
                  identifier={story.identifier}
                  title={story.title}
                  runUrl={run.linearUrl}
                />{" "}
                · <Timestamp iso={recommendation.at} inline />
              </Muted>
              {recommendation.description && (
                <span className="run-guidance-text">{recommendation.description}</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** One section per lane (repository), or a single stories table before the run has one. */
export function StoriesCard({ run }: { run: RalphRunDetail }) {
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
        {/* The fact strip states the stories done. */}
        <CardDescription>In sub-issue order.</CardDescription>
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

function JobLink({ id, label }: { id: string; label: string }) {
  return (
    <Link href={jobPageHref(id)} className="run-job-link">
      <MonoValue value={label} title={id} />
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
                    <span className="fact-mono">
                      {laneRepository(run, request.laneId) ?? <EmptyValue />}
                    </span>
                  </TableCell>
                )}
                <TableCell>
                  <span className="run-text-cell" title={request.text}>
                    {truncate(request.text, MESSAGE_PREVIEW)}
                  </span>
                  <PhoneMeta>
                    {request.author && <span className="list-time">{request.author}</span>}
                    <Timestamp iso={request.createdAt} />
                  </PhoneMeta>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  {request.author ? (
                    <span className="list-text">{request.author}</span>
                  ) : (
                    <EmptyValue />
                  )}
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <Timestamp iso={request.createdAt} />
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
              // The row shows one time (Created); when it settled is the state badge's tooltip.
              const settledTitle = settledAt
                ? `${RALPH_MESSAGE_STATE_LABELS[message.state]} ${formatDateTime(settledAt)}`
                : undefined;
              return (
                <TableRow key={message.id}>
                  <TableCell className={WIDE_COLUMN}>
                    <Badge variant="neutral">{stateLabel(message.kind)}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="run-text-cell" title={message.text}>
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
                      <span className="list-text">{message.author}</span>
                    ) : (
                      <EmptyValue />
                    )}
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    <JobLink id={message.job.id} label={message.job.type} />
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    <Badge
                      variant={RALPH_MESSAGE_STATE_VARIANTS[message.state]}
                      dot
                      title={settledTitle}
                    >
                      {RALPH_MESSAGE_STATE_LABELS[message.state]}
                    </Badge>
                  </TableCell>
                  <TableCell className={WIDE_COLUMN}>
                    <Timestamp iso={message.createdAt} />
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

/** The run's jobs table's column count, which a failed job's reason row spans. */
const RUN_JOB_COLUMNS = 6;

function RunJobRow({
  job,
  isAdmin,
  year,
}: {
  job: RalphRunDetail["jobs"][number];
  isAdmin: boolean;
  year: number;
}) {
  const errorId = useListErrorId(job.error);
  return (
    <>
      <TableRow data-has-error={job.error ? true : undefined}>
        <TableCell>
          <Link
            href={jobPageHref(job.id)}
            className="fact-mono list-text-primary"
            aria-describedby={errorId}
          >
            {job.type}
          </Link>
          <PhoneMeta>
            <JobStatusBadge job={job} />
            {/* The ID a story's "Last job" names, so the two can be matched. */}
            <JobLink id={job.id} label={shortJobId(job.id)} />
            <Timestamp iso={job.finishedAt ?? job.createdAt} year={year} />
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <JobLink id={job.id} label={shortJobId(job.id)} />
        </TableCell>
        <TableCell className={WIDE_COLUMN} aria-describedby={errorId}>
          <JobStatusBadge job={job} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <span className="list-text">{job.deliveryCount}</span>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <AgentName agent={job.agent} isAdmin={isAdmin} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          {/* The Jobs page's format: the current year dropped, and the finished time
              without the date parts it shares with the created one. */}
          <span className="list-time">
            <Timestamp iso={job.createdAt} year={year} /> →{" "}
            {job.finishedAt ? (
              <Timestamp iso={job.finishedAt} after={job.createdAt} />
            ) : (
              <EmptyValue />
            )}
          </span>
        </TableCell>
      </TableRow>
      {job.error && <ListErrorRow error={job.error} colSpan={RUN_JOB_COLUMNS} id={errorId} />}
    </>
  );
}

function JobsCard({ run, isAdmin, year }: { run: RalphRunDetail; isAdmin: boolean; year: number }) {
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
              <TableHead className={WIDE_COLUMN}>ID</TableHead>
              <TableHead className={WIDE_COLUMN}>Status</TableHead>
              <TableHead className={WIDE_COLUMN}>Deliveries</TableHead>
              <TableHead className={WIDE_COLUMN}>Harness</TableHead>
              <TableHead className={WIDE_COLUMN}>Created → finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.jobs.map((job) => (
              <RunJobRow key={job.id} job={job} isAdmin={isAdmin} year={year} />
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
              <MonoValue
                value={`${failure.job.type} ${shortJobId(failure.job.id)}`}
                title={failure.job.id}
              />
            </Link>
            {failure.job.finishedAt && (
              <>
                {" "}
                · <Timestamp iso={failure.job.finishedAt} inline />
              </>
            )}
          </span>
        )}
        <span>{failure.resume}</span>
      </AlertDescription>
    </Alert>
  );
}

/** The run's key facts, each once: the lane cards below carry the rest. */
export function RunFacts({ run, isAdmin }: { run: RalphRunDetail; isAdmin: boolean }) {
  const singleRepository = run.lanes.length <= 1;
  // The total counts every story; say how many the repository cards don't list.
  const outside = run.lanes.length > 0 ? run.stories.filter((s) => s.elsewhere).length : 0;
  return (
    <FactStrip label="Run facts">
      {singleRepository ? (
        <>
          <Fact label="Repository" wide>
            {run.repository ? (
              <span className="fact-mono fact-repo">
                <ProviderIcon provider={run.repository.provider} size={14} />
                <MonoValue value={run.repository.fullPath} />
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
              <EmptyValue />
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
        {outside > 0 && (
          <span className="fact-secondary fact-note">
            <span className="text-numeric">{outside}</span>{" "}
            {singleRepository ? "outside this repository" : "outside these repositories"}
          </span>
        )}
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
  year,
}: {
  run: RalphRunDetail;
  /** False while no Linear workspace is connected. */
  linearConnected: boolean;
  /** The current year, which job times leave out. */
  year: number;
}) {
  const isAdmin = useCurrentUser().role === "admin";
  const stoppable = STOPPABLE_RALPH_RUN_STATUSES.includes(run.status);
  const empty = emptySections(run);

  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Coding tasks", href: "/coding" }, { label: runSourceLabel(run) }]}
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
                <Button asChild variant="ghost" className="page-header-ghost">
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

        <RecommendationsCard run={run} />

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

        {run.jobs.length > 0 && <JobsCard run={run} isAdmin={isAdmin} year={year} />}
      </main>
    </>
  );
}
