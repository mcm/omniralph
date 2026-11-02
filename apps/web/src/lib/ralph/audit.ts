/**
 * The epic audit of a story run: once every task of an epic is done, before its
 * PR/MR opens, a query run of the story playbook's audit (`auditTaskId`,
 * `builtin:audit-epic` by default) checks the epic's requirements (`## Requirements`,
 * or a legacy PRD's `## Functional Requirements`) against a checkout of its main
 * lane. It is invoked as the PR description is (`RunInvoker { kind: "ralph-run" }`,
 * the `run-result` sink hands its findings back), and its outcome is applied by
 * `applyAuditJob` under the run's row lock. Each gap becomes a new task of the
 * epic, which the run works; the epic is audited again once those are done, up
 * to the story playbook's `maxAuditRounds`. After the last round, the PR/MR opens
 * anyway and its description lists the gaps left (`withRemainingGaps`). A failed
 * audit is noted in the thread and never holds the PR/MR up. Each audit is kept in
 * the run's `audits`.
 */
import {
  getJob,
  getMainLane,
  getRepositoryWithConnection,
  listRunHiddenRefs,
  updateRun,
  type Job,
  type RalphEpicAudit,
  type RalphRequirementFindingRecord,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import {
  epicRequirements,
  isStoryDone,
  MAX_PULL_REQUEST_BODY_LENGTH,
  type Epic,
  type Story,
} from "@omniralph/ralph";
import {
  excerpt,
  MAX_AUDITED_REQUIREMENTS,
  RALPH_AUDIT_EPIC_JOB_TYPE,
  RalphAuditEpicPayload,
  RalphAuditEpicTriggerContext,
  RunSpecJobPayload,
} from "@omniralph/shared";
import { organizationPlaybooks } from "@/lib/playbooks";
import { jobRepository } from "@/lib/scm/adapters";
import {
  auditEpicJobInput,
  epicAuditFor,
  epicAuditOf,
  pushTimingFor,
  storyCodingSettings,
} from "./coding";
import { conversationFor } from "./conversation";
import { runDedupeKey } from "./dedupe";
import { laneAgentId } from "./lanes";
import { postActivity } from "./notify";
import { fileAuditGaps, jobFailure, type AuditGap } from "./outcome";
import { jobSettings } from "./payload";
import type { RalphDeps } from "./run";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);
/** Longest requirement text or acceptance criterion passed to the audit. */
const MAX_TEXT_LENGTH = 4000;
/** Most acceptance criteria per task passed to the audit. */
const MAX_CRITERIA_PER_TASK = 100;
/** Most tasks passed to the audit. */
const MAX_TASKS = 200;
const MAX_DOCUMENT_LENGTH = 200_000;

/** What starting the audit of a finished epic did (`auditBeforePublishing`). */
export type AuditStep =
  /** The audit job was enqueued (`jobId`); its outcome advances the run. */
  | { kind: "auditing"; run: RalphRun; jobId: string }
  /** Another of the run's jobs is still active. */
  | { kind: "busy"; run: RalphRun }
  /** Nothing to audit now (done, skipped, failed or out of rounds): publish. */
  | { kind: "publish"; run: RalphRun };

/** Audits that judged the epic (passed or found gaps): they count as rounds. */
function judgedRounds(audits: readonly RalphEpicAudit[]): number {
  return audits.filter((a) => a.status === "passed" || a.status === "gaps").length;
}

/** Whether `audit` ran with every one of the epic's tasks now (no task was added since). */
function coversStories(audit: RalphEpicAudit, rows: readonly RalphStory[]): boolean {
  const audited = new Set(audit.storyIssueIds);
  return rows.every((r) => audited.has(r.trackerIssueId));
}

/** `count` requirements, in words. */
function requirementsNoun(count: number): string {
  return count === 1 ? "its requirement" : `its ${count} requirements`;
}

/**
 * Before a finished epic's PR/MR opens: audits it against its requirements, unless an
 * audit already ran with every one of its tasks (it passed, its last round found gaps
 * left, or it couldn't audit), the epic lists no requirements (skipped with a thread
 * note), its audit rounds are used up, or the main repo's story playbook has no audit.
 * Single issues and request-mode runs aren't audited. Runs inside the run's row lock.
 */
