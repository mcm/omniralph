"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
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
import {
  IconBrandDiscord,
  IconBrandSlack,
  IconExternalLink,
  IconPlugConnected,
  IconRepeat,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ExternalRowLink, PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { ListErrorRow, useListErrorId } from "@/components/list-error";
import { ListPagination } from "@/components/list-pagination";
import { PageHeader } from "@/components/page-header";
import { RalphRunStatusBadge } from "@/components/ralph-badges";
import { totalPages } from "@/lib/pagination";
import {
  RALPH_RUN_STATUSES,
  ralphRunListHref,
  type RalphRepositoryRef,
  type RalphRunListParams,
  type RalphRunRow,
  runSourceLabel,
} from "@/lib/ralph/display";
import { ProviderIcon } from "../repositories/repositories-view";
import { EmptyValue } from "@/components/empty-value";
import { stateLabel } from "@/lib/state-variants";

interface RalphRunsViewProps {
  runs: RalphRunRow[];
  /** Repositories to filter by. */
  repositories: RalphRepositoryRef[];
  params: RalphRunListParams;
  total: number;
  pageSize: number;
  /** False while no Linear workspace is connected: no runs can start. */
  linearConnected: boolean;
}

/** The run's Linear issue: identifier and title, linked to Linear when the URL is known. */
export function LinearIssueLink({
  identifier,
  title,
  url,
}: {
  identifier: string;
  title: string | null;
  url: string | null;
}) {
  const content = (
    <>
      <span className="text-numeric list-nowrap">{identifier}</span>
      {title && <span>{title}</span>}
    </>
  );
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="run-source">
      {content}
      <IconExternalLink size={12} className="shrink-0" />
    </a>
  ) : (
    <span className="run-source">{content}</span>
  );
}

/**
 * Where the run came from: its Linear issue (`LinearIssueLink`), or the chat
 * platform and channel of a run started from chat.
 */
export function RunSource({
  run,
  showTitle = true,
}: {
  run: Pick<
    RalphRunRow,
    "origin" | "linearIdentifier" | "linearTitle" | "linearUrl" | "chatThread"
  >;
  showTitle?: boolean;
}) {
  if (run.origin === "linear" && run.linearIdentifier) {
    return (
      <LinearIssueLink
        identifier={run.linearIdentifier}
        title={showTitle ? run.linearTitle : null}
        url={run.linearUrl}
      />
    );
  }
  const Icon = run.chatThread?.platform === "discord" ? IconBrandDiscord : IconBrandSlack;
  return (
    <span className="run-source">
      {run.chatThread && <Icon size={12} className="shrink-0" />}
      <span className="text-numeric list-nowrap">{runSourceLabel(run)}</span>
    </span>
  );
}

/** The run's PR/MR, linked to the code host. */
export function PullRequestLink({ pullRequest }: { pullRequest: RalphRunRow["pullRequest"] }) {
  if (!pullRequest) return <EmptyValue />;
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      className="list-secondary list-text-primary text-numeric list-nowrap"
      aria-label={`Open ${pullRequest.label} on the code host`}
    >
      {pullRequest.label}
      <IconExternalLink size={12} />
    </a>
  );
}

/** The run's agent, linked to its page for admins. */
export function AgentName({ agent, isAdmin }: { agent: RalphRunRow["agent"]; isAdmin: boolean }) {
  if (!agent) return <EmptyValue />;
  return isAdmin ? (
    <Link href={`/harnesses/${agent.id}`} className="list-text list-text-primary">
      {agent.name}
    </Link>
  ) : (
    <span className="list-text">{agent.name}</span>
  );
}

