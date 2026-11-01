import "server-only";
/**
 * A run's open question on the wire (the run detail's `question`, the Inbox `question`
 * item's) and its answer from Omniralph (`POST /api/ui/runs/{id}/answer`). The questions are
 * the Inbox's (`listRunQuestions` in `@omniralph/db`, same keys); each option maps to the
 * reply text the question's matcher takes, so an answer here runs the same code as a reply
 * in the run's Linear session or chat thread (`answerRunQuestion`).
 */
import {
  answerRunPermissionRequest,
  getRun,
  getTriageRun,
  listRunQuestions,
  loadInboxReferences,
  type Database,
  type InboxQuestionCandidate,
  type InboxQuestionSubject,
  type RunIndexEntry,
  type RunRepository,
} from "@omniralph/db";
import {
  DELETE_BRANCH,
  DROP_STASHES,
  PERMISSION_ALLOW,
  PERMISSION_DENY,
  PREPARATION_LATER,
  PREPARATION_MYSELF,
  PREPARATION_RUN,
  PUSH_BRANCH,
  PUSH_STASHES,
} from "@omniralph/ralph";
import { ApiRouteError } from "@/lib/api/handler";
import type { RunAnswerRequest, RunQuestion } from "@/lib/api/runs";
import type { ActivityContent } from "@omniralph/tracker";
import { getLinearGatewayOrDisconnected } from "@/lib/tracker/linear/client";
import { conversationFor, linearConversation } from "@/lib/ralph/conversation";
import { truncate } from "@/lib/ralph/display";
import { postActivity } from "@/lib/ralph/notify";
import { answerRunQuestion, type RunQuestionAnswer } from "@/lib/ralph/reply";
import { ralphDepsOf } from "./ralph-deps";

/** Longest tool call detail a permission's prompt quotes. */
const PROMPT_DETAIL_MAX_LENGTH = 500;

export const QUESTION_CLOSED_MESSAGE = "This question was already answered.";

/** An offered answer, and the reply text it stands for. */
interface QuestionOption {
  id: string;
  label: string;
  reply: string;
  /** A repository option's code host. */
  provider?: RunRepository["provider"];
}

