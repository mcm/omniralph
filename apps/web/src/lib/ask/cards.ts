import "server-only";
import {
  getChatLinearIssueDraft,
  getChatRequestDraft,
  type ChatLinearIssueDraft,
  type ChatThread,
  type ChatWebMessage,
  type Database,
} from "@omniralph/db";
import { cardChildToFallbackText, isCardElement, type CardChild, type CardElement } from "chat";
import type { AskCard, AskCardAction, AskLinearIssueDraft } from "@/lib/api/ask";
import { getAppUrl } from "@/lib/app-url";
import { attachmentName } from "@/lib/chat/attachments";
import { requestDraftContext, requestDraftView } from "@/lib/chat/request-draft";
import {
  CANCEL_ISSUE_ACTION,
  CREATE_AND_DELEGATE_ISSUE_ACTION,
  CREATE_ISSUE_ACTION,
  draftPreview,
  PRIORITY_NAMES,
} from "@/lib/chat/issue-draft";

/**
 * The cards of a web chat as the web shows them: a card that acts on a draft (its
 * `card_ref`: a request or a Linear issue) is shown from the draft's current state, any other
 * card as its title, text and buttons (the stored Chat SDK card).
 */

/** Every button of a card, in sections too. */
function cardActions(children: readonly CardChild[]): AskCardAction[] {
  return children.flatMap((child) => {
    if (child.type === "section") return cardActions(child.children);
    if (child.type !== "actions") return [];
    return child.children.flatMap((element) =>
      element.type === "button"
        ? [{ id: element.id, label: element.label, value: element.value ?? null }]
        : [],
    );
  });
}

/** A stored card that acts on no draft. */
export function genericCard(card: CardElement): AskCard {
  const text = card.children
    .filter((child) => child.type !== "actions")
    .map((child) => cardChildToFallbackText(child))
    .filter((part): part is string => !!part);
  return {
    kind: "generic",
    title: card.title ?? "",
    text: [card.subtitle, ...text].filter(Boolean).join("\n"),
    actions: cardActions(card.children),
  };
}

/** A Linear issue draft as its card shows it (expired once past `expiresAt`). */
export function linearIssueDraftView(
  draft: ChatLinearIssueDraft,
  now: Date = new Date(),
): AskLinearIssueDraft {
  const pending = draft.status === "pending" || draft.status === "creating";
  const expired = draft.status === "expired" || (pending && draft.expiresAt <= now);
  const status = expired ? "expired" : draft.status;
  const { title, description } = draftPreview(draft);
  return {
    id: draft.id,
    status,
    title,
    team: draft.teamKey,
    project: draft.projectName,
    labels: draft.labels,
    priority: draft.priority === null ? null : (PRIORITY_NAMES[draft.priority] ?? null),
    description,
    screenshots: draft.attachments.map((a) => attachmentName(a)),
    issue: draft.linearIssueIdentifier
      ? { identifier: draft.linearIssueIdentifier, url: draft.linearIssueUrl }
      : null,
    actions:
      status === "pending"
        ? [
            { id: CREATE_ISSUE_ACTION, label: "Create", value: draft.id },
            {
              id: CREATE_AND_DELEGATE_ISSUE_ACTION,
              label: "Create and delegate",
              value: draft.id,
            },
            { id: CANCEL_ISSUE_ACTION, label: "Cancel", value: draft.id },
          ]
        : [],
  };
}

/** The card of each of `rows` (of `thread`) that has one, by message ID. */
export async function askCards(
  db: Database,
  thread: Pick<ChatThread, "id">,
  rows: readonly ChatWebMessage[],
  now: Date = new Date(),
): Promise<Map<string, AskCard>> {
  const cards = new Map<string, AskCard>();
  await Promise.all(
    rows.map(async (row) => {
      if (row.cardRef?.kind === "request_draft") {
        const draft = await getChatRequestDraft(db, row.cardRef.draftId);
        // A draft of another chat never shows here.
        if (draft && draft.threadId === thread.id) {
          const context = await requestDraftContext(db, draft, {
            platform: "web",
            appUrl: getAppUrl(),
            now,
          });
          cards.set(row.id, { kind: "request_draft", draft: requestDraftView(draft, context) });
          return;
        }
      }
      if (row.cardRef?.kind === "linear_issue_draft") {
        const draft = await getChatLinearIssueDraft(db, row.cardRef.draftId);
        // A draft of another chat never shows here.
        if (draft && draft.threadId === thread.id) {
          cards.set(row.id, {
            kind: "linear_issue_draft",
            draft: linearIssueDraftView(draft, now),
          });
          return;
        }
      }
      if (isCardElement(row.card)) cards.set(row.id, genericCard(row.card));
    }),
  );
  return cards;
}
