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
  Empty,
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
  IconInbox,
  IconListCheck,
  IconMessage,
  IconMessages,
  IconNotes,
  IconPlayerStop,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { RalphRunStatusBadge, RalphStoryStatusBadge } from "@/components/ralph-badges";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import {
  jobHref,
  linearIssueUrl,
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
  RunSource,
} from "../ralph-runs-view";

const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const stack = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const codeBlock: React.CSSProperties = {
  margin: 0,
  padding: "var(--space-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-raised)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-primary)",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: "calc(var(--space-8) * 20)",
  overflowY: "auto",
};

/** Characters of a story's last feedback shown in the table (all of it on hover). */
const FEEDBACK_PREVIEW = 120;
/** Characters of a request or message shown in the tables (all of it on hover). */
const MESSAGE_PREVIEW = 240;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0 }}>
      <Muted style={{ fontSize: "var(--text-xs)" }}>{label}</Muted>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

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
      <AlertTitle>Waiting</AlertTitle>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Story</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Commit</TableHead>
          <TableHead>Last feedback</TableHead>
          <TableHead>Last job</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stories.map((story) => (
          <TableRow key={story.id}>
            <TableCell>
              <IssueRef identifier={story.identifier} title={story.title} runUrl={run.linearUrl} />
            </TableCell>
            <TableCell>
              <RalphStoryStatusBadge status={story.status} />
            </TableCell>
            <TableCell>
              <span style={cellText}>{story.attempts}</span>
            </TableCell>
            <TableCell>
              {story.commitSha ? (
                <InlineCode title={story.commitSha}>{shortSha(story.commitSha)}</InlineCode>
              ) : (
                <Muted>—</Muted>
              )}
            </TableCell>
            <TableCell>
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
            <TableCell>
              {story.lastJobId ? (
                <Link
                  href={jobHref(story.lastJobId)}
                  style={{ ...mono, color: "var(--text-accent)", textDecoration: "none" }}
                >
                  {story.lastJobId.slice(0, 8)}
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
  return (
    <Card>
      <CardHeader>
        <CardTitle style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <ProviderIcon provider={lane.repository.provider} />
          <span style={{ ...mono, fontSize: "var(--text-sm)" }}>{lane.repository.fullPath}</span>
          {lane.main && run.lanes.length > 1 ? <Badge variant="neutral">Main</Badge> : null}
        </CardTitle>
        <CardDescription>
          <InlineCode>{lane.branch}</InlineCode> based on{" "}
          {lane.baseBranch ? <InlineCode>{lane.baseBranch}</InlineCode> : "—"}
          {" · "}
          {lane.repository.provider === "gitlab" ? "Merge request" : "Pull request"}{" "}
          {/* Not <PullRequestLink>: its empty state is a <p>, invalid inside this <p>. */}
          {lane.pullRequest ? <PullRequestLink pullRequest={lane.pullRequest} /> : "—"}
          {" · "}
          {done} of {stories.length} {stories.length === 1 ? "story" : "stories"} done
          {" · "}
          Review rounds {roundsLabel(lane.reviewRounds)}
          {" · "}
          CI fix rounds {roundsLabel(lane.ciFixRounds)}
          {lane.cleanup ? ` · ${lane.cleanup}` : null}
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
        <CardTitle>Not in a repository here</CardTitle>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stories</CardTitle>
        <CardDescription>
          {run.storyCounts.completed} of {run.storyCounts.total} done, in sub-issue order.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {run.stories.length === 0 ? (
          <Empty
            icon={<IconListCheck size={24} />}
            title="No stories yet"
            description="Stories appear once the run has loaded the epic from Linear."
          />
        ) : (
          <StoriesTable run={run} stories={run.stories} />
        )}
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
      href={jobHref(id)}
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
        <CardTitle>Pending requests</CardTitle>
        <CardDescription>
          Requests from Linear, review findings, <InlineCode>@bot</InlineCode> comments and failed
          CI that the run hasn&apos;t handled yet. They run as request jobs when no story runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {run.pendingRequests.length === 0 ? (
          <Empty
            size="sm"
            icon={<IconInbox size={24} />}
            title="No pending requests"
            description="Every request has been handled."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {multiLane && <TableHead>Repository</TableHead>}
                <TableHead>Request</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.pendingRequests.map((request) => (
                <TableRow key={request.id}>
                  {multiLane && (
                    <TableCell>
                      <span style={mono}>{laneRepository(run, request.laneId) ?? "—"}</span>
                    </TableCell>
                  )}
                  <TableCell>
                    <span style={textCell} title={request.text}>
                      {truncate(request.text, MESSAGE_PREVIEW)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {request.author ? (
                      <span style={cellText}>{request.author}</span>
                    ) : (
                      <Muted>—</Muted>
                    )}
                  </TableCell>
                  <TableCell>
                    <span style={cellText}>{formatDateTime(request.createdAt)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** Linear replies and mentions sent to running jobs' live sessions. */
function MessagesCard({ run }: { run: RalphRunDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Messages</CardTitle>
        <CardDescription>
          Replies passed to the agent that was working at the time, through its heartbeat, newest
          first (the latest {run.messageLimit}).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {run.messages.length === 0 ? (
          <Empty
            size="sm"
            icon={<IconMessages size={24} />}
            title="No messages"
            description="Replies sent while a story or request runs appear here."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.messages.map((message) => {
                const settledAt = message.deliveredAt ?? message.consumedAt;
                return (
                  <TableRow key={message.id}>
                    <TableCell>
                      <Badge variant="neutral">{message.kind}</Badge>
                    </TableCell>
                    <TableCell>
                      <span style={textCell} title={message.text}>
                        {truncate(message.text, MESSAGE_PREVIEW)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {message.author ? (
                        <span style={cellText}>{message.author}</span>
                      ) : (
                        <Muted>—</Muted>
                      )}
                    </TableCell>
                    <TableCell>
                      <JobLink id={message.job.id} label={message.job.type} />
                    </TableCell>
                    <TableCell>
                      <div style={{ ...stack, gap: "var(--space-1)" }}>
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
                    <TableCell>
                      <span style={cellText}>{formatDateTime(message.createdAt)}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function JobsCard({ run, isAdmin }: { run: RalphRunDetail; isAdmin: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Jobs</CardTitle>
        <CardDescription>Every job of the run, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {run.jobs.length === 0 ? (
          <Empty
            icon={<IconListCheck size={24} />}
            title="No jobs yet"
            description="Jobs appear when the run enqueues a story, preparation or PR description."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Deliveries</TableHead>
                <TableHead>Harness</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Finished</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell>
                    <Link
                      href={jobHref(job.id)}
                      style={{ ...mono, color: "var(--text-primary)", textDecoration: "none" }}
                    >
                      {job.type}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div style={{ ...stack, gap: "var(--space-1)" }}>
                      <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot>
                        {job.status}
                        {job.status === "running" && job.cancelRequested ? " (canceling)" : ""}
                      </Badge>
                      {job.error && (
                        <Muted title={job.error} style={{ maxWidth: "calc(var(--space-8) * 10)" }}>
                          {truncate(job.error, 80)}
                        </Muted>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span style={cellText}>{job.deliveryCount}</span>
                  </TableCell>
                  <TableCell>
                    <AgentName agent={job.agent} isAdmin={isAdmin} />
                  </TableCell>
                  <TableCell>
                    <span style={cellText}>{formatDateTime(job.createdAt)}</span>
                  </TableCell>
                  <TableCell>
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
        )}
      </CardContent>
    </Card>
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

  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Ralph runs", href: "/ralph" }, { label: runSourceLabel(run) }]}
      />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "var(--text-2xl)",
                fontWeight: "var(--font-weight-semibold)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)" }}>{runSourceLabel(run)}</span>
              {run.linearTitle && <span>{run.linearTitle}</span>}
            </h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                marginTop: "var(--space-2)",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  ...mono,
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                }}
              >
                {run.repository ? (
                  <>
                    <ProviderIcon provider={run.repository.provider} size={14} />
                    {run.repository.fullPath}
                  </>
                ) : (
                  "Repository not chosen yet"
                )}
              </span>
              <RalphRunStatusBadge status={run.status} />
              <Badge variant="neutral">{run.kind}</Badge>
            </div>
          </div>
          {isAdmin && stoppable && (
            <div style={{ flexShrink: 0 }}>
              <StopRunButton run={run} />
            </div>
          )}
        </div>

        {!linearConnected && <LinearNotConnected isAdmin={isAdmin} />}

        {run.error && (
          <Alert variant="danger">
            <IconAlertTriangle size={16} />
            <AlertTitle>{run.status === "waiting" ? "The PR/MR step failed" : "Error"}</AlertTitle>
            <AlertDescription style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {run.error}
            </AlertDescription>
          </Alert>
        )}

        <WaitingOn run={run} />

        <Card>
          <CardHeader>
            <CardTitle>Run</CardTitle>
            <CardDescription>
              Started {formatDateTime(run.createdAt)}, last updated {formatDateTime(run.updatedAt)}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "var(--space-4)",
              }}
            >
              <Fact label="Status">
                <RalphRunStatusBadge status={run.status} />
              </Fact>
              <Fact label={run.origin === "chat" ? "Chat" : "Linear"}>
                <RunSource run={run} showTitle={false} />
              </Fact>
              <Fact label="Repository">
                <span style={mono}>{run.repository?.fullPath ?? "Not chosen yet"}</span>
              </Fact>
              <Fact label="Branch">{run.branch ? <InlineCode>{run.branch}</InlineCode> : "—"}</Fact>
              <Fact label="Base">
                {run.baseBranch ? <InlineCode>{run.baseBranch}</InlineCode> : "—"}
              </Fact>
              <Fact label="Harness">
                <AgentName agent={run.agent} isAdmin={isAdmin} />
              </Fact>
              <Fact
                label={run.repository?.provider === "gitlab" ? "Merge request" : "Pull request"}
              >
                <PullRequestLink pullRequest={run.pullRequest} />
              </Fact>
              <Fact label="Stories">
                {run.storyCounts.completed} / {run.storyCounts.total}
              </Fact>
              <Fact label="Jobs enqueued">{run.iterations}</Fact>
            </div>
          </CardContent>
        </Card>

        <StoriesCard run={run} />

        <PendingRequestsCard run={run} />

        <MessagesCard run={run} />

        <Card>
          <CardHeader>
            <CardTitle>Guidance</CardTitle>
            <CardDescription>
              Replies in the agent session, applied to the next story attempts (the latest ten).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {run.guidance.length === 0 ? (
              <Empty
                size="sm"
                icon={<IconMessage size={24} />}
                title="No guidance"
                description="Reply in the Linear agent session to steer the run."
              />
            ) : (
              <ol style={{ margin: 0, paddingLeft: "var(--space-6)", ...stack }}>
                {run.guidance.map((g, i) => (
                  <li key={`${g.at}-${i}`} style={{ ...stack, gap: "var(--space-1)" }}>
                    <Muted style={{ fontSize: "var(--text-xs)" }}>{formatDateTime(g.at)}</Muted>
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {g.text}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Progress log</CardTitle>
            <CardDescription>Appended to after every finished story.</CardDescription>
          </CardHeader>
          <CardContent>
            {run.progress.trim() ? (
              <pre style={codeBlock}>{run.progress}</pre>
            ) : (
              <Empty
                size="sm"
                icon={<IconNotes size={24} />}
                title="Nothing logged yet"
                description="The log starts with the first finished story."
              />
            )}
          </CardContent>
        </Card>

        <JobsCard run={run} isAdmin={isAdmin} />
      </main>
    </>
  );
}
