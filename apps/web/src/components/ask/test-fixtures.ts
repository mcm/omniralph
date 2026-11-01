import type { AskWorkItemDraft, AskMessageView, RequestDraftView } from "@/lib/api/ask";

export const DRAFT_ID = "6f1c5c55-9a51-4c49-9d61-0d1e2f0a7b11";
export const REPOSITORY = {
  id: "repo-1",
  provider: "github" as const,
  fullPath: "acme/customer-portal",
};

export function omMessage(overrides: Partial<AskMessageView> = {}): AskMessageView {
  return {
    id: "m-om",
    author: "om",
    markdown: "The login form posts to `/api/session`.",
    status: "complete",
    createdAt: "2026-10-27T10:00:00.000Z",
    run: null,
    files: [],
    workItems: [],
    card: null,
    ...overrides,
  };
}

export function requestDraft(overrides: Partial<RequestDraftView> = {}): RequestDraftView {
  return {
    id: DRAFT_ID,
    status: "pending",
    title: "Remember the email on the login form",
    repository: REPOSITORY,
    triageChoice: "inline",
    question: null,
    actions: [
      { id: "request_draft_start", label: "Start request", value: DRAFT_ID, style: "solid" },
      { id: "request_draft_add", label: "Add to backlog", value: DRAFT_ID, style: "outline" },
      { id: "request_draft_dismiss", label: "Not now", value: DRAFT_ID, style: "ghost" },
    ],
    outcome: null,
    error: null,
    ...overrides,
  };
}

export function workItemDraft(overrides: Partial<AskWorkItemDraft> = {}): AskWorkItemDraft {
  return {
    id: DRAFT_ID,
    tracker: "linear",
    status: "pending",
    title: "Login form forgets the email",
    team: "TOOL",
    project: "Portal",
    labels: ["bug", "frontend"],
    priority: "High",
    description: "After a failed login the **email** field is empty.",
    screenshots: ["login.png"],
    issue: null,
    actions: [
      { id: "linear_issue_create", label: "Create", value: DRAFT_ID },
      { id: "linear_issue_create_delegate", label: "Create and delegate", value: DRAFT_ID },
      { id: "linear_issue_cancel", label: "Cancel", value: DRAFT_ID },
    ],
    ...overrides,
  };
}
