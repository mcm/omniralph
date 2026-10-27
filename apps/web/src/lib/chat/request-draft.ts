import "server-only";
import {
  getIntegration,
  getRepository,
  getWorkItemMatch,
  type ChatPlatform,
  type ChatRequestDraft,
  type Database,
} from "@omniralph/db";
import {
  Actions,
  Button,
  Card,
  CardText,
  LinkButton,
  type CardChild,
  type CardElement,
} from "chat";
import type { RequestDraftView } from "@/lib/api/ask";
import { sanitizeTitle } from "@/lib/review/sanitize";
import { runHref } from "@/lib/runs/links";

/**
 * Requests Om drafts in chat (`draft_request`) when an answer needs a code change: a card
 * with **Start request** / **Add to backlog** / **Not now**. One view model,
 * {@link requestDraftView}, says what the card shows in every state; {@link requestDraftCard}
 * renders it as a Chat SDK card (Slack, Discord) and the web's card renders the same view.
 * Clicks are handled in `./request-draft-actions`.
 */

export const REQUEST_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const START_REQUEST_DRAFT_ACTION = "request_draft_start";
export const ADD_REQUEST_DRAFT_ACTION = "request_draft_add";
export const DISMISS_REQUEST_DRAFT_ACTION = "request_draft_dismiss";
/** Slack and Discord: the answers to "Triage it now?" after Add to backlog. */
export const ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION = "request_draft_add_triage";
export const ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION = "request_draft_add_no_triage";
export const REQUEST_DRAFT_ACTIONS = [
  START_REQUEST_DRAFT_ACTION,
  ADD_REQUEST_DRAFT_ACTION,
  DISMISS_REQUEST_DRAFT_ACTION,
  ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION,
  ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION,
];

/** Longest title and request a draft takes. */
export const REQUEST_DRAFT_TITLE_MAX = 120;
export const REQUEST_DRAFT_REQUEST_MAX = 8_000;

export const REQUEST_STARTED_TEXT = "Request started";
export const ADDED_TO_BACKLOG_TEXT = "Added to the backlog";
export const TRIAGING_TEXT = "Om is triaging it";
export const NOT_NOW_TEXT = "Not now";
export const DRAFT_EXPIRED_TEXT = "This draft expired";
export const TRIAGE_QUESTION_TEXT = "Triage it now?";
export const NOT_REQUESTER_TEXT = "Only the person who asked can do this.";

/** What a draft's view depends on besides the draft. */
export interface RequestDraftContext {
  /** The draft's repo (null once it's gone). */
  repository: RequestDraftView["repository"];
  /** Whether the repo has a work item match and its tracker is connected (Add to backlog). */
  backlog: boolean;
  /** Where the card is shown: the web asks about triage inline, chat platforms after the click. */
  platform: ChatPlatform;
  /** The control panel's base URL (no trailing slash), for the run's link. */
  appUrl: string;
  now: Date;
}

type Draft = Pick<
  ChatRequestDraft,
  | "id"
  | "title"
  | "status"
  | "expiresAt"
  | "triageNow"
  | "error"
  | "ralphRunId"
  | "workItemTracker"
  | "workItemIdentifier"
  | "workItemUrl"
>;

/** The draft's title as shown in chat (it's the model's text). */
const shownTitle = (draft: Pick<Draft, "title">) =>
  sanitizeTitle(draft.title, { allowedHosts: [] });

/** The view's outcome for a draft that can't be acted on anymore, else null. */
function outcomeOf(
  draft: Draft,
  status: RequestDraftView["status"],
  appUrl: string,
): RequestDraftView["outcome"] {
  switch (status) {
    case "started":
      return {
        kind: "started",
        text: REQUEST_STARTED_TEXT,
        run: draft.ralphRunId
          ? { id: draft.ralphRunId, url: `${appUrl}${runHref(draft.ralphRunId)}` }
          : null,
        workItem: null,
      };
    case "added":
      return {
        kind: "added",
        text: draft.triageNow
          ? `${ADDED_TO_BACKLOG_TEXT} · ${TRIAGING_TEXT}`
          : ADDED_TO_BACKLOG_TEXT,
        run: null,
        workItem:
          draft.workItemTracker === "linear" && draft.workItemIdentifier && draft.workItemUrl
            ? { tracker: "linear", identifier: draft.workItemIdentifier, url: draft.workItemUrl }
            : null,
      };
    case "dismissed":
      return { kind: "dismissed", text: NOT_NOW_TEXT, run: null, workItem: null };
    case "expired":
      return { kind: "expired", text: DRAFT_EXPIRED_TEXT, run: null, workItem: null };
    case "pending":
    case "starting":
    case "adding":
      return null;
  }
}

