// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { UiProvider, type LinkProps } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  TEST_ORGANIZATION_ID,
  testUser,
  type SeenRequest,
} from "@/components/query-test-utils";
import type {
  AttachmentRow,
  FeatureDocumentKindValue,
  FeatureDocumentRow,
  FeatureRow,
} from "@/lib/api/features";
import { portalRow, REPO_PORTAL } from "../repos/test-fixtures";
import { KEEP_MINE, LOAD_THEIRS, RESTORE_VERSION, STALE_SAVE_TITLE } from "./document-editor";
import { ARCHIVED_NOTE, FeatureDetailView, READ_ONLY_MEMBER } from "./feature-page";
import {
  FEATURES_LOAD_FAILED,
  FeaturesView,
  NO_FEATURES,
  type FeaturesViewProps,
} from "./features-view";
import { NO_ATTACHMENTS } from "./attachments-panel";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/features",
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));

function TestLink({ href, onClick, ...props }: LinkProps) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
    />
  );
}

const FEATURE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const OTHER_FEATURE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const NEW_FEATURE_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";

const member: SessionUser = {
  ...testUser,
  role: "member",
  organizations: [{ id: TEST_ORGANIZATION_ID, name: "Acme", role: "member" }],
};

function featureRow(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return {
    id: FEATURE_ID,
    name: "Invoicing",
    status: "planning",
    repository: { id: REPO_PORTAL, provider: "github", fullPath: "acme/portal" },
    epicCount: 3,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function attachmentRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  const id = overrides.id ?? "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
  return {
    id,
    fileName: "checkout.png",
    contentType: "image/png",
    size: 2048,
    url: `/api/ui/attachments/${id}?organization=${TEST_ORGANIZATION_ID}`,
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

/** The server: features, every version of each document, and attachments. */
let features: FeatureRow[];
let versions: Record<FeatureDocumentKindValue, { body: string; savedAt: string }[]>;
let attachments: AttachmentRow[];
let seen: SeenRequest[];

function latest(kind: FeatureDocumentKindValue): FeatureDocumentRow {
  const list = versions[kind];
  const last = list.at(-1);
  return last
    ? { kind, version: list.length, body: last.body, savedAt: last.savedAt }
    : { kind, version: 0, body: "", savedAt: null };
}

/** Someone else saving a new version, straight on the server. */
function savedElsewhere(kind: FeatureDocumentKindValue, body: string) {
  versions[kind].push({ body, savedAt: "2026-11-03T09:00:00.000Z" });
}

const kindOf = (request: SeenRequest) => request.path.split("/").at(-1) as FeatureDocumentKindValue;

function serve(
  overrides: Record<string, (request: SeenRequest) => Response | Promise<Response>> = {},
) {
  const documentPath = (kind: string) => `/api/ui/features/${FEATURE_ID}/documents/${kind}`;
  const documentRoutes = Object.fromEntries(
    (["prfaq", "plan"] as const).flatMap((kind) => [
      [
        `GET ${documentPath(kind)}`,
        (request: SeenRequest) => {
          const version = request.query.get("version");
          if (!version) return jsonResponse(latest(kind));
          const entry = versions[kind][Number(version) - 1]!;
          return jsonResponse({ kind, version: Number(version), ...entry });
        },
      ],
      [
        `PUT ${documentPath(kind)}`,
        (request: SeenRequest) => {
          const body = request.body as { body: string; baseVersion: number };
          if (body.baseVersion !== latest(kindOf(request)).version) {
            return jsonResponse(
              {
                error: "Someone saved a newer version since you opened this.",
                code: "stale_version",
              },
              409,
            );
          }
          versions[kind].push({ body: body.body, savedAt: "2026-11-04T12:00:00.000Z" });
          return jsonResponse({ ok: true, document: latest(kind) });
        },
      ],
      [
        `GET ${documentPath(kind)}/versions`,
        () =>
          jsonResponse({
            versions: versions[kind]
              .map((entry, index) => ({
                version: index + 1,
                savedAt: entry.savedAt,
                savedBy: "Ada",
              }))
              .reverse(),
          }),
      ],
    ]),
  );
  seen = mockFetch({
    "GET /api/ui/features": () => jsonResponse({ features }),
    [`GET /api/ui/features/${FEATURE_ID}`]: () =>
      jsonResponse(features.find((feature) => feature.id === FEATURE_ID)),
    [`PATCH /api/ui/features/${FEATURE_ID}`]: (request) => {
      const { archived } = request.body as { archived: boolean };
      features = features.map((feature) =>
        feature.id === FEATURE_ID
          ? { ...feature, status: archived ? "archived" : "planning" }
          : feature,
      );
      return jsonResponse({ ok: true, feature: features.find((f) => f.id === FEATURE_ID) });
    },
    "POST /api/ui/features": (request) => {
      const body = request.body as { name: string; repositoryId: string | null };
      const created = featureRow({
        id: NEW_FEATURE_ID,
        name: body.name,
        repository: body.repositoryId
          ? { id: body.repositoryId, provider: "github", fullPath: "acme/portal" }
          : null,
        epicCount: 0,
      });
      features = [created, ...features];
      return jsonResponse({ ok: true, feature: created });
    },
    "GET /api/ui/repositories": () =>
      jsonResponse({ repositories: [portalRow()], truncated: false }),
    [`GET /api/ui/features/${FEATURE_ID}/attachments`]: () => jsonResponse({ attachments }),
    [`GET /api/ui/features/${FEATURE_ID}/shard`]: () =>
      jsonResponse({ shard: null, featureMapping: null, parentIssue: null }),
    [`POST /api/ui/features/${FEATURE_ID}/attachments`]: (request) => {
      const file = (request.body as FormData).get("file") as File;
      const created = attachmentRow({
        id: `dddddddd-dddd-4ddd-8ddd-${String(attachments.length + 2).padStart(12, "0")}`,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
      });
      attachments = [...attachments, created];
      return jsonResponse({ ok: true, attachment: created }, 201);
    },
    "DELETE /api/ui/attachments/dddddddd-dddd-4ddd-8ddd-ddddddddddd1": () => {
      attachments = attachments.filter((row) => row.id !== "dddddddd-dddd-4ddd-8ddd-ddddddddddd1");
      return jsonResponse({ ok: true });
    },
    ...documentRoutes,
    ...overrides,
  });
}

function renderView(props: FeaturesViewProps = {}, user: SessionUser = testUser) {
  const client = createTestQueryClient();
  return render(
    <CurrentUserProvider user={user}>
      <QueryClientProvider client={client}>
        <UiProvider linkComponent={TestLink}>
          <FeaturesView {...props} />
        </UiProvider>
      </QueryClientProvider>
    </CurrentUserProvider>,
  );
}

/** The feature page with a quick autosave. */
function renderFeature(user: SessionUser = testUser) {
  return renderView(
    {
      featureId: FEATURE_ID,
      renderDetail: (id) => <FeatureDetailView featureId={id} autosaveDelay={20} />,
    },
    user,
  );
}

const featurePane = () => screen.findByRole("article", { name: "Invoicing" });
const editor = async (name = "PRFAQ") =>
  (await screen.findByRole("textbox", { name })) as HTMLTextAreaElement;
const puts = () =>
  seen.filter((request) => request.method === "PUT").map((request) => request.body);

beforeEach(() => {
  ui.toast.mockReset();
  nav.router.push.mockReset();
  features = [
    featureRow(),
    featureRow({
      id: OTHER_FEATURE_ID,
      name: "Legacy exports",
      status: "archived",
      repository: null,
      epicCount: 1,
    }),
  ];
  versions = {
    prfaq: [
      { body: "# Invoicing\n\nFirst draft.", savedAt: "2026-11-01T10:00:00.000Z" },
      { body: "# Invoicing\n\nTeams bill customers.", savedAt: "2026-11-02T10:00:00.000Z" },
    ],
    plan: [],
  };
  attachments = [
    attachmentRow(),
    attachmentRow({
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd9",
      fileName: "flows.pdf",
      contentType: "application/pdf",
      size: 1536 * 1024,
    }),
  ];
  serve();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Features list", () => {
  it("lists each feature with its name, status and epic count, archived ones last", async () => {
    features = [features[1]!, features[0]!];
    renderView();
    const list = await screen.findByRole("list", { name: "Features" });
    const links = within(list).getAllByRole("listitem");
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("Invoicing"),
      expect.stringContaining("Legacy exports"),
    ]);
    expect(within(list).getByRole("link", { name: "Invoicing" }).getAttribute("href")).toBe(
      `/features/${FEATURE_ID}`,
    );
    expect(within(links[0]!).getByText("Planning")).toBeTruthy();
    expect(within(links[0]!).getByText("3 epics")).toBeTruthy();
    expect(within(links[0]!).getByText("acme/portal")).toBeTruthy();
    expect(within(links[1]!).getByText("Archived")).toBeTruthy();
    expect(within(links[1]!).getByText("1 epic")).toBeTruthy();
  });

  it("shows a skeleton while loading, then the empty state with New feature for admins", async () => {
    let answer!: (response: Response) => void;
    serve({ "GET /api/ui/features": () => new Promise((resolve) => (answer = resolve)) });
    renderView();
    expect(await screen.findByTestId("features-skeleton")).toBeTruthy();
    answer(jsonResponse({ features: [] }));
    expect(await screen.findByRole("heading", { name: NO_FEATURES })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New feature" })).toHaveLength(2);
  });

  it("gives members the empty state without New feature", async () => {
    features = [];
    renderView({}, member);
    expect(await screen.findByRole("heading", { name: NO_FEATURES })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New feature" })).toBeNull();
  });

  it("says when the list can't load, and tries again", async () => {
    let fail = true;
    serve({
      "GET /api/ui/features": () =>
        fail ? jsonResponse({ error: "Database unavailable." }, 500) : jsonResponse({ features }),
    });
    renderView();
    expect(await screen.findByRole("heading", { name: FEATURES_LOAD_FAILED })).toBeTruthy();
    expect(screen.getByText("Database unavailable.")).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Features" })).toBeTruthy();
  });

  it("creates a feature scoped to a repo and opens it", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: "New feature" }));
    const sheet = await screen.findByRole("dialog", { name: "New feature" });
    await userEvent.type(within(sheet).getByRole("textbox", { name: /Name/ }), "Checkout");
    await waitFor(() =>
      expect(
        within(sheet).getByRole("option", { name: "managed-services/customer-portal" }),
      ).toBeTruthy(),
    );
    await userEvent.selectOptions(
      within(sheet).getByRole("combobox", { name: /Repo/ }),
      REPO_PORTAL,
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(nav.router.push).toHaveBeenCalledWith(`/features/${NEW_FEATURE_ID}`),
    );
    expect(seen.find((request) => request.method === "POST")!.body).toEqual({
      name: "Checkout",
      repositoryId: REPO_PORTAL,
    });
    expect(await screen.findByRole("link", { name: /Checkout/ })).toBeTruthy();
  });
});