export async function auditBeforePublishing(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; stories: readonly Story[]; rows: readonly RalphStory[] },
): Promise<AuditStep> {
  const publish = { kind: "publish" as const, run };
  if (run.kind === "single" || run.mode === "request" || !run.repositoryId) return publish;
  const latest = run.audits.at(-1);
  if (latest?.status === "running") return { kind: "busy", run };
  if (latest && coversStories(latest, input.rows)) return publish;

  const found = await getRepositoryWithConnection(deps.db, run.repositoryId);
  const lane = await getMainLane(tx, run);
  if (!found || found.repository.disconnectedAt || !lane) return publish;
  const { repository, connection } = found;
  const playbooks = organizationPlaybooks(deps.db, run.organizationId);
  const settings = await epicAuditFor(repository, playbooks);
  if (!settings) return publish;

  const now = new Date().toISOString();
  const record = (audit: Partial<RalphEpicAudit> & Pick<RalphEpicAudit, "status">) =>
    updateRun(tx, run.id, {
      audits: [
        ...run.audits,
        {
          round: judgedRounds(run.audits) + 1,
          jobId: null,
          storyIssueIds: input.rows.map((r) => r.trackerIssueId),
          commitSha: null,
          requirements: [],
          summary: null,
          error: null,
          filed: [],
          startedAt: now,
          finishedAt: now,
          ...audit,
        },
      ],
    });

  const requirements = epicRequirements(input.epic.description)
    .map((r) => ({ id: r.id.slice(0, 64), text: r.text.trim().slice(0, MAX_TEXT_LENGTH) }))
    .filter((r) => r.text)
    .slice(0, MAX_AUDITED_REQUIREMENTS);
  if (requirements.length === 0) {
    const updated = (await record({ status: "skipped" })) ?? run;
    await postActivity(conversationFor(run, deps), {
      type: "thought",
      body: `**${input.epic.identifier}** lists no requirements (no \`## Requirements\` or \`## Functional Requirements\`), so I'm not auditing it before the ${termFor(repository.provider)} opens.`,
    });
    return { kind: "publish", run: updated };
  }
  const round = judgedRounds(run.audits) + 1;
  // Out of rounds: the PR/MR opens with the gaps the last round left.
  if (round > settings.maxRounds) return publish;

  // A story playbook that pushes only at the end keeps the commits on the run's hidden ref.
  const commitSha =
    (await pushTimingFor(repository, playbooks)) === "end"
      ? ((await listRunHiddenRefs(tx, run.id)).find((r) => r.repositoryId === repository.id)?.sha ??
        null)
      : null;
  const coding = await storyCodingSettings(repository, playbooks);
  const parsed = RalphAuditEpicPayload.safeParse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository, coding),
    epic: {
      identifier: input.epic.identifier,
      title: input.epic.title.slice(0, 1000),
      prd: input.epic.description.slice(0, MAX_DOCUMENT_LENGTH),
    },
    requirements,
    tasks: input.stories
      .filter(isStoryDone)
      .slice(0, MAX_TASKS)
      .map((s) => ({
        identifier: (s.identifier ?? s.storyId).slice(0, 64),
        title: s.title.slice(0, 1000),
        repository: s.repo && s.repo.id !== repository.id ? s.repo.name.slice(0, 500) : null,
        acceptanceCriteria: s.acceptanceCriteria
          .map((c) => c.trim().slice(0, MAX_TEXT_LENGTH))
          .filter(Boolean)
          .slice(0, MAX_CRITERIA_PER_TASK),
      })),
    commitSha,
    round,
    maxRounds: settings.maxRounds,
  });
  const routing = parsed.success
    ? await auditEpicJobInput(settings.taskId, parsed.data, playbooks)
    : "the epic couldn't be described to the audit";
  if (typeof routing === "string") {
    const updated = (await record({ status: "failed", error: routing, round })) ?? run;
    await postActivity(conversationFor(run, deps), {
      type: "thought",
      body: `⚠️ I couldn't audit **${input.epic.identifier}** against its requirements (${routing}), so the ${termFor(repository.provider)} opens without it.`,
    });
    return { kind: "publish", run: updated };
  }
  const { job, created } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: RALPH_AUDIT_EPIC_JOB_TYPE,
    ...routing,
    repositoryId: repository.id,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetAgentId: await laneAgentId(deps.db, run, lane),
  });
  if (!created) return { kind: "busy", run };
  const updated =
    (await updateRun(tx, run.id, {
      status: "running",
      waitingOn: null,
      error: null,
      audits: [
        ...run.audits,
        {
          round,
          jobId: job.id,
          status: "running",
          storyIssueIds: input.rows.map((r) => r.trackerIssueId),
          commitSha,
          requirements: [],
          summary: null,
          error: null,
          filed: [],
          startedAt: now,
          finishedAt: null,
        },
      ],
    })) ?? run;
  const done = input.stories.filter(isStoryDone).length;
  await postActivity(conversationFor(run, deps), {
    type: "thought",
    body: `🧾 ${done === 1 ? "The task is" : `All ${done} tasks are`} done. Auditing **${input.epic.identifier}** against ${requirementsNoun(requirements.length)} before the ${termFor(repository.provider)} opens (round ${round}/${settings.maxRounds}).`,
  });
  return { kind: "auditing", run: updated, jobId: job.id };
}

