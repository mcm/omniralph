"use client";

import { Link } from "@/components/link";
import { useParams } from "next/navigation";
import {
  Alert,
  AlertDescription,
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
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconExternalLink, IconMessageCircle } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { EmptyValue } from "@/components/empty-value";
import { Fact, FactStrip } from "@/components/fact-strip";
import { Freshness } from "@/components/freshness";
import { ListErrorRow, useListErrorId } from "@/components/list-error";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { JobStatusBadge, TriageRunStatusBadge } from "@/components/ralph-badges";
import { RelativeTime } from "@/components/relative-time";
import { jobPageHref, shortJobId } from "@/lib/jobs/list";
import {
  formatDuration,
  STORY_PRIORITY_LABELS,
  TRIAGE_OUTCOME_DESCRIPTIONS,
  TRIAGE_OUTCOME_LABELS,
  TRIAGE_TRIGGER_DESCRIPTIONS,
  TRIAGE_TRIGGER_LABELS,
  triageRunLabel,
  type TriageJobRow,
  type TriageResultView,
  type TriageRunDetailView as TriageRunDetail,
} from "@/lib/triage/display";
import { ProviderIcon } from "@/components/provider-icon";
import { AgentName } from "../../coding/ralph-runs-view";
import { useTriageRunDetail } from "../triage-queries";

type TriageOutcome = NonNullable<TriageResultView["outcome"]>;

function RunErrorAlert({ run }: { run: TriageRunDetail }) {
  if (!run.error) return null;
  const job = run.jobs.find((j) => j.status === "failed") ?? run.jobs[0];
  return (
    <Alert variant="danger">
      <IconAlertTriangle size={16} />
      <AlertTitle as="h2">Triage failed</AlertTitle>
      <AlertDescription className="run-error">
        <span className="run-error-text">{run.error}</span>
        {job && (
          <span>
            Last job:{" "}
            <Link href={jobPageHref(job.id)} className="run-job-link">
              <MonoValue value={`triage.run ${shortJobId(job.id)}`} title={job.id} />
            </Link>
          </span>
        )}
        <span>Reply in the Linear agent session to triage the issue again.</span>
      </AlertDescription>
    </Alert>
  );
}

function PendingReplyAlert({ reply }: { reply: string | null }) {
  if (!reply) return null;
  return (
    <Alert variant="info">
      <IconMessageCircle size={16} />
      <AlertTitle as="h2">Reply waiting</AlertTitle>
      <AlertDescription className="run-error">
        <span className="run-error-text">{reply}</span>
        <span>The next triage job takes it once the current one finishes.</span>
      </AlertDescription>
    </Alert>
  );
}

function RunFacts({ run, isAdmin }: { run: TriageRunDetail; isAdmin: boolean }) {
  const result = run.result;
  return (
    <FactStrip label="Triage facts">
      <Fact label="Repository" wide>
        {run.repository ? (
          <span className="fact-mono fact-repo">
            <ProviderIcon provider={run.repository.provider} size={14} />
            <a href={run.repository.url} target="_blank" rel="noreferrer">
              <MonoValue value={run.repository.fullPath} />
            </a>
          </span>
        ) : (
          <Muted>{run.jobs.length > 0 ? "None routes the issue" : "Not chosen yet"}</Muted>
        )}
      </Fact>
      <Fact label="Branch">
        {run.branch ? <InlineCode>{run.branch}</InlineCode> : <EmptyValue />}
      </Fact>
      <Fact label="Outcome">
        {run.outcome ? (
          <span title={TRIAGE_OUTCOME_DESCRIPTIONS[run.outcome]}>
            {TRIAGE_OUTCOME_LABELS[run.outcome]}
          </span>
        ) : (
          <EmptyValue />
        )}
      </Fact>
      <Fact label="Size">{run.size ? <span>{run.size}</span> : <EmptyValue />}</Fact>
      <Fact label="Harness">
        <AgentName agent={run.agent} isAdmin={isAdmin} />
      </Fact>
      <Fact label="Jobs">
        <span className="text-numeric">{run.jobCount}</span>
      </Fact>
      <Fact label="Tokens in / out">
        {result ? (
          <span className="text-numeric">
            {result.usage.inputTokens.toLocaleString()} /{" "}
            {result.usage.outputTokens.toLocaleString()}
          </span>
        ) : (
          <EmptyValue />
        )}
      </Fact>
      <Fact label="Duration">
        {result ? (
          <span className="text-numeric">{formatDuration(result.durationMs)}</span>
        ) : (
          <EmptyValue />
        )}
      </Fact>
      <Fact label="Started">
        <Timestamp iso={run.createdAt} />
      </Fact>
      <Fact label="Last updated">
        <RelativeTime iso={run.updatedAt} />
      </Fact>
    </FactStrip>
  );
}