describe("a feature's PRFAQ and Plan", () => {
  it("autosaves an edit as a new version from the one it started from", async () => {
    renderFeature();
    const prfaq = await editor();
    expect(prfaq.value).toBe("# Invoicing\n\nTeams bill customers.");
    expect(screen.getByText(/Saved · version 2/)).toBeTruthy();
    await userEvent.type(prfaq, " Om sends them.");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Saved · version 3/)).toBeTruthy());
    expect(puts()).toEqual([
      { body: "# Invoicing\n\nTeams bill customers. Om sends them.", baseVersion: 2 },
    ]);
  });

  it("formats the selection from the toolbar, writing Markdown", async () => {
    renderFeature();
    const prfaq = await editor();
    prfaq.setSelectionRange(13, 18);
    await userEvent.click(screen.getAllByRole("button", { name: "Bold" })[0]!);
    expect(prfaq.value).toBe("# Invoicing\n\n**Teams** bill customers.");
    await userEvent.click(screen.getAllByRole("radio", { name: "Preview" })[0]!);
    const pane = await featurePane();
    expect(within(pane).getByText("Teams").tagName).toBe("STRONG");
  });

  it("writes a document never saved from version 0", async () => {
    renderFeature();
    await userEvent.click(await screen.findByRole("tab", { name: "Plan" }));
    const plan = await editor("Plan");
    expect(plan.value).toBe("");
    await userEvent.type(plan, "## Approach");
    await waitFor(() => expect(puts()).toEqual([{ body: "## Approach", baseVersion: 0 }]));
  });

  it("says clearly when someone else saved first, and loads their version", async () => {
    renderFeature();
    const prfaq = await editor();
    savedElsewhere("prfaq", "# Invoicing\n\nGrace's rewrite.");
    await userEvent.type(prfaq, " Mine.");
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(STALE_SAVE_TITLE)).toBeTruthy();
    expect(alert.textContent).toContain("your latest changes aren't saved");
    // It stops autosaving until the person chooses.
    expect(screen.queryByText(/Saved · version/)).toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: LOAD_THEIRS }));
    await waitFor(() => expect(prfaq.value).toBe("# Invoicing\n\nGrace's rewrite."));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Saved · version 3/)).toBeTruthy();
    expect(puts()).toHaveLength(1);
  });

  it("replaces their version with mine when asked", async () => {
    renderFeature();
    const prfaq = await editor();
    savedElsewhere("prfaq", "# Invoicing\n\nGrace's rewrite.");
    await userEvent.type(prfaq, " Mine.");
    const alert = await screen.findByRole("alert");
    await userEvent.click(within(alert).getByRole("button", { name: KEEP_MINE }));
    await waitFor(() => expect(screen.getByText(/Saved · version 4/)).toBeTruthy());
    expect(puts().at(-1)).toEqual({
      body: "# Invoicing\n\nTeams bill customers. Mine.",
      baseVersion: 3,
    });
    expect(prfaq.value).toBe("# Invoicing\n\nTeams bill customers. Mine.");
  });

  it("shows the version history and restores an earlier version as a new one", async () => {
    renderFeature();
    const prfaq = await editor();
    await userEvent.click(screen.getAllByRole("button", { name: "History" })[0]!);
    const sheet = await screen.findByRole("dialog", { name: "PRFAQ history" });
    const list = await within(sheet).findByRole("list", { name: "Versions" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      expect.stringContaining("Version 2 (current)"),
      expect.stringContaining("Version 1"),
    ]);
    expect(within(list).getAllByRole("button")[0]!.textContent).toContain("Ada");
    await userEvent.click(within(list).getByRole("button", { name: /Version 1/ }));
    const preview = await within(sheet).findByRole("region", { name: "Version 1" });
    expect(await within(preview).findByText("First draft.")).toBeTruthy();
    await userEvent.click(within(sheet).getByRole("button", { name: RESTORE_VERSION }));
    await waitFor(() => expect(prfaq.value).toBe("# Invoicing\n\nFirst draft."));
    await waitFor(() =>
      expect(puts()).toEqual([{ body: "# Invoicing\n\nFirst draft.", baseVersion: 2 }]),
    );
  });

  it("shows members the documents read-only, with their history but no restore", async () => {
    renderFeature(member);
    const pane = await featurePane();
    expect(within(pane).getByText(READ_ONLY_MEMBER)).toBeTruthy();
    expect(await within(pane).findByText("Teams bill customers.")).toBeTruthy();
    expect(within(pane).queryByRole("textbox")).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Archive" })).toBeNull();
    await userEvent.click(within(pane).getAllByRole("button", { name: "History" })[0]!);
    const sheet = await screen.findByRole("dialog", { name: "PRFAQ history" });
    await userEvent.click(await within(sheet).findByRole("button", { name: /Version 1/ }));
    expect(await within(sheet).findByText("First draft.")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: RESTORE_VERSION })).toBeNull();
  });

  it("makes an archived feature read-only until an admin restores it", async () => {
    features = [featureRow({ status: "archived" })];
    renderFeature();
    const pane = await featurePane();
    expect(within(pane).getByText(ARCHIVED_NOTE)).toBeTruthy();
    expect(await within(pane).findByText("Teams bill customers.")).toBeTruthy();
    expect(within(pane).queryByRole("textbox")).toBeNull();
    await userEvent.click(within(pane).getByRole("button", { name: "Restore" }));
    expect(await editor()).toBeTruthy();
    expect(within(pane).queryByText(ARCHIVED_NOTE)).toBeNull();
  });
});