/** "pull request" or "merge request". */
function termFor(provider: string): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** An audit job's `ralph.audit-epic` payload, in its query run's trigger context; null when it has none. */
export function auditEpicPayload(job: Pick<Job, "payload">): RalphAuditEpicPayload | null {
  const spec = RunSpecJobPayload.safeParse(job.payload);
  const context = spec.success
    ? RalphAuditEpicTriggerContext.safeParse(spec.data.trigger.context)
    : null;
  return context?.success ? context.data.payload : null;
}

/** A finished audit, with what the run does with it (`auditOutcome`). */
export type AuditOutcome =
  /** Every requirement is met. */
  | { kind: "passed"; audit: RalphEpicAudit }
  /** Requirements aren't met: `gaps`. */
  | { kind: "gaps"; audit: RalphEpicAudit; gaps: AuditGap[] }
  /** The audit couldn't check the epic. */
  | { kind: "failed"; audit: RalphEpicAudit };

/**
 * The outcome of a finished audit job, before it's stored: its findings matched to the
 * requirements it was given (by ID; findings for other IDs are dropped, a requirement it
 * didn't report on isn't a gap). An audit that answered nothing usable, or matched no
 * requirement, failed.
 */
export function auditOutcome(audit: RalphEpicAudit, job: Job | null, now: Date): AuditOutcome {
  const finished = { ...audit, finishedAt: now.toISOString() };
  const fail = (error: string): AuditOutcome => ({
    kind: "failed",
    audit: { ...finished, status: "failed", error },
  });
  if (job?.status !== "completed") return fail(jobFailure(job));
  const payload = auditEpicPayload(job);
  if (!payload) return fail("the audit has no requirements to check");
  const answer = epicAuditOf(job);
  if (answer.kind === "failed") return fail(answer.error);
  const byId = new Map(answer.result.requirements.map((f) => [f.id.toUpperCase(), f]));
  const requirements: RalphRequirementFindingRecord[] = [];
  const gaps: AuditGap[] = [];
  for (const requirement of payload.requirements) {
    const finding = byId.get(requirement.id.toUpperCase());
    if (!finding) continue;
    requirements.push({
      id: requirement.id,
      text: requirement.text,
      status: finding.status,
      evidence: finding.evidence,
      missing: finding.missing,
    });
    if (finding.status === "gap") {
      gaps.push({ ...requirement, missing: finding.missing, title: finding.title });
    }
  }
  if (requirements.length === 0) return fail("the audit reported on none of the requirements");
  const checked = { ...finished, requirements, summary: answer.result.summary || null };
  return gaps.length > 0
    ? { kind: "gaps", audit: { ...checked, status: "gaps" }, gaps }
    : { kind: "passed", audit: { ...checked, status: "passed" } };
}

/** The audit's evidence list, as the thread shows it: each requirement met or missing. */
export function auditEvidence(audit: Pick<RalphEpicAudit, "requirements" | "summary">): string {
  const lines = audit.requirements.map((r) =>
    r.status === "met"
      ? `- ✅ **${r.id}**: ${excerpt(r.evidence.trim() || "met", 600)}`
      : `- ❌ **${r.id}**: ${excerpt(r.missing.trim() || "not met", 600)}${r.evidence.trim() ? ` (${excerpt(r.evidence.trim(), 300)})` : ""}`,
  );
  return [...lines, ...(audit.summary ? ["", excerpt(audit.summary, 1500)] : [])].join("\n");
}

/**
 * Applies the run's finished audit (its latest `running` one) under the run's row lock:
 * the findings are stored and their evidence posted to the thread. A round that found
 * gaps with rounds left files each one as a task of the epic (`fileAuditGaps`), which the
 * run works before auditing again; on the last round the gaps are left for the PR/MR
 * description. An audit that couldn't check is noted and the PR/MR opens without it.
 * Returns whether its job is still queued or running.
 */
