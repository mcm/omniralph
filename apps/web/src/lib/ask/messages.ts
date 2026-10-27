import "server-only";
import {
  countFilesRead,
  getJob,
  getRepositoryWithConnection,
  listRunEvents,
  listThreadRuns,
  unifiedRunStatus,
  type ChatThread,
  type ChatThreadRun,
  type ChatWebMessage,
  type ChatWebMessageAuthor,
  type ChatWebMessageStatus,
  type Database,
  type Job,
  type RunStatus,
} from "@omniralph/db";
import { QueryRunResult, RunSpecJobPayload } from "@omniralph/shared";
import { fileWebUrl, repositoryWebUrl } from "@/lib/repositories/web-url";
import type { AskCard } from "@/lib/api/ask";
import { ChatThreadContext } from "@/lib/sinks/chat-thread";
import { askCards } from "./cards";
import { workItemIdentifiers, type AskWorkItem, type WorkItemResolver } from "./work-items";

/**
 * The message view model of a web chat (Ask): each stored message (`chat_web_messages`)
 * with, for Om's answer to a code question, the ask run it came from (status, duration,
 * files read), the files it cites linked on the code host, and the work items it mentions;
 * and the chat's in-flight ask, if any.
 */

/** The ask run an Om message came from. */
export interface AskMessageRun {
  /** The run's ID (`/runs/{id}`). */
  id: string;
  status: RunStatus;
  /** From the agent's result, else the job's timestamps; null while unknown. */
  durationMs: number | null;
  /** Distinct files the agent read. */
  filesRead: number;
}

/** A file an answer cites, linked on the code host at the branch it was read from. */
export interface AskFile {
  path: string;
  startLine: number | null;
  endLine: number | null;
  /** Null when the repository is gone. */
  url: string | null;
}

export interface AskMessage {
  id: string;
  author: ChatWebMessageAuthor;
  markdown: string;
  status: ChatWebMessageStatus;
  createdAt: string;
  /** For an Om answer relayed from an ask run; else null. */
  run: AskMessageRun | null;
  files: AskFile[];
  workItems: AskWorkItem[];
  /** The card it shows, in its current state (`lib/ask/cards.ts`); null for text. */
  card: AskCard | null;
}

/** The repository an ask reads. */
export interface AskRepository {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
}

/** The chat's ask that hasn't answered yet: waiting for an agent, or being read. */
export interface AskActivity {
  /** `queued` while no agent has claimed it. */
  state: "queued" | "running";
  repository: AskRepository | null;
  /** Distinct files read so far. */
  filesRead: number;
  /** The in-flight ask runs (their run events refresh the chat). */
  runIds: string[];
}

export interface AskMessagesDeps {
  db: Database;
  workItems: WorkItemResolver;
  now?: () => Date;
}

/** A job's run duration: the agent's reported `durationMs`, else finished minus started. */
export function jobDurationMs(
  job: Pick<Job, "result" | "startedAt" | "finishedAt">,
): number | null {
  const result = QueryRunResult.safeParse(job.result);
  if (result.success) return result.data.durationMs;
  if (!job.startedAt || !job.finishedAt) return null;
  return Math.max(0, job.finishedAt.getTime() - job.startedAt.getTime());
}

/** What an ask run's current attempt (its job) says about the message it answered. */
interface AskRunFacts {
  run: AskMessageRun;
  files: AskFile[];
}

async function askRunFacts(
  db: Database,
  thread: ChatThread,
  threadRun: ChatThreadRun,
  filesRead: ReadonlyMap<string, number>,
  job: Job | null,
): Promise<AskRunFacts | null> {
  if (!job || job.organizationId !== thread.organizationId) return null;
  const result = QueryRunResult.safeParse(job.result);
  const references = result.success ? result.data.references : [];
  let files: AskFile[] = [];
  if (references.length > 0) {
    const found = job.repositoryId
      ? await getRepositoryWithConnection(db, job.repositoryId, thread.organizationId)
      : null;
    const payload = RunSpecJobPayload.safeParse(job.payload);
    const context = payload.success && ChatThreadContext.safeParse(payload.data.trigger.context);
    // The branch the answer was read from: the chat's, for its own repo.
    const branch = (context && context.success && context.data.branch) || thread.branch;
    const repositoryUrl =
      found &&
      repositoryWebUrl(
        found.repository.provider,
        found.connection.baseUrl,
        found.repository.fullPath,
      );
    files = references.map((reference) => ({
      path: reference.path,
      startLine: reference.startLine ?? null,
      endLine: reference.endLine ?? null,
      url:
        found && repositoryUrl && branch
          ? fileWebUrl(found.repository.provider, repositoryUrl, branch, reference)
          : null,
    }));
  }
  return {
    run: {
      id: threadRun.id,
      status: unifiedRunStatus("ask", job.status),
      durationMs: jobDurationMs(job),
      filesRead: filesRead.get(job.id) ?? 0,
    },
    files,
  };
}

