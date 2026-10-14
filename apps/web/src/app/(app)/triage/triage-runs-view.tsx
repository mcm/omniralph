"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconClipboardText } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { EmptyValue } from "@/components/empty-value";
import { ExternalRowLink, PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { ListErrorRow, useListErrorId } from "@/components/list-error";
import { ListPagination } from "@/components/list-pagination";
import { PageHeader } from "@/components/page-header";
import { TriageRunStatusBadge } from "@/components/ralph-badges";
import { totalPages } from "@/lib/pagination";
import { stateLabel } from "@/lib/state-variants";
import {
  TRIAGE_OUTCOME_DESCRIPTIONS,
  TRIAGE_OUTCOME_LABELS,
  TRIAGE_RUN_STATUSES,
  TRIAGE_TRIGGER_DESCRIPTIONS,
  TRIAGE_TRIGGER_LABELS,
  triageRunHref,
  triageRunLabel,
  triageRunListHref,
  type TriageRunListParams,
  type TriageRunRow,
} from "@/lib/triage/display";
import { ProviderIcon } from "../repositories/repositories-view";
import { AgentName } from "../coding/ralph-runs-view";

interface TriageRunsViewProps {
  runs: TriageRunRow[];
  params: TriageRunListParams;
  total: number;
  pageSize: number;
}

/** What triage decided: the outcome and size, and how many questions it left open. */
export function TriageOutcomeSummary({
  run,
}: {
  run: Pick<TriageRunRow, "outcome" | "size" | "openQuestions">;
}) {
  if (!run.outcome) return <EmptyValue />;
  return (
    <div className="list-cell-stack">
      <span className="list-text list-nowrap" title={TRIAGE_OUTCOME_DESCRIPTIONS[run.outcome]}>
        {TRIAGE_OUTCOME_LABELS[run.outcome]}
        {run.size && <> · {run.size}</>}
      </span>
      {run.openQuestions !== null && run.openQuestions > 0 && (
        <span className="list-secondary list-nowrap">
          {run.openQuestions} open {run.openQuestions === 1 ? "question" : "questions"}
        </span>
      )}
    </div>
  );
}

/** The list's column count, which a failed run's reason row spans. */
const TRIAGE_COLUMNS = 8;

function TriageTableRow({ run, isAdmin }: { run: TriageRunRow; isAdmin: boolean }) {
  const errorId = useListErrorId(run.error);
  const label = triageRunLabel(run);
  return (
    <>
      <TableRow data-has-error={run.error ? true : undefined}>
        <TableCell className="list-col-main">
          <Link
            href={triageRunHref(run.id)}
            className="list-title list-title-stacked"
            aria-describedby={errorId}
          >
            <span className="text-numeric list-nowrap">{label}</span>
            {run.issue?.title && <span className="list-title-text">{run.issue.title}</span>}
          </Link>
          <PhoneMeta>
            <TriageRunStatusBadge status={run.status} />
            <Timestamp iso={run.updatedAt} />
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          {run.repository ? (
            <span className="list-secondary text-numeric list-nowrap">
              <ProviderIcon provider={run.repository.provider} size={12} />
              {run.repository.fullPath}
            </span>
          ) : (
            <EmptyValue />
          )}
        </TableCell>
        <TableCell className={WIDE_COLUMN} aria-describedby={errorId}>
          <TriageRunStatusBadge status={run.status} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <TriageOutcomeSummary run={run} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <Badge variant="neutral" title={TRIAGE_TRIGGER_DESCRIPTIONS[run.trigger]}>
            {TRIAGE_TRIGGER_LABELS[run.trigger]}
          </Badge>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <AgentName agent={run.agent} isAdmin={isAdmin} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <Timestamp iso={run.updatedAt} />
        </TableCell>
        <TableCell className="list-actions">
          {run.issue?.url && (
            <ExternalRowLink href={run.issue.url} label={`Open ${label} in Linear`} />
          )}
        </TableCell>
      </TableRow>
      {run.error && <ListErrorRow error={run.error} colSpan={TRIAGE_COLUMNS} id={errorId} />}
    </>
  );
}

export function TriageRunsView({ runs, params, total, pageSize }: TriageRunsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const pageCount = totalPages(total, pageSize);
  const first = total === 0 ? 0 : (params.page - 1) * pageSize + 1;
  const last = (params.page - 1) * pageSize + runs.length;

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Triage" }]} />
      <main className="detail-main">
        <PageHeader
          title="Triage"
          description="Linear issues Omniralph turned into PRDs, and what each triage decided."
        />

        <Card>
          <CardHeader>
            <div className="list-card-header">
              <div>
                <CardTitle as="h2">Triage runs</CardTitle>
                <CardDescription>
                  {total === 0
                    ? "Newest first."
                    : `Newest first. Showing ${first}–${last} of ${total.toLocaleString()}.`}
                </CardDescription>
              </div>
              <NativeSelect
                aria-label="Filter by status"
                value={params.status ?? ""}
                onChange={(e) =>
                  router.push(
                    triageRunListHref(pathname, {
                      status: (e.target.value || null) as TriageRunListParams["status"],
                      page: 1,
                    }),
                  )
                }
              >
                <option value="">All statuses</option>
                {TRIAGE_RUN_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {stateLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </CardHeader>
          <CardContent className="list-card-content">
            {runs.length === 0 ? (
              <Empty
                icon={<IconClipboardText size={24} />}
                title={
                  total > 0
                    ? "No runs on this page"
                    : params.status
                      ? `No ${params.status} triage runs`
                      : "No triage runs yet"
                }
                titleAs="h3"
                description={
                  total > 0
                    ? "The page is past the last one."
                    : "Runs appear here when someone asks @Omniralph to /triage a Linear issue, or adds the triage label to one."
                }
              />
            ) : (
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Issue</TableHead>
                    <TableHead className={WIDE_COLUMN}>Repository</TableHead>
                    <TableHead className={WIDE_COLUMN}>Status</TableHead>
                    <TableHead className={WIDE_COLUMN}>Outcome</TableHead>
                    <TableHead className={WIDE_COLUMN}>Trigger</TableHead>
                    <TableHead className={WIDE_COLUMN}>Harness</TableHead>
                    <TableHead className={WIDE_COLUMN}>Updated</TableHead>
                    <TableHead aria-label="Links" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TriageTableRow key={run.id} run={run} isAdmin={isAdmin} />
                  ))}
                </TableBody>
              </Table>
            )}
            <ListPagination
              page={params.page}
              pageCount={pageCount}
              hrefFor={(page) => triageRunListHref(pathname, { ...params, page })}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