export async function applyAuditJob(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<{ busy: boolean }> {
  const latest = run.audits.at(-1);
  if (latest?.status !== "running" || !latest.jobId) return { busy: false };
  const job = await getJob(deps.db, latest.jobId);
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) return { busy: true };

  const outcome = auditOutcome(latest, job, new Date());
  const maxRounds = (job && auditEpicPayload(job)?.maxRounds) ?? latest.round;
  const term = termFor(job ? (auditEpicPayload(job)?.repository.provider ?? "github") : "github");
  const conversation = conversationFor(run, deps);
  const store = (audit: RalphEpicAudit) =>
    updateRun(tx, run.id, { audits: [...run.audits.slice(0, -1), audit] });
  if (outcome.kind === "failed") {
    await store(outcome.audit);
    await postActivity(conversation, {
      type: "thought",
      body: `⚠️ I couldn't audit **${run.trackerIdentifier}** against its requirements (${outcome.audit.error}), so the ${term} opens without it.`,
    });
    return { busy: false };
  }
  const { audit } = outcome;
  const met = audit.requirements.filter((r) => r.status === "met").length;
  const heading = `🧾 Audit of **${run.trackerIdentifier}** (round ${audit.round}/${maxRounds}): ${met}/${audit.requirements.length} requirements met.`;
  if (outcome.kind === "passed") {
    await store(audit);
    await postActivity(conversation, {
      type: "thought",
      body: `${heading}\n\n${auditEvidence(audit)}\n\nEvery requirement is met, so the ${term} opens next.`,
    });
    return { busy: false };
  }
  if (audit.round >= maxRounds) {
    await store(audit);
    await postActivity(conversation, {
      type: "thought",
      body: `${heading}\n\n${auditEvidence(audit)}\n\nThat was the last audit round, so the ${term} opens anyway and its description lists the gaps left.`,
    });
    return { busy: false };
  }
  const filing = await fileAuditGaps({ ...deps, tx, run }, outcome.gaps, audit.round);
  await store({ ...audit, filed: filing.filed });
  const next =
    filing.filed.length > 0
      ? `Filed ${filing.filed.map((id) => `**${id}**`).join(", ")} as ${filing.filed.length === 1 ? "a new task" : "new tasks"} of **${run.trackerIdentifier}**; I'll audit it again once ${filing.filed.length === 1 ? "it's" : "they're"} done.`
      : "";
  const failed =
    filing.failed.length > 0
      ? `I couldn't file ${filing.failed.map((t) => `"${t}"`).join(", ")}${filing.filed.length === 0 ? `, so the ${term} opens with the gaps listed in its description` : ""}.`
      : "";
  await postActivity(conversation, {
    type: "thought",
    body: `${heading}\n\n${auditEvidence(audit)}\n\n${[next, failed].filter(Boolean).join(" ")}`,
  });
  return { busy: false };
}

/** The gaps the run's latest audit left (it found gaps and no audit ran since): for the PR/MR description. */
export function remainingGaps(run: Pick<RalphRun, "audits">): RalphRequirementFindingRecord[] {
  const latest = run.audits.at(-1);
  return latest?.status === "gaps" ? latest.requirements.filter((r) => r.status === "gap") : [];
}

/**
 * A PR/MR description with the gaps the epic's audit left listed at its end (the body
 * cut to make room when it's long). Unchanged without gaps.
 */
export function withRemainingGaps(
  text: { title: string; body: string },
  gaps: readonly RalphRequirementFindingRecord[],
): { title: string; body: string } {
  if (gaps.length === 0) return text;
  const section = [
    "",
    "",
    "## Remaining gaps",
    "",
    "The audit of the epic against its requirements found these not met after its last round:",
    "",
    ...gaps.map(
      (g) =>
        `- **${g.id}**: ${excerpt(g.text.replace(/\s+/g, " ").trim(), 500)}${g.missing.trim() ? ` Missing: ${excerpt(g.missing.replace(/\s+/g, " ").trim(), 800)}` : ""}`,
    ),
  ]
    .join("\n")
    .slice(0, Math.floor(MAX_PULL_REQUEST_BODY_LENGTH / 2));
  const room = MAX_PULL_REQUEST_BODY_LENGTH - section.length;
  const body = text.body.length > room ? `${text.body.slice(0, room - 1)}…` : text.body;
  return { title: text.title, body: `${body.trimEnd()}${section}` };
}