describe("a feature's attachments", () => {
  const panel = async () => within(await screen.findByRole("region", { name: "Attachments" }));

  it("lists each attachment with its name and size", async () => {
    renderFeature();
    const files = await (await panel()).findByRole("list", { name: "Attachments" });
    const items = within(files).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("checkout.png2 KB"),
      expect.stringContaining("flows.pdf1.5 MB"),
    ]);
    expect(
      within(items[0]!).getByRole("link", { name: "Download checkout.png" }).getAttribute("href"),
    ).toBe(`${attachments[0]!.url}&download=1`);
  });

  it("uploads files chosen with the picker", async () => {
    attachments = [];
    renderFeature();
    const files = await panel();
    expect(await files.findByRole("heading", { name: NO_ATTACHMENTS })).toBeTruthy();
    const file = new File(["# spec"], "spec.md", { type: "text/markdown" });
    await userEvent.upload(screen.getByTestId("attachment-picker"), file);
    const list = await files.findByRole("list", { name: "Attachments" });
    expect(await within(list).findByText("spec.md")).toBeTruthy();
    const upload = seen.find((request) => request.method === "POST")!;
    expect(((upload.body as FormData).get("file") as File).name).toBe("spec.md");
    expect(ui.toast).toHaveBeenCalledWith("Attached spec.md");
  });

  it("uploads files dropped on the panel, refusing the ones it can't take before sending", async () => {
    renderFeature();
    const region = await screen.findByRole("region", { name: "Attachments" });
    const board = new File([new Uint8Array(10)], "board.webp", { type: "image/webp" });
    const huge = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "huge.png", {
      type: "image/png",
    });
    const script = new File(["x"], "run.sh", { type: "application/x-sh" });
    fireEvent.dragEnter(region, { dataTransfer: { types: ["Files"], files: [] } });
    expect(within(region).getByText("Drop files to attach them")).toBeTruthy();
    fireEvent.drop(region, { dataTransfer: { types: ["Files"], files: [board, huge, script] } });
    expect(await within(region).findByText("board.webp")).toBeTruthy();
    const problems = within(region).getByRole("alert");
    expect(problems.textContent).toContain("huge.png is over 4 MB.");
    expect(problems.textContent).toContain("run.sh isn't a type you can attach.");
    const uploads = seen.filter((request) => request.method === "POST");
    expect(uploads.map((request) => ((request.body as FormData).get("file") as File).name)).toEqual(
      ["board.webp"],
    );
  });

  it("previews images and PDFs", async () => {
    renderFeature();
    const files = await panel();
    await userEvent.click(await files.findByRole("button", { name: "Preview checkout.png" }));
    const image = await screen.findByRole("dialog", { name: "checkout.png" });
    expect(within(image).getByRole("img", { name: "checkout.png" }).getAttribute("src")).toBe(
      attachments[0]!.url,
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(files.getByRole("button", { name: "Preview flows.pdf" }));
    const pdf = await screen.findByRole("dialog", { name: "flows.pdf" });
    expect(within(pdf).getByTitle("flows.pdf").getAttribute("src")).toBe(attachments[1]!.url);
  });

  it("removes an attachment only after confirmation", async () => {
    renderFeature();
    const files = await panel();
    await userEvent.click(await files.findByRole("button", { name: "Remove checkout.png" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove attachment" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(seen.some((request) => request.method === "DELETE")).toBe(false);
    expect(files.getByText("checkout.png")).toBeTruthy();
    await userEvent.click(files.getByRole("button", { name: "Remove checkout.png" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(files.queryByText("checkout.png")).toBeNull());
    expect(seen.filter((request) => request.method === "DELETE").map((r) => r.path)).toEqual([
      "/api/ui/attachments/dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
    ]);
  });

  it("lets members preview and download but not upload or remove", async () => {
    renderFeature(member);
    const files = await panel();
    expect(await files.findByRole("button", { name: "Preview checkout.png" })).toBeTruthy();
    expect(files.getByRole("link", { name: "Download checkout.png" })).toBeTruthy();
    expect(files.queryByRole("button", { name: "Choose files" })).toBeNull();
    expect(files.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByTestId("attachment-picker")).toBeNull();
  });

  it("shows the server's refusal of an upload", async () => {
    serve({
      [`POST /api/ui/features/${FEATURE_ID}/attachments`]: () =>
        jsonResponse({ error: "Attachments aren't set up.", code: "storage_off" }, 503),
    });
    renderFeature();
    await panel();
    await userEvent.upload(
      screen.getByTestId("attachment-picker"),
      new File(["a"], "notes.txt", { type: "text/plain" }),
    );
    const region = await screen.findByRole("region", { name: "Attachments" });
    expect((await within(region).findByRole("alert")).textContent).toBe(
      "notes.txt: Attachments aren't set up.",
    );
  });
});
