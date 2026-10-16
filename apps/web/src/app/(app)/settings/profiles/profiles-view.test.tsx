// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as UI from "@iamthemcmaster/ui";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
  testUser,
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import type { ReviewProfileRow, ReviewProfiles } from "@/lib/api/review-profiles";
import { ProfilesView } from "./profiles-view";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect ${path}`);
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/profiles",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  redirect: navigation.redirect,
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
const toast = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@iamthemcmaster/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  notify: toast.notify,
}));

const PATH = "/api/ui/review-profiles";

const profile = (id: string, model: string, overrides: Partial<ReviewProfileRow> = {}) => ({
  id,
  name: id,
  description: null,
  model,
  maxTokensPerReview: 150_000,
  maxFiles: 50,
  allowRepoExploration: true,
  updatedAt: "2026-10-13T00:00:00.000Z",
  builtIn: false,
  defaults: null,
  repositories: [],
  ...overrides,
});

function profiles(maxFiles = 50): ReviewProfiles {
  return {
    profiles: [
      profile("standard", "claude-opus-5-5", {
        maxFiles,
        repositories: [{ id: "r1", fullPath: "acme/app" }],
      }),
      profile("legacy", "claude-old-1"),
    ],
    choices: {
      models: [
        { value: "claude-opus-5-5", displayName: "Opus 5.5", harnessIds: ["h1", "h2"] },
        { value: "claude-haiku-5-5", displayName: "Haiku 5.5", harnessIds: ["h1"] },
      ],
      harnessCount: 2,
    },
  };
}

function renderView(role: "admin" | "member" = "admin") {
  const client = createTestQueryClient();
  render(<ProfilesView />, { wrapper: queryWrapper(client, { ...testUser, role }) });
  return client;
}

const maxFiles = () =>
  screen.getByLabelText(/^Max files/, {
    selector: "#profile-standard-max-files",
  }) as HTMLInputElement;

/** The card titled `title`: the heading's closest ancestor with buttons. */
function card(title: string): HTMLElement {
  let element = screen.getByRole("heading", { name: new RegExp(`^${title}`) });
  while (!element.querySelector("button[type='submit']") && element.parentElement) {
    element = element.parentElement;
  }
  return element;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  toast.notify.mockReset();
});

describe("ProfilesView", () => {
  it("shows a skeleton, then picks each profile's model from the reported models, keeping an unreported one", async () => {
    mockFetch({ [`GET ${PATH}`]: profiles() });
    renderView();
    expect(screen.getByLabelText("Loading the review profiles")).toBeTruthy();
    await screen.findByRole("heading", { name: /^standard/ });
    expect(document.querySelector("#profile-standard-model")!.textContent).toContain("Opus 5.5");
    const legacy = document.querySelector("#profile-legacy-model")!.textContent;
    expect(legacy).toContain("claude-old-1");
    expect(legacy).toContain("not available");
    // A picker, not a text box.
    expect(document.querySelector('input[value="claude-opus-5-5"]')).toBeNull();
  });

  it("sends members to the access-denied page", () => {
    mockFetch({});
    expect(() => renderView("member")).toThrow("redirect /access-denied?reason=forbidden");
  });

  it("shows an error with a retry when the profiles don't load", async () => {
    let fail = true;
    mockFetch({
      [`GET ${PATH}`]: () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse(profiles()),
    });
    renderView();
    await screen.findByText("Couldn't load the review profiles");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await screen.findByRole("heading", { name: /^standard/ });
  });

  it("re-seeds a profile from fresh data unless it's being edited", async () => {
    let files = 50;
    mockFetch({ [`GET ${PATH}`]: () => jsonResponse(profiles(files)) });
    const client = renderView();
    await waitFor(() => expect(maxFiles().value).toBe("50"));

    // Saved elsewhere: the untouched card follows.
    files = 60;
    await client.invalidateQueries();
    await waitFor(() => expect(maxFiles().value).toBe("60"));

    // Being edited: a refetch leaves the draft alone.
    await userEvent.clear(maxFiles());
    await userEvent.type(maxFiles(), "7");
    files = 80;
    await client.invalidateQueries();
    expect(maxFiles().value).toBe("7");
  });

  it("saves a profile after confirming, refetches it and the repositories, then shows it saved", async () => {
    let files = 50;
    const seen = mockFetch({
      [`GET ${PATH}`]: () => jsonResponse(profiles(files)),
      [`PUT ${PATH}/standard`]: (request) => {
        files = (request.body as { maxFiles: number }).maxFiles;
        return jsonResponse({ ok: true });
      },
    });
    const client = renderView();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await waitFor(() => expect(maxFiles().value).toBe("50"));
    await userEvent.clear(maxFiles());
    await userEvent.type(maxFiles(), "20");
    await userEvent.click(within(card("standard")).getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("acme/app")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save 1 change" }));
    await waitFor(() => expect(within(card("standard")).getByText("Saved")).toBeTruthy());
    expect(seen.find((r) => r.method === "PUT")!.body).toEqual({
      model: "claude-opus-5-5",
      maxTokensPerReview: 150_000,
      maxFiles: 20,
      allowRepoExploration: true,
    });
    expect(maxFiles().value).toBe("20");
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      [TEST_ORGANIZATION_ID, "settings", "detail", "review-profiles"],
      [TEST_ORGANIZATION_ID, "repositories"],
    ]);
    expect(toast.notify).toHaveBeenCalledWith(
      "standard profile saved; it applies to the next review",
    );
  });

  it("shows the server's field errors and keeps the draft", async () => {
    mockFetch({
      [`GET ${PATH}`]: profiles(),
      [`PUT ${PATH}/standard`]: () =>
        jsonResponse(
          { error: "Fix the highlighted fields.", fieldErrors: { maxFiles: "Too many files." } },
          400,
        ),
    });
    renderView();
    await waitFor(() => expect(maxFiles().value).toBe("50"));
    await userEvent.clear(maxFiles());
    await userEvent.type(maxFiles(), "40");
    await userEvent.click(within(card("standard")).getByRole("button", { name: "Save" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save 1 change" }),
    );
    await screen.findByText("Too many files.");
    expect(maxFiles().value).toBe("40");
  });
});