/** The current job of each of the thread's ask runs, by thread run ID. */
async function askJobs(
  db: Database,
  runs: readonly ChatThreadRun[],
): Promise<Map<string, Job | null>> {
  const entries = await Promise.all(
    runs.map(async (run) => [run.id, run.jobId ? await getJob(db, run.jobId) : null] as const),
  );
  return new Map(entries);
}

/** `rows` of a web chat (`thread`), in their order, as the web shows them. */
export async function askMessages(
  deps: AskMessagesDeps,
  thread: ChatThread,
  rows: readonly ChatWebMessage[],
): Promise<AskMessage[]> {
  const { db } = deps;
  const linked = new Set(rows.flatMap((row) => (row.threadRunId ? [row.threadRunId] : [])));
  const runs = linked.size
    ? (await listThreadRuns(db, thread.organizationId, thread.id)).filter(
        (run) => run.kind === "query" && linked.has(run.id),
      )
    : [];
  const jobs = await askJobs(db, runs);
  const filesRead = await countFilesRead(
    db,
    [...jobs.values()].flatMap((job) => (job ? [job.id] : [])),
  );
  const cards = await askCards(db, thread, rows, deps.now?.());
  const facts = new Map<string, AskRunFacts>();
  for (const run of runs) {
    const fact = await askRunFacts(db, thread, run, filesRead, jobs.get(run.id) ?? null);
    if (fact) facts.set(run.id, fact);
  }

  // One lookup per message, of the identifiers it mentions.
  const workItemsOf = async (markdown: string) => {
    const identifiers = workItemIdentifiers(markdown);
    return identifiers.length > 0 ? deps.workItems.resolve(thread.organizationId, identifiers) : [];
  };

  return Promise.all(
    rows.map(async (row): Promise<AskMessage> => {
      const fact = row.threadRunId ? facts.get(row.threadRunId) : undefined;
      const om = row.author === "om";
      return {
        id: row.id,
        author: row.author,
        markdown: row.markdown,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        run: om ? (fact?.run ?? null) : null,
        files: om ? (fact?.files ?? []) : [],
        workItems: om && row.status === "complete" ? await workItemsOf(row.markdown) : [],
        card: cards.get(row.id) ?? null,
      };
    }),
  );
}

/** Job statuses of an ask that hasn't finished. */
const IN_FLIGHT = new Set<Job["status"]>(["queued", "running"]);

/**
 * The chat's ask that hasn't answered yet: its job is queued or running, or it finished
 * and its answer is waiting to be relayed. Null when there is none.
 */
export async function askActivity(db: Database, thread: ChatThread): Promise<AskActivity | null> {
  const runs = (await listThreadRuns(db, thread.organizationId, thread.id)).filter(
    (run) => run.kind === "query",
  );
  if (runs.length === 0) return null;
  const jobs = await askJobs(db, runs);
  const relaying = new Set(
    (await listRunEvents(db, thread.organizationId, thread.id, { pending: true })).flatMap(
      (event) => (event.kind === "response" ? [event.threadRunId] : []),
    ),
  );
  const inFlight = runs.flatMap((run) => {
    const job = jobs.get(run.id);
    if (!job || job.organizationId !== thread.organizationId) return [];
    return IN_FLIGHT.has(job.status) || relaying.has(run.id) ? [{ run, job }] : [];
  });
  if (inFlight.length === 0) return null;
  const filesRead = await countFilesRead(
    db,
    inFlight.map(({ job }) => job.id),
  );
  const newest = inFlight.at(-1)!;
  const found = newest.job.repositoryId
    ? await getRepositoryWithConnection(db, newest.job.repositoryId, thread.organizationId)
    : null;
  return {
    state: inFlight.some(({ job }) => job.status !== "queued") ? "running" : "queued",
    repository: found && {
      id: found.repository.id,
      provider: found.repository.provider,
      fullPath: found.repository.fullPath,
    },
    filesRead: inFlight.reduce((sum, { job }) => sum + (filesRead.get(job.id) ?? 0), 0),
    runIds: inFlight.map(({ run }) => run.id),
  };
}