/** What a question's prompt names besides its own facts. */
export interface QuestionContext {
  /** The run's work item identifier (e.g. `ENG-12`). */
  workItem: string | null;
  /** The repositories a repository question offers, by ID. */
  repositories: ReadonlyMap<string, RunRepository>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The answers a question offers: repos' full paths, the preparation's three, cleanup's two, Allow/Deny. */
function questionOptions(
  subject: InboxQuestionSubject,
  context: QuestionContext,
): QuestionOption[] {
  switch (subject.kind) {
    case "repository":
      return subject.repositoryIds.flatMap((id) => {
        const repository = context.repositories.get(id);
        return repository
          ? [
              {
                id: repository.id,
                label: repository.fullPath,
                reply: repository.fullPath,
                provider: repository.provider,
              },
            ]
          : [];
      });
    case "preparation":
      return [
        { id: "run", label: PREPARATION_RUN, reply: PREPARATION_RUN },
        { id: "myself", label: PREPARATION_MYSELF, reply: PREPARATION_MYSELF },
        { id: "later", label: PREPARATION_LATER, reply: PREPARATION_LATER },
      ];
    case "cleanup":
      return subject.question === "stashes"
        ? [
            { id: "push", label: PUSH_STASHES, reply: PUSH_STASHES },
            { id: "drop", label: DROP_STASHES, reply: DROP_STASHES },
          ]
        : [
            { id: "push", label: PUSH_BRANCH, reply: PUSH_BRANCH },
            { id: "delete", label: DELETE_BRANCH, reply: DELETE_BRANCH },
          ];
    case "permission":
      return [
        { id: "allow", label: PERMISSION_ALLOW, reply: PERMISSION_ALLOW },
        { id: "deny", label: PERMISSION_DENY, reply: PERMISSION_DENY },
      ];
  }
}

function questionPrompt(
  question: InboxQuestionCandidate["facts"]["question"],
  context: QuestionContext,
): string {
  const { subject } = question;
  switch (subject.kind) {
    case "repository":
      return context.workItem
        ? `Which repo should Om work in for ${context.workItem}?`
        : "Which repo should Om work in?";
    case "preparation": {
      const story = question.story ?? "A manual story";
      const name = subject.storyTitle ? `${story} (${subject.storyTitle})` : story;
      return `${name} is a manual story with preparation commands. Should Om run them now?`;
    }
    case "cleanup":
      if (subject.question === "stashes") {
        const n = subject.count;
        return `${plural(n, "stashed change")} from this run ${n === 1 ? "was" : "were"} never applied. Should Om push ${n === 1 ? "it" : "them"} to a branch on origin, or drop ${n === 1 ? "it" : "them"}?`;
      }
      return `${subject.branch ?? "The branch"} has ${plural(subject.count, "commit")} that ${subject.count === 1 ? "wasn't" : "weren't"} merged. Should Om push it to origin, or delete it? Without an answer, Om deletes it.`;
    case "permission": {
      const tool = question.tool ?? "a tool";
      const detail = subject.detail.trim().replace(/\s+/g, " ");
      return detail
        ? `Om asks to use ${tool}: ${truncate(detail, PROMPT_DETAIL_MAX_LENGTH)}`
        : `Om asks to use ${tool}.`;
    }
  }
}

/** A question as the wire shows it. */
export function questionView(
  candidate: InboxQuestionCandidate,
  context: QuestionContext,
): RunQuestion {
  const { question } = candidate.facts;
  return {
    key: candidate.key,
    kind: question.kind,
    prompt: questionPrompt(question, context),
    options: questionOptions(question.subject, context).map(({ id, label, provider }) =>
      provider ? { id, label, provider } : { id, label },
    ),
    askedAt: new Date(question.askedAt).toISOString(),
    expiresAt: question.expiresAt ? new Date(question.expiresAt).toISOString() : null,
  };
}

/** Which of a run's open questions its detail shows first: the one that expires soonest. */
const QUESTION_ORDER = ["permission", "repository", "preparation", "cleanup"] as const;

/** The run's open question for its detail (the most urgent, when there are several). */
export async function loadRunQuestion(
  db: Database,
  run: RunIndexEntry,
  workItem: string | null,
): Promise<{ question: RunQuestion; facts: InboxQuestionCandidate["facts"]["question"] } | null> {
  const questions = await listRunQuestions(db, run);
  const first = [...questions].sort(
    (a, b) =>
      QUESTION_ORDER.indexOf(a.facts.question.kind) - QUESTION_ORDER.indexOf(b.facts.question.kind),
  )[0];
  if (!first) return null;
  const { repositories } = await loadInboxReferences(db, [first]);
  return { question: questionView(first, { workItem, repositories }), facts: first.facts.question };
}

const closed = () => new ApiRouteError(409, QUESTION_CLOSED_MESSAGE, "question_closed");

/** The note an accepted answer leaves in the run's conversation, where the reply would have been. */
const answeredNote = (answeredBy: string, option: QuestionOption): ActivityContent => ({
  type: "thought",
  body: `${answeredBy} answered from Omniralph: ${option.label}`,
});

/**
 * Answers the run's open question `questionKey` with option `optionId`, as `answeredBy`: 409
 * when the key isn't an open question of the run anymore (answered elsewhere, expired or
 * replaced), 400 for an option it doesn't offer. An epic's or request's question goes through
 * `answerRunQuestion`; a tool permission's answer is also recorded on the job's stored request
 * (`run_permission_requests`), which the agent polls. Another run's tool permission is answered
 * on its stored request alone. Once the answer is taken, a note "{name} answered from
 * Omniralph: {option}" goes to the run's conversation (a triage run's Linear session); a
 * refused answer leaves none.
 */
export async function answerQuestion(
  db: Database,
  run: RunIndexEntry,
  { questionKey, optionId }: RunAnswerRequest,
  answeredBy: string,
): Promise<void> {
  const question = (await listRunQuestions(db, run)).find((q) => q.key === questionKey);
  if (!question) throw closed();
  const { repositories } = await loadInboxReferences(db, [question]);
  const { subject } = question.facts.question;
  const option = questionOptions(subject, { workItem: null, repositories }).find(
    (o) => o.id === optionId,
  );
  if (!option) {
    throw new ApiRouteError(400, "Choose one of the offered answers.", "invalid_option");
  }

  if (subject.kind === "permission" && subject.stored) {
    const { answered } = await answerRunPermissionRequest(db, {
      jobId: subject.jobId,
      requestId: subject.requestId,
      answer: option.reply === PERMISSION_ALLOW ? "allowed" : "denied",
      answeredBy,
    });
    if (!answered) throw closed();
    await noteStoredAnswer(db, run, answeredNote(answeredBy, option));
    return;
  }

  const ralphRun = await getRun(db, run.id);
  if (!ralphRun) throw ApiRouteError.notFound("That run doesn't exist.");
  const deps = await ralphDepsOf(db, run.organizationId);
  const result = await answerRunQuestion(
    deps,
    ralphRun,
    {
      kind: subject.kind,
      text: option.reply,
      ...(subject.kind === "cleanup" && { laneId: subject.laneId }),
    },
    answeredBy,
  );
  if (subject.kind === "permission" && result?.outcome === "answered") {
    // The agent reads the stored request on its next poll: settle it now, not on that poll.
    const permission = (await getRun(db, run.id))?.permission;
    if (permission?.requestId === subject.requestId && permission.answer) {
      await answerRunPermissionRequest(db, {
        jobId: subject.jobId,
        requestId: subject.requestId,
        answer: permission.answer,
        answeredBy: permission.answeredBy ?? answeredBy,
        answeredAt: permission.answeredAt ? new Date(permission.answeredAt) : new Date(),
      });
    }
  }
  if (result?.outcome === "answered" || result?.outcome === "failed") {
    // A notice: a chat run relays it in its thread too.
    await postActivity(conversationFor(ralphRun, deps), answeredNote(answeredBy, option), {
      notice: true,
    });
  }
  throwUnlessAnswered(result);
}

/** Notes a stored request's answer in its run's conversation: a triage run's Linear session. */
async function noteStoredAnswer(
  db: Database,
  run: RunIndexEntry,
  note: ActivityContent,
): Promise<void> {
  if (run.kind !== "triage") return;
  const triage = await getTriageRun(db, run.id);
  if (!triage) return;
  const linear = () => getLinearGatewayOrDisconnected({ db, organizationId: run.organizationId });
  await postActivity(linearConversation(linear, triage.linearAgentSessionId), note);
}

function throwUnlessAnswered(result: RunQuestionAnswer | null): void {
  switch (result?.outcome) {
    case "answered":
      return;
    case "busy":
      throw new ApiRouteError(
        409,
        "Om is still carrying out the previous answer about this branch. Answer again once it's done.",
        "answer_busy",
      );
    case "failed":
      throw new ApiRouteError(
        502,
        "Om couldn't carry out the answer. The run's conversation says why.",
        "answer_failed",
      );
    case "closed":
    case undefined:
      throw closed();
  }
}