/** Shown while no Linear workspace is connected. */
export function LinearNotConnected({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Alert variant="warning">
      <IconPlugConnected size={16} />
      <AlertTitle as="h2">Linear isn&apos;t connected</AlertTitle>
      <AlertDescription>
        Coding tasks start when a Linear issue is delegated to the Omniralph app.{" "}
        {isAdmin ? (
          <>
            Connect a workspace in{" "}
            <Link href="/settings/integrations" className="text-text-primary">
              Settings › Integrations
            </Link>
            .
          </>
        ) : (
          "Ask an admin to connect a workspace in Settings › Integrations."
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Where a run's source lives outside the panel: its Linear issue (null for chat runs). */
function externalSource(run: RalphRunRow): { href: string; label: string } | null {
  if (run.origin !== "linear" || !run.linearUrl) return null;
  return { href: run.linearUrl, label: `Open ${runSourceLabel(run)} in Linear` };
}

/** The runs table's column count, which a failed run's reason row spans. */
const RUN_COLUMNS = 8;

function RunTableRow({ run, isAdmin }: { run: RalphRunRow; isAdmin: boolean }) {
  const external = externalSource(run);
  const title = run.origin === "linear" ? run.linearTitle : null;
  const errorId = useListErrorId(run.error);
  return (
    <>
      <TableRow data-has-error={run.error ? true : undefined}>
        <TableCell className="list-col-main">
          <Link
            href={`/coding/${run.id}`}
            className="list-title list-title-stacked"
            aria-describedby={errorId}
          >
            <span className="text-numeric list-nowrap">{runSourceLabel(run)}</span>
            {title && <span className="list-title-text">{title}</span>}
          </Link>
          <PhoneMeta>
            <RalphRunStatusBadge status={run.status} />
            <Timestamp iso={run.updatedAt} />
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <div className="list-cell-stack">
            {run.repository ? (
              <span className="list-secondary text-numeric list-nowrap">
                <ProviderIcon provider={run.repository.provider} size={12} />
                {run.repository.fullPath}
              </span>
            ) : (
              <span className="list-secondary">Not chosen yet</span>
            )}
            {run.branch && (
              <span className="list-secondary text-numeric list-nowrap">{run.branch}</span>
            )}
          </div>
        </TableCell>
        <TableCell className={WIDE_COLUMN} aria-describedby={errorId}>
          <RalphRunStatusBadge status={run.status} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <span className="list-text text-numeric list-nowrap">
            {run.stories.completed} / {run.stories.total}
          </span>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <PullRequestLink pullRequest={run.pullRequest} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <AgentName agent={run.agent} isAdmin={isAdmin} />
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <Timestamp iso={run.updatedAt} />
        </TableCell>
        <TableCell className="list-actions">
          {external && <ExternalRowLink href={external.href} label={external.label} />}
        </TableCell>
      </TableRow>
      {run.error && <ListErrorRow error={run.error} colSpan={RUN_COLUMNS} id={errorId} />}
    </>
  );
}

export function RalphRunsView({
  runs,
  repositories,
  params,
  total,
  pageSize,
  linearConnected,
}: RalphRunsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const pageCount = totalPages(total, pageSize);
  const filtered = params.status !== null || params.repositoryId !== null;
  const first = total === 0 ? 0 : (params.page - 1) * pageSize + 1;
  const last = (params.page - 1) * pageSize + runs.length;

  const setFilter = (change: Partial<RalphRunListParams>) =>
    router.push(ralphRunListHref(pathname, { ...params, ...change, page: 1 }));

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Coding tasks" }]} />
      <main className="detail-main">
        <PageHeader
          title="Coding tasks"
          description="Linear epics and issues delegated to Omniralph, built story by story."
        />

        {!linearConnected && total > 0 && <LinearNotConnected isAdmin={isAdmin} />}

        <Card>
          <CardHeader>
            <div className="list-card-header">
              <div>
                <CardTitle as="h2">Runs</CardTitle>
                <CardDescription>
                  {total === 0
                    ? "Newest first."
                    : `Newest first. Showing ${first}–${last} of ${total.toLocaleString()}.`}
                </CardDescription>
              </div>
              <div className="list-filters">
                <NativeSelect
                  aria-label="Filter by status"
                  value={params.status ?? ""}
                  onChange={(e) =>
                    setFilter({ status: (e.target.value || null) as RalphRunListParams["status"] })
                  }
                >
                  <option value="">All statuses</option>
                  {RALPH_RUN_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {stateLabel(s)}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Filter by repository"
                  value={params.repositoryId ?? ""}
                  onChange={(e) => setFilter({ repositoryId: e.target.value || null })}
                >
                  <option value="">All repositories</option>
                  {repositories.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullPath}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          </CardHeader>
          <CardContent className="list-card-content">
            {total === 0 && !filtered && !linearConnected ? (
              <Empty
                icon={<IconPlugConnected size={24} />}
                title="Connect Linear to start coding tasks"
                titleAs="h3"
                description={
                  isAdmin
                    ? "Runs start when a Linear issue is delegated to the Omniralph app. Connect your Linear workspace first."
                    : "Runs start when a Linear issue is delegated to the Omniralph app. Ask an admin to connect your Linear workspace in Settings › Integrations."
                }
                action={
                  isAdmin ? (
                    <Button asChild>
                      <Link href="/settings/integrations">
                        <IconPlugConnected size={14} />
                        Settings › Integrations
                      </Link>
                    </Button>
                  ) : undefined
                }
              />
            ) : runs.length === 0 ? (
              <Empty
                icon={<IconRepeat size={24} />}
                title={
                  total > 0
                    ? "No runs on this page"
                    : filtered
                      ? "No runs match these filters"
                      : "No coding tasks yet"
                }
                titleAs="h3"
                description={
                  total > 0
                    ? "The page is past the last one."
                    : "Runs appear here when a Linear epic or issue is delegated to the Omniralph app and routed to a repository with coding enabled."
                }
              />
            ) : (
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead className={`${WIDE_COLUMN} list-nowrap`}>
                      Repository / branch
                    </TableHead>
                    <TableHead className={WIDE_COLUMN}>Status</TableHead>
                    <TableHead className={WIDE_COLUMN}>Stories</TableHead>
                    <TableHead className={`${WIDE_COLUMN} list-nowrap`}>PR / MR</TableHead>
                    <TableHead className={WIDE_COLUMN}>Harness</TableHead>
                    <TableHead className={WIDE_COLUMN}>Updated</TableHead>
                    <TableHead aria-label="Links" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <RunTableRow key={run.id} run={run} isAdmin={isAdmin} />
                  ))}
                </TableBody>
              </Table>
            )}
            <ListPagination
              page={params.page}
              pageCount={pageCount}
              hrefFor={(page) => ralphRunListHref(pathname, { ...params, page })}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
