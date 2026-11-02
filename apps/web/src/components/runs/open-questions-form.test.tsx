// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import { queryKeys } from "@/lib/api/keys";
import type { RunTriageSummary } from "@/lib/api/runs";
import { OPEN_QUESTIONS_FORM, OpenQuestionsForm, SEND_ANSWERS } from "./open-questions-form";
import { ANSWERS_PENDING, ANSWERS_SENT } from "./use-triage-answers";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const QUESTIONS = ["Which currency do invoices use?", "Who can export?", "Is CSV enough?"];
const CHANGED = "The open questions changed. Reload them and answer again.";
const keys = queryKeys(testUser.organization.id);
const answersPath = "/api/ui/runs/run-1/triage/answers";

let seen: SeenRequest[];
let answer: () => Response;

function summary(): RunTriageSummary {
  return {
    outcome: "needs_answers",
    summary: "Wrote a PRD.",
    error: null,
    change: "prd",
    size: "M",
    storyCount: 2,
    openQuestions: QUESTIONS,
    answerQuestions: true,
    originalIssue: null,
  };
}

function renderForm() {
  const client = createTestQueryClient();
  client.setQueryData(keys.runs.part("run-1", "triage"), summary());
  render(
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider>
          <OpenQuestionsForm runId="run-1" questions={QUESTIONS} />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
  return client;
}

const form = () => screen.getByRole("form", { name: OPEN_QUESTIONS_FORM });
const send = () => within(form()).getByRole("button", { name: SEND_ANSWERS });
const field = (question: string) => within(form()).getByRole("textbox", { name: question });
const posts = () => seen.filter((request) => request.method === "POST");
const user = () => userEvent.setup();

beforeEach(() => {
  ui.toast.mockReset();
  answer = () => jsonResponse({ kind: "retriage" });
  seen = mockFetch({
    [`POST ${answersPath}`]: () => answer(),
    "GET /api/ui/runs/run-1": () => jsonResponse({ error: "not needed" }, 404),
    "GET /api/ui/runs/run-1/triage": () => jsonResponse(summary()),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("OpenQuestionsForm", () => {
  it("numbers the questions, each labelling its answer's textarea", () => {
    renderForm();
    const items = within(form()).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("label")!.textContent)).toEqual(QUESTIONS);
    for (const question of QUESTIONS) expect(field(question)).toBeTruthy();
  });

  it("keeps Send answers disabled until an answer is non-blank", async () => {
    renderForm();
    expect(send().hasAttribute("disabled")).toBe(true);
    await user().type(field(QUESTIONS[0]!), "   ");
    expect(send().hasAttribute("disabled")).toBe(true);
    await user().type(field(QUESTIONS[1]!), "Admins");
    expect(send().hasAttribute("disabled")).toBe(false);
  });

  it("posts only the answered questions, with their indexes and texts, trimmed", async () => {
    renderForm();
    await user().type(field(QUESTIONS[2]!), "  Yes, CSV only. ");
    await user().type(field(QUESTIONS[0]!), "EUR");
    await user().click(send());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      path: answersPath,
      body: {
        answers: [
          { index: 0, question: QUESTIONS[0], answer: "EUR" },
          { index: 2, question: QUESTIONS[2], answer: "Yes, CSV only." },
        ],
      },
    });
  });

  it("clears after a retriage, confirms it and shows the run as triaging", async () => {
    const client = renderForm();
    await user().type(field(QUESTIONS[1]!), "Admins");
    await user().click(send());
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith(ANSWERS_SENT));
    await waitFor(() => expect((field(QUESTIONS[1]!) as HTMLTextAreaElement).value).toBe(""));
    expect(send().hasAttribute("disabled")).toBe(true);
    expect(client.getQueryData<RunTriageSummary>(keys.runs.part("run-1", "triage"))).toMatchObject({
      outcome: "triaging",
      answerQuestions: false,
    });
  });

  it("says the answers wait for the current triage when they are stored as pending", async () => {
    answer = () => jsonResponse({ kind: "pending" });
    const client = renderForm();
    await user().type(field(QUESTIONS[1]!), "Admins");
    await user().click(send());
    await waitFor(() => expect(ui.toast).toHaveBeenCalledWith(ANSWERS_PENDING));
    await waitFor(() => expect((field(QUESTIONS[1]!) as HTMLTextAreaElement).value).toBe(""));
    expect(client.getQueryData<RunTriageSummary>(keys.runs.part("run-1", "triage"))?.outcome).toBe(
      "needs_answers",
    );
  });

  it("keeps the typed answers and shows the server's message on a 409", async () => {
    answer = () => jsonResponse({ error: CHANGED }, 409);
    renderForm();
    await user().type(field(QUESTIONS[0]!), "EUR");
    await user().click(send());
    expect((await within(form()).findByRole("alert")).textContent).toBe(CHANGED);
    expect((field(QUESTIONS[0]!) as HTMLTextAreaElement).value).toBe("EUR");
    expect(send().hasAttribute("disabled")).toBe(false);
  });
});
