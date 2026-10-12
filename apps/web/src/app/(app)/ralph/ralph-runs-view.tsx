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
  Muted,
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
  IconChevronRight,
  IconExternalLink,
  IconPlugConnected,
  IconRepeat,
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ListPagination } from "@/components/list-pagination";
import { RalphRunStatusBadge } from "@/components/ralph-badges";
import { formatDateTime } from "@/lib/format-date";
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

const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
const column = { display: "flex", flexDirection: "column", gap: "var(--space-1)" } as const;
const externalLink = {
  color: "var(--text-primary)",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
} as const;

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
      <span style={{ fontFamily: "var(--font-mono)" }}>{identifier}</span>
      {title && <span>{title}</span>}
    </>
  );
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{ ...externalLink, fontSize: "var(--text-sm)" }}
    >
      {content}
      <IconExternalLink size={12} style={{ flexShrink: 0 }} />
    </a>
  ) : (
    <span style={{ ...externalLink, fontSize: "var(--text-sm)" }}>{content}</span>
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
    <span style={{ ...externalLink, fontSize: "var(--text-sm)" }}>
      {run.chatThread && <Icon size={12} style={{ flexShrink: 0 }} />}
      <span style={{ fontFamily: "var(--font-mono)" }}>{runSourceLabel(run)}</span>
    </span>
  );
}

/** The run's PR/MR, linked to the code host. */
export function PullRequestLink({ pullRequest }: { pullRequest: RalphRunRow["pullRequest"] }) {
  if (!pullRequest) return <Muted>—</Muted>;
  return (
    <a href={pullRequest.url} target="_blank" rel="noreferrer" style={{ ...externalLink, ...mono }}>
      {pullRequest.label}
      <IconExternalLink size={12} />
    </a>
  );
}

/** The run's agent, linked to its page for admins. */
export function AgentName({ agent, isAdmin }: { agent: RalphRunRow["agent"]; isAdmin: boolean }) {
  if (!agent) return <Muted>—</Muted>;
  return isAdmin ? (
    <Link
      href={`/harnesses/${agent.id}`}
      style={{ ...cellText, color: "var(--text-primary)", textDecoration: "none" }}
    >
      {agent.name}
    </Link>
  ) : (
    <span style={cellText}>{agent.name}</span>
  );
}

/** Shown while no Linear workspace is connected. */
export function LinearNotConnected({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Alert variant="warning">
      <IconPlugConnected size={16} />
      <AlertTitle>Linear isn&apos;t connected</AlertTitle>
      <AlertDescription>
        Ralph runs start when a Linear issue is delegated to the Omniralph app.{" "}
        {isAdmin ? (
          <>
            Connect a workspace in{" "}
            <Link href="/settings/integrations" style={{ color: "var(--text-primary)" }}>
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

function RunTableRow({ run, isAdmin }: { run: RalphRunRow; isAdmin: boolean }) {
  return (
    <TableRow>
      <TableCell>
        <RunSource run={run} />
      </TableCell>
      <TableCell>
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
              <ProviderIcon provider={run.repository.provider} size={12} />
              {run.repository.fullPath}
            </>
          ) : (
            "Not chosen yet"
          )}
        </span>
      </TableCell>
      <TableCell>
        <div style={column}>
          <RalphRunStatusBadge status={run.status} />
          {run.error && (
            <Muted title={run.error} style={{ maxWidth: "calc(var(--space-8) * 10)" }}>
              {run.error.length > 80 ? `${run.error.slice(0, 80)}…` : run.error}
            </Muted>
          )}
        </div>
      </TableCell>
      <TableCell>
        <span style={cellText}>
          {run.stories.completed} / {run.stories.total}
        </span>
      </TableCell>
      <TableCell>
        <span style={{ ...mono, color: "var(--text-secondary)" }}>{run.branch}</span>
      </TableCell>
      <TableCell>
        <PullRequestLink pullRequest={run.pullRequest} />
      </TableCell>
      <TableCell>
        <AgentName agent={run.agent} isAdmin={isAdmin} />
      </TableCell>
      <TableCell>
        <span style={cellText}>{formatDateTime(run.updatedAt)}</span>
      </TableCell>
      <TableCell style={{ textAlign: "right" }}>
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label={`Run of ${runSourceLabel(run)}`}
          title="View run"
        >
          <Link href={`/ralph/${run.id}`}>
            <IconChevronRight size={14} />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
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
      <AppHeader breadcrumbs={[{ label: "Ralph runs" }]} />
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
        <div>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>Ralph runs</h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Linear epics and issues delegated to Omniralph, built story by story.
          </Muted>
        </div>

        {!linearConnected && total > 0 && <LinearNotConnected isAdmin={isAdmin} />}

        <Card>
          <CardHeader>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "var(--space-4)",
                flexWrap: "wrap",
              }}
            >
              <div>
                <CardTitle>Runs</CardTitle>
                <CardDescription>
                  {total === 0
                    ? "Newest first."
                    : `Newest first. Showing ${first}–${last} of ${total.toLocaleString()}.`}
                </CardDescription>
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
                      {s}
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
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {total === 0 && !filtered && !linearConnected ? (
              <Empty
                icon={<IconPlugConnected size={24} />}
                title="Connect Linear to start ralph runs"
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
                      : "No ralph runs yet"
                }
                description={
                  total > 0
                    ? "The page is past the last one."
                    : "Runs appear here when a Linear epic or issue is delegated to the Omniralph app and routed to a repository with ralph enabled."
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Linear issue</TableHead>
                    <TableHead>Repository</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Stories</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>PR / MR</TableHead>
                    <TableHead>Harness</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead aria-label="Actions" />
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
