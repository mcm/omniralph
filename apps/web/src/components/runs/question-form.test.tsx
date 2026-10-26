// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
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
import type { InboxCountsResponse, InboxFeed, InboxItem } from "@/lib/api/inbox";
import { inboxKeys, queryKeys } from "@/lib/api/keys";
import { RUN_QUESTION_KINDS, type RunDetail, type RunQuestion } from "@/lib/api/runs";
import { InboxView } from "@/screens/inbox/inbox-view";
import { COUNTS, inboxItem, NOW } from "@/screens/inbox/test-fixtures";
import { QuestionForm } from "./question-form";
import { QUESTIONS, questionItem, runDetail } from "./test-fixtures";
import { QUESTION_ANSWERED } from "./use-run-answer";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => nav.router,
  useSearchParams: () => nav.search,
}));

function TestLink({ href, onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        nav.router.push(href);
      }}
    />
  );
}

/** A response held until the test settles it. */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const keys = queryKeys(testUser.organization.id);
const inbox = inboxKeys(keys);
const scope = testUser.organization.id;
const answerPath = (runId: string) => `/api/ui/runs/${runId}/answer`;
const user = () => userEvent.setup({ advanceTimers: () => {} });

let feed: InboxItem[];
let counts: InboxCountsResponse;
let seen: SeenRequest[];
/** Answers `POST /api/ui/runs/run-1/answer`; defaults to the run going on. */
let answer: (request: SeenRequest) => Response | Promise<Response>;

function serve() {
  seen = mockFetch({
    "GET /api/ui/inbox": (request) =>
      jsonResponse({ items: request.query.get("tab") === "needs-you" ? feed : [] }),
    "GET /api/ui/inbox/counts": () => jsonResponse(counts),
    [`POST ${answerPath("run-1")}`]: (request) => answer(request),
  });
}