/**
 * What a draft's card shows in its current state: the buttons while it's pending (Add to
 * backlog only when the repo can take work items), the outcome after a choice, nothing
 * while a click runs. A pending draft past `expiresAt` shows as expired. With `askTriage`
 * (Slack and Discord, after Add to backlog), a pending draft asks "Triage it now?" instead.
 */
export function requestDraftView(
  draft: Draft,
  context: RequestDraftContext,
  options: { askTriage?: boolean } = {},
): RequestDraftView {
  const expired =
    draft.status === "expired" || (draft.status === "pending" && draft.expiresAt <= context.now);
  const status = expired ? "expired" : draft.status;
  const askTriage = status === "pending" && context.backlog && !!options.askTriage;
  const actions: RequestDraftView["actions"] = askTriage
    ? [
        {
          id: ADD_TRIAGE_NOW_REQUEST_DRAFT_ACTION,
          label: "Triage now",
          value: draft.id,
          style: "solid",
        },
        {
          id: ADD_WITHOUT_TRIAGE_REQUEST_DRAFT_ACTION,
          label: "Add without triage",
          value: draft.id,
          style: "outline",
        },
      ]
    : status === "pending"
      ? [
          {
            id: START_REQUEST_DRAFT_ACTION,
            label: "Start request",
            value: draft.id,
            style: "solid",
          },
          ...(context.backlog
            ? [
                {
                  id: ADD_REQUEST_DRAFT_ACTION,
                  label: "Add to backlog",
                  value: draft.id,
                  style: "outline" as const,
                },
              ]
            : []),
          { id: DISMISS_REQUEST_DRAFT_ACTION, label: "Not now", value: draft.id, style: "ghost" },
        ]
      : [];
  return {
    id: draft.id,
    status,
    title: shownTitle(draft),
    repository: context.repository,
    triageChoice: context.platform === "web" ? "inline" : "follow_up",
    question: askTriage ? TRIAGE_QUESTION_TEXT : null,
    actions,
    outcome: outcomeOf(draft, status, context.appUrl),
    error: status === "pending" ? draft.error : null,
  };
}

/** The view as a Chat SDK card, for Slack and Discord (the web stores it too). */
export function requestDraftCard(view: RequestDraftView): CardElement {
  const children: CardChild[] = [];
  if (view.error) children.push(CardText(view.error));
  if (view.question) children.push(CardText(view.question));
  if (view.actions.length > 0) {
    children.push(
      Actions(view.actions.map((a) => Button({ id: a.id, label: a.label, value: a.value ?? "" }))),
    );
  }
  const { outcome } = view;
  if (outcome) {
    const workItem = outcome.workItem;
    children.push(CardText(workItem ? `${outcome.text}: ${workItem.identifier}` : outcome.text));
    if (outcome.run) {
      children.push(Actions([LinkButton({ label: "Open run", url: outcome.run.url })]));
    } else if (workItem) {
      children.push(
        Actions([LinkButton({ label: `Open ${workItem.identifier}`, url: workItem.url })]),
      );
    }
  }
  return Card({
    title: view.title,
    subtitle: view.repository ? `Request · ${view.repository.fullPath}` : "Request",
    children,
  });
}

/**
 * The context of `draft`'s view: its repo, whether the repo has a work item match whose
 * tracker is connected, and the platform the card is shown on.
 */
export async function requestDraftContext(
  db: Database,
  draft: Pick<ChatRequestDraft, "organizationId" | "repositoryId">,
  options: { platform: ChatPlatform; appUrl: string; now?: Date },
): Promise<RequestDraftContext> {
  const repository = await getRepository(db, draft.repositoryId, draft.organizationId);
  const match = repository ? await getWorkItemMatch(db, draft.organizationId, repository.id) : null;
  const backlog =
    !!repository &&
    !repository.disconnectedAt &&
    !!match &&
    !!(await getIntegration(db, draft.organizationId, match.tracker));
  return {
    repository: repository && {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
    },
    backlog,
    platform: options.platform,
    appUrl: options.appUrl,
    now: options.now ?? new Date(),
  };
}