function SummaryCard({ result }: { result: TriageResultView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Summary</CardTitle>
        <CardDescription>What the last triage job told the Linear session.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="run-guidance-text">{result.summary}</p>
      </CardContent>
    </Card>
  );
}

function OpenQuestionsCard({ questions }: { questions: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Open questions</CardTitle>
        <CardDescription>
          What triage couldn&apos;t decide: the issue stays in Backlog until they are answered.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="run-guidance">
          {questions.map((question, i) => (
            <li key={i} className="run-guidance-text">
              {question}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function PrdCard({ outcome }: { outcome: TriageOutcome }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{outcome.outcome === "unchanged" ? "Issue" : "PRD"}</CardTitle>
        <CardDescription>{outcome.title}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="run-code-block">{outcome.description}</pre>
      </CardContent>
    </Card>
  );
}

/** A story or sub-issue: its title, with its body folded away. */
function FoldedBody({ title, body }: { title: string; body: string }) {
  return (
    <details>
      <summary className="cursor-pointer list-text list-text-primary">{title}</summary>
      <pre className="run-code-block triage-story-body">{body}</pre>
    </details>
  );
}

function StoriesCard({ outcome }: { outcome: TriageOutcome }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Stories</CardTitle>
        <CardDescription>The sub-issues triage planned for the epic, in order.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              <TableHead numeric>#</TableHead>
              <TableHead>Story</TableHead>
              <TableHead className={WIDE_COLUMN}>Priority</TableHead>
              <TableHead className={WIDE_COLUMN}>Blocked by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outcome.stories.map((story, i) => (
              <TableRow key={i}>
                <TableCell numeric>
                  <span className="text-numeric">{i + 1}</span>
                </TableCell>
                <TableCell>
                  <FoldedBody title={story.title} body={story.body} />
                  {story.manual && <Badge variant="warning">Manual</Badge>}
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <span className="list-text">
                    {STORY_PRIORITY_LABELS[story.priority] ?? story.priority}
                  </span>
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  {story.dependsOn.length > 0 ? (
                    <span className="list-text text-numeric">
                      {story.dependsOn.map((d) => `#${d + 1}`).join(", ")}
                    </span>
                  ) : (
                    <EmptyValue />
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

function SubIssueUpdatesCard({ outcome }: { outcome: TriageOutcome }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Reformatted sub-issues</CardTitle>
        <CardDescription>
          Existing sub-issues rewritten in the PRD format (only Backlog and Todo ones change).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              <TableHead>Sub-issue</TableHead>
              <TableHead className={WIDE_COLUMN}>Priority</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outcome.subIssueUpdates.map((update) => (
              <TableRow key={update.id}>
                <TableCell>
                  <FoldedBody title={update.title} body={update.body} />
                </TableCell>
                <TableCell className={WIDE_COLUMN}>
                  <span className="list-text">
                    {STORY_PRIORITY_LABELS[update.priority] ?? update.priority}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** The jobs table's column count, which a failed job's reason row spans. */
const JOB_COLUMNS = 5;

function JobRow({ job, isAdmin, year }: { job: TriageJobRow; isAdmin: boolean; year: number }) {
  const errorId = useListErrorId(job.error);
  return (
    <>
      <TableRow data-has-error={job.error ? true : undefined}>
        <TableCell>
          <div className="list-cell-stack">
            <Link href={jobPageHref(job.id)} className="run-job-link" aria-describedby={errorId}>
              <MonoValue value={shortJobId(job.id)} title={job.id} />
            </Link>
            {job.reply && (
              <span className="run-text-cell" title={job.reply}>
                Reply: {job.reply}
              </span>
            )}
          </div>
          <PhoneMeta>
            <JobStatusBadge job={job} />
            <Timestamp iso={job.finishedAt ?? job.createdAt} year={year} />
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN} aria-describedby={errorId}>
          <JobStatusBadge job={job} />
        </TableCell>
        <TableCell className={WIDE_COLUMN} numeric>
          {job.deliveryCount}
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <AgentName agent={job.agent} isAdmin={isAdmin} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
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
      {job.error && <ListErrorRow error={job.error} colSpan={JOB_COLUMNS} id={errorId} />}
    </>
  );
}

function JobsCard({
  run,
  isAdmin,
  year,
}: {
  run: TriageRunDetail;
  isAdmin: boolean;
  year: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Jobs</CardTitle>
        <CardDescription>
          Every triage job of the run, newest first: a reply in the session triages again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table className="list-table">
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead className={WIDE_COLUMN}>Status</TableHead>
              <TableHead className={WIDE_COLUMN} numeric aria-label="Deliveries">
                <abbr title="Deliveries">Deliv.</abbr>
              </TableHead>
              <TableHead className={WIDE_COLUMN}>Harness</TableHead>
              <TableHead className={WIDE_COLUMN}>Created → finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.jobs.map((job) => (
              <JobRow key={job.id} job={job} isAdmin={isAdmin} year={year} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ActivityCard({ run }: { run: TriageRunDetail }) {
  const severalJobs = run.jobs.length > 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Session activity</CardTitle>
        <CardDescription>
          What the triage sessions reported, oldest first (the latest {run.activities.length}).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="run-guidance">
          {run.activities.map((activity) => (
            <li key={activity.id} className="run-guidance-item">
              <span className="list-time">
                <Timestamp iso={activity.createdAt} inline />
                {severalJobs && <> · job {shortJobId(activity.jobId)}</>}
              </span>
              {activity.type === "action" ? (
                <span className="run-guidance-text">
                  <InlineCode>{activity.body}</InlineCode>
                  {activity.parameter && <> {activity.parameter}</>}
                </span>
              ) : (
                <span className="run-guidance-text">{activity.body}</span>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function TriageRunContent({ run, isAdmin }: { run: TriageRunDetail; isAdmin: boolean }) {
  const outcome = run.result?.outcome ?? null;
  // Job times leave out the browser's current year.
  const year = new Date().getFullYear();
  return (
    <>
      <RunErrorAlert run={run} />

      <PendingReplyAlert reply={run.pendingReply} />

      <RunFacts run={run} isAdmin={isAdmin} />

      {run.result && <SummaryCard result={run.result} />}

      {outcome && outcome.openQuestions.length > 0 && (
        <OpenQuestionsCard questions={outcome.openQuestions} />
      )}

      {outcome && <PrdCard outcome={outcome} />}

      {outcome && outcome.stories.length > 0 && <StoriesCard outcome={outcome} />}

      {outcome && outcome.subIssueUpdates.length > 0 && <SubIssueUpdatesCard outcome={outcome} />}

      {!run.result && run.jobs.length === 0 && (
        <Muted className="run-empty-sections">
          Nothing yet: the result and jobs appear once a triage job is queued.
        </Muted>
      )}

      {run.jobs.length > 0 && <JobsCard run={run} isAdmin={isAdmin} year={year} />}

      {run.activities.length > 0 && <ActivityCard run={run} />}
    </>
  );
}

/** The run's facts and summary while the first load is pending. */
function TriageRunSkeleton() {
  return (
    <>
      <Skeleton height="4.5rem" />
      <Card>
        <CardHeader>
          <Skeleton width="6rem" height="1.25rem" />
        </CardHeader>
        <CardContent>
          <Stack gap={3}>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} width={`${50 + ((index * 17) % 40)}%`} />
            ))}
          </Stack>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * A triage run's page, live: the run polls (`GET /api/ui/triage/{id}`), so its status,
 * result, jobs and session activity move while it's open. A run of another of the user's
 * organizations switches to it first.
 */
export function TriageRunDetailView() {
  const { id } = useParams<{ id: string }>();
  const detail = useTriageRunDetail(id);
  const isAdmin = useCurrentUser().role === "admin";
  const run = detail.data?.run;
  const label = run ? triageRunLabel(run) : "Triage run";

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Triage", href: "/triage" }, { label }]} />
      <main className="detail-main">
        <PageHeader
          title={
            run ? (
              <>
                <span className="text-numeric">{label}</span>
                {run.issue?.title && <> {run.issue.title}</>}
              </>
            ) : (
              <Skeleton width="16rem" height="1.75rem" />
            )
          }
          meta={
            run && (
              <>
                <TriageRunStatusBadge status={run.status} />
                <Badge variant="neutral" title={TRIAGE_TRIGGER_DESCRIPTIONS[run.trigger]}>
                  {TRIAGE_TRIGGER_LABELS[run.trigger]}
                </Badge>
                <Freshness query={detail} />
              </>
            )
          }
          actions={
            run?.issue?.url && (
              <Button asChild variant="ghost" className="page-header-ghost">
                <a href={run.issue.url} target="_blank" rel="noreferrer">
                  <IconExternalLink size={14} />
                  Open in Linear
                </a>
              </Button>
            )
          }
        />
        <QueryBoundary query={detail} skeleton={<TriageRunSkeleton />} what="the triage run">
          {(data) => <TriageRunContent run={data.run} isAdmin={isAdmin} />}
        </QueryBoundary>
      </main>
    </>
  );
}