function providers(client: QueryClient, children: React.ReactNode) {
  return (
    <CurrentUserProvider user={testUser}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>{children}</UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
}

/** Renders the form with the question's Inbox feed, counts and run detail cached. */
function renderForm(question: RunQuestion, variant: "inbox" | "run") {
  const client = createTestQueryClient();
  const item = questionItem(question);
  client.setQueryData<InboxFeed>(inbox.feed("needs-you", scope), { items: [item] });
  client.setQueryData<InboxCountsResponse>(inbox.counts(scope), { ...COUNTS, needsYou: 1 });
  client.setQueryData<RunDetail>(keys.runs.detail("run-1"), runDetail(question));
  render(
    providers(
      client,
      variant === "inbox" ? (
        <QuestionForm variant="inbox" runId="run-1" question={question} item={item} />
      ) : (
        <QuestionForm variant="run" runId="run-1" question={question} />
      ),
    ),
  );
  return client;
}

const form = () => screen.getByRole("form", { name: "Answer" });
const sendButton = () => within(form()).getByRole("button", { name: "Send answer" });
const posts = () => seen.filter((request) => request.method === "POST");
const cachedFeed = (client: QueryClient) =>
  client.getQueryData<InboxFeed>(inbox.feed("needs-you", scope))?.items.map((item) => item.key);
const cachedCounts = (client: QueryClient) =>
  client.getQueryData<InboxCountsResponse>(inbox.counts(scope));
const cachedDetail = (client: QueryClient) =>
  client.getQueryData<RunDetail>(keys.runs.detail("run-1"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  ui.toast.mockReset();
  feed = [];
  counts = { ...COUNTS };
  answer = () => jsonResponse(runDetail(null, { status: "running" }));
  serve();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("QuestionForm", () => {
  describe.each(RUN_QUESTION_KINDS)("a %s question", (kind) => {
    const question = QUESTIONS[kind];

    it.each(["inbox", "run"] as const)(
      "%s: the prompt names a radio group of its options; Send answer posts the choice",
      async (variant) => {
        renderForm(question, variant);
        const group = within(form()).getByRole("radiogroup", { name: question.prompt });
        const radios = within(group).getAllByRole("radio");
        expect(radios).toHaveLength(question.options.length);
        for (const [index, option] of question.options.entries()) {
          expect(within(group).getByRole("radio", { name: new RegExp(option.label) })).toBe(
            radios[index],
          );
        }

        // The buttons: Send answer (primary) first; the Inbox adds Done and Snooze.
        const buttons = within(form())
          .getAllByRole("button")
          .filter((button) => button.getAttribute("role") !== "radio");
        expect(buttons.map((button) => button.textContent)).toEqual(
          variant === "inbox" ? ["Send answer", "Done", "Snooze"] : ["Send answer"],
        );
        expect(form().querySelectorAll(".or-btn--primary")).toHaveLength(1);
        expect(sendButton().classList.contains("or-btn--primary")).toBe(true);
        expect(sendButton().hasAttribute("disabled")).toBe(true);

        const last = question.options.at(-1)!;
        await user().click(within(group).getByRole("radio", { name: new RegExp(last.label) }));
        expect(sendButton().hasAttribute("disabled")).toBe(false);
        await user().click(sendButton());
        await waitFor(() => expect(posts()).toHaveLength(1));
        expect(posts()[0]).toMatchObject({
          path: answerPath("run-1"),
          body: { questionKey: question.key, optionId: last.id },
        });
      },
    );
  });

  it("shows each repo option as the repo badge with its code-host mark", () => {
    renderForm(QUESTIONS.repository, "run");
    const group = screen.getByRole("radiogroup");
    for (const option of QUESTIONS.repository.options) {
      const label = within(group).getByText(option.label).closest("label")!;
      const badge = label.querySelector(".or-ref");
      expect(badge).not.toBeNull();
      expect(badge!.querySelector(".or-ref__icon")).not.toBeNull();
    }
  });

  it("shows plain labels for options of other questions", () => {
    renderForm(QUESTIONS.permission, "run");
    expect(screen.getByRole("radiogroup").querySelector(".or-ref")).toBeNull();
  });

  it("shows when the question expires beside the prompt", () => {
    renderForm(QUESTIONS.permission, "run");
    const head = screen
      .getByRole("radiogroup", { name: QUESTIONS.permission.prompt })
      .parentElement!.querySelector(".or-radio-list__head")!;
    expect(head.textContent).toContain("Expires in 10 minutes");
  });

  it("shows no expiry for a question without a deadline", () => {
    renderForm(QUESTIONS.preparation, "run");
    expect(screen.queryByText(/^Expires/)).toBeNull();
  });
});

describe("Send answer before the server answers", () => {
  it.each(["inbox", "run"] as const)(
    "%s: the item leaves the feed, the count drops and the run detail reads as running",
    async (variant) => {
      const held = deferred();
      answer = () => held.promise;
      const client = renderForm(QUESTIONS.permission, variant);
      await user().click(screen.getByRole("radio", { name: "Allow" }));
      await user().click(sendButton());
      await waitFor(() => expect(posts()).toHaveLength(1));

      expect(cachedFeed(client)).toEqual([]);
      expect(cachedCounts(client)?.needsYou).toBe(0);
      expect(cachedDetail(client)?.status).toBe("running");
      expect(cachedDetail(client)?.details.question).toBeNull();
      // Pending: Send answer (and the Inbox's other decisions) wait.
      expect(sendButton().hasAttribute("disabled")).toBe(true);

      const server = runDetail(null, { status: "running", updatedAt: new Date(NOW).toISOString() });
      held.resolve(jsonResponse(server));
      await waitFor(() => expect(cachedDetail(client)?.updatedAt).toBe(server.updatedAt));
      expect(cachedDetail(client)?.details.question).toBeNull();
      expect(cachedFeed(client)).toEqual([]);
      expect(ui.toast).not.toHaveBeenCalled();
    },
  );

  it("in the Inbox, the item leaves the list and the next item is selected", async () => {
    const held = deferred();
    answer = () => held.promise;
    feed = [
      questionItem(QUESTIONS.repository),
      inboxItem({ key: "manual_story:s2", title: "Renew the domain" }),
    ];
    counts = { ...COUNTS, needsYou: 2 };
    serve();
    nav.search = new URLSearchParams("tab=needs-you");
    const client = createTestQueryClient();
    render(providers(client, <InboxView />));
    const detail = () => screen.getByRole("region", { name: "Item" });
    const answerForm = await waitFor(() => within(detail()).getByRole("form", { name: "Answer" }));
    // The form sits under the reason.
    expect(answerForm.previousElementSibling?.className).toBe("or-inbox-detail__reason");
    await user().click(within(answerForm).getByRole("radio", { name: /acme\/api/ }));
    await user().click(within(answerForm).getByRole("button", { name: "Send answer" }));

    await waitFor(() =>
      expect(within(detail()).getByRole("heading", { name: "Renew the domain" })).toBeTruthy(),
    );
    expect(cachedCounts(client)?.needsYou).toBe(1);
    expect(screen.getByRole("tab", { name: /Needs you/ }).textContent).toContain("1");
    expect(posts()[0]).toMatchObject({
      path: answerPath("run-1"),
      body: { questionKey: QUESTIONS.repository.key, optionId: "repo-2" },
    });
    held.resolve(jsonResponse(runDetail(null, { status: "running" })));
  });
});

describe("a failed answer", () => {
  it("409: says the question was already answered in an info toast and keeps the item removed", async () => {
    answer = () => jsonResponse({ error: QUESTION_ANSWERED }, 409);
    const client = renderForm(QUESTIONS.cleanup, "inbox");
    await user().click(screen.getByRole("radio", { name: "Push the branch" }));
    await user().click(sendButton());
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith(QUESTION_ANSWERED, { variant: "info" }),
    );
    expect(ui.toast).not.toHaveBeenCalledWith(expect.anything(), { variant: "danger" });
    expect(cachedFeed(client)).toEqual([]);
    expect(cachedCounts(client)?.needsYou).toBe(0);
  });

  it("any other error puts the item, the count and the question back, with the server's message", async () => {
    const held = deferred();
    answer = () => held.promise;
    const client = renderForm(QUESTIONS.repository, "inbox");
    await user().click(screen.getByRole("radio", { name: /acme\/portal/ }));
    await user().click(sendButton());
    await waitFor(() => expect(cachedFeed(client)).toEqual([]));
    expect(cachedDetail(client)?.status).toBe("running");

    held.resolve(jsonResponse({ error: "Choose one of the offered answers." }, 400));
    await waitFor(() =>
      expect(ui.toast).toHaveBeenCalledWith("Choose one of the offered answers.", {
        variant: "danger",
      }),
    );
    expect(cachedFeed(client)).toEqual([QUESTIONS.repository.key]);
    expect(cachedCounts(client)?.needsYou).toBe(1);
    expect(cachedDetail(client)?.status).toBe("waiting");
    expect(cachedDetail(client)?.details.question).toEqual(QUESTIONS.repository);
    // The choice stays, so the person can send it again.
    expect(sendButton().hasAttribute("disabled")).toBe(false);
  });
});
