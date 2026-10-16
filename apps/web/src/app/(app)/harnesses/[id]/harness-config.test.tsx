// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render as renderDom, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  mockFetch,
  queryWrapper,
  type SeenRequest,
} from "@/components/query-test-utils";
import type { HarnessRow } from "@/lib/harnesses/rows";
import {
  configDraft,
  configInput,
  HarnessSettingsSection,
  pickupState,
  updateProgress,
  versionDraft,
  versionInput,
} from "./harness-detail-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("../../jobs/actions", () => ({}));
vi.mock("../../repositories/actions", () => ({}));

const defaults = { acceptedTaskTypes: ["query", "review"], maxConcurrency: 6 };

function harness(overrides: HarnessRow["overrides"]): HarnessRow {
  const acceptedTaskTypes = overrides.acceptedTaskTypes ?? defaults.acceptedTaskTypes;
  const maxConcurrency = overrides.maxConcurrency ?? defaults.maxConcurrency;
  return {
    id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f",
    revoked: false,
    acceptedTaskTypes,
    maxConcurrency,
    overrides,
    defaults,
    poolLimits: {},
    effectivePoolLimits: { short: maxConcurrency, long: maxConcurrency - 1 },
    updateRequest: null,
    name: "build-01",
    selfUpdate: "supported",
    desiredVersionOverride: null,
    pinnedRepositories: [],
    version: "1.0.0",
    update: null,
    failedVersions: [],
    lastHeartbeatAt: "2026-10-16T09:59:50.000Z",
  } as unknown as HarnessRow;
}

const inheriting = harness({ acceptedTaskTypes: null, maxConcurrency: null });
const overriding = harness({ acceptedTaskTypes: ["coding"], maxConcurrency: 2 });

/** The opening tag of the element with `id`. */
function tag(html: string, id: string): string {
  return html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
}

/** The signed-in user and a query client, as the app shell provides them. */
function Providers({ children }: { children: React.ReactNode }) {
  const [Wrapper] = React.useState(() => queryWrapper(createTestQueryClient()));
  return <Wrapper>{children}</Wrapper>;
}

function render(harness: HarnessRow): string {
  return renderToStaticMarkup(
    <Providers>
      <HarnessSettingsSection harness={harness} globalDesiredVersion="1.4.0" />
    </Providers>,
  );
}

function renderLive(ui: React.ReactElement) {
  return renderDom(ui, { wrapper: Providers });
}

const SAVED_AT = "2026-10-16T10:00:00.000Z";
let requests: SeenRequest[];

/** The bodies of the settings saves sent so far. */
function saves(harnessId: string) {
  return requests
    .filter((r) => r.method === "PUT" && r.path === `/api/ui/harnesses/${harnessId}/settings`)
    .map((r) => r.body);
}

describe("HarnessSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requests = mockFetch({
      [`PUT /api/ui/harnesses/${inheriting.id}/settings`]: { ok: true, savedAt: SAVED_AT },
    });
  });

  it("says what each inherited setting inherits, with an Override button and no controls", () => {
    const html = render(inheriting);
    expect(html).toContain("Inherits 6 from the organization.");
    expect(html).toContain("Inherits Query and Review from the organization.");
    expect(html).toContain("Inherits 1.4.0 from the organization.");
    expect(html).not.toContain("Use organization default");
    expect(html).not.toContain("the organization&#x27;s 6");
    for (const id of ["max-concurrency", "task-type-query", "desired-version"]) {
      expect(tag(html, id)).toBe("");
    }
    for (const name of ["max concurrency", "accepted task types", "desired version"]) {
      expect(html).toContain(`aria-label="Override ${name}"`);
    }
  });

  it("names a version the organization doesn't set", () => {
    const html = renderToStaticMarkup(
      <Providers>
        <HarnessSettingsSection harness={inheriting} globalDesiredVersion={null} />
      </Providers>,
    );
    expect(html).toContain("Inherits no version from the organization.");
  });

  it("shows the harness's own values, editable, when it overrides them", () => {
    const html = render({ ...overriding, desiredVersionOverride: "1.3.2" } as HarnessRow);
    expect(html).toContain("Overrides the organization&#x27;s 6.");
    expect(html).toContain("Overrides the organization&#x27;s Query and Review.");
    expect(html).toContain("Overrides the organization&#x27;s 1.4.0.");
    for (const name of ["max concurrency", "accepted task types", "desired version"]) {
      expect(html).toContain(`aria-label="Inherit ${name} from the organization"`);
    }
    expect(tag(html, "max-concurrency")).toContain('value="2"');
    expect(tag(html, "max-concurrency")).not.toMatch(/ disabled=""/);
    expect(tag(html, "task-type-coding")).toContain('aria-checked="true"');
    expect(tag(html, "task-type-query")).toContain('aria-checked="false"');
    expect(tag(html, "task-type-query")).not.toMatch(/ disabled=""/);
    expect(tag(html, "desired-version")).toContain('value="1.3.2"');
  });

  it("saves concurrency, task types, pins and the version with one save", () => {
    const html = render(inheriting);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain("Save settings");
    for (const title of ["Concurrency", "Task types", "Pinned repositories", "Version"]) {
      expect(html).toContain(`>${title}</h3>`);
    }
    expect(html).toContain("Update now</button>");
  });

  it("overrides from the organization's values and inherits again", async () => {
    renderLive(<HarnessSettingsSection harness={inheriting} globalDesiredVersion="1.4.0" />);
    await userEvent.click(screen.getByRole("button", { name: "Override max concurrency" }));
    const input = screen.getByLabelText("Jobs at once") as HTMLInputElement;
    expect(input.value).toBe("6");
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("Overrides the organization's 6.")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    await userEvent.click(screen.getByRole("button", { name: "Override accepted task types" }));
    expect(document.activeElement?.id).toBe("task-type-query");
    expect(screen.getByRole("checkbox", { name: "Query" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByText("2 unsaved changes")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Inherit accepted task types from the organization" }),
    );
    expect(screen.queryByRole("checkbox", { name: "Query" })).toBeNull();
    expect(screen.getByText("Inherits Query and Review from the organization.")).toBeTruthy();
    expect(document.activeElement?.id).toBe("task-types-source-override");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Inherits 6 from the organization");
    await userEvent.click(
      [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
    );
    // One request with only the changed parts.
    await waitFor(() =>
      expect(saves(inheriting.id)).toEqual([
        {
          config: { maxConcurrency: 3, acceptedTaskTypes: null, poolLimits: {} },
          unpin: [],
          pin: [],
        },
      ]),
    );
  });

  it("goes back to inheriting an overridden version, and saves that as no override", async () => {
    renderLive(
      <HarnessSettingsSection
        harness={{ ...overriding, desiredVersionOverride: "1.3.2" } as HarnessRow}
        globalDesiredVersion="1.4.0"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inherit desired version from the organization" }),
    );
    expect(document.getElementById("desired-version")).toBeNull();
    expect(screen.getByText("Inherits 1.4.0 from the organization.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("1.3.2");
    await userEvent.click(
      [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
    );
    await waitFor(() =>
      expect(saves(overriding.id)).toEqual([{ version: "", unpin: [], pin: [] }]),
    );
  });

  it("needs a version to override the organization's", async () => {
    renderLive(<HarnessSettingsSection harness={inheriting} globalDesiredVersion="1.4.0" />);
    await userEvent.click(screen.getByRole("button", { name: "Override desired version" }));
    const input = document.getElementById("desired-version") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText(/Enter a version like 1\.4\.0/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await userEvent.type(input, "1.5.0");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
    );
    await waitFor(() =>
      expect(saves(inheriting.id)).toEqual([{ version: "1.5.0", unpin: [], pin: [] }]),
    );
  });

  it("shows the pinned repositories as chips in a searchable picker", () => {
    const html = render({
      ...inheriting,
      pinnedRepositories: [
        {
          id: "repo-1",
          provider: "github",
          fullPath: "acme/api",
          webUrl: "https://github.com/acme/api",
        },
      ],
    } as HarnessRow);
    expect(tag(html, "pinned-repositories")).toContain('role="combobox"');
    expect(html).toContain("acme/api");
    expect(html).toMatch(/Jobs for this repository only go to the harnesses/);
    expect(render(inheriting)).toMatch(/None: this harness serves every repository/);
  });

  it("is read-only on a revoked harness", () => {
    const html = render({
      ...overriding,
      revoked: true,
      desiredVersionOverride: "1.3.2",
    } as HarnessRow);
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain("Update now</button>");
    expect(html).not.toContain("Override</button>");
    expect(html).not.toContain("Inherit</button>");
    expect(tag(html, "max-concurrency")).toMatch(/ disabled=""/);
    expect(tag(html, "desired-version")).toMatch(/ disabled=""/);
  });
});

/** Confirms the save dialog. */
async function confirmSave() {
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(
    [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
  );
}

describe("HarnessSettingsSection, live", () => {
  beforeEach(() => {
    requests = mockFetch({
      [`PUT /api/ui/harnesses/${inheriting.id}/settings`]: { ok: true, savedAt: SAVED_AT },
      [`POST /api/ui/harnesses/${inheriting.id}/update`]: { ok: true, version: "2.0.0" },
    });
  });

  it("says the save waits for the harness until a heartbeat after it, then that it's applied", async () => {
    const { rerender } = renderLive(
      <HarnessSettingsSection harness={inheriting} globalDesiredVersion="1.4.0" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Override max concurrency" }));
    await userEvent.clear(screen.getByLabelText("Jobs at once"));
    await userEvent.type(screen.getByLabelText("Jobs at once"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await confirmSave();

    // The refetch after the save brings the saved values; the last heartbeat is older.
    const saved = harness({ acceptedTaskTypes: null, maxConcurrency: 3 });
    rerender(<HarnessSettingsSection harness={saved} globalDesiredVersion="1.4.0" />);
    expect(await screen.findByText("Saved — waiting for build-01 to pick it up")).toBeTruthy();

    // A heartbeat after the save picked it up.
    rerender(
      <HarnessSettingsSection
        harness={{ ...saved, lastHeartbeatAt: "2026-10-16T10:00:12.000Z" }}
        globalDesiredVersion="1.4.0"
      />,
    );
    expect(await screen.findByText("Applied")).toBeTruthy();
    expect(screen.queryByText(/waiting for build-01/)).toBeNull();
  });

  it("never overwrites an edited form with a background refetch, and follows one while clean", async () => {
    const { rerender } = renderLive(
      <HarnessSettingsSection harness={overriding} globalDesiredVersion="1.4.0" />,
    );
    const input = () => screen.getByLabelText("Jobs at once") as HTMLInputElement;
    expect(input().value).toBe("2");

    // Clean: another tab's change shows up.
    const changed = harness({ acceptedTaskTypes: ["coding"], maxConcurrency: 4 });
    rerender(<HarnessSettingsSection harness={changed} globalDesiredVersion="1.4.0" />);
    expect(input().value).toBe("4");

    // Dirty: a refetch with yet other values leaves the edit alone.
    await userEvent.clear(input());
    await userEvent.type(input(), "7");
    rerender(
      <HarnessSettingsSection
        harness={harness({ acceptedTaskTypes: ["coding"], maxConcurrency: 5 })}
        globalDesiredVersion="1.4.0"
      />,
    );
    expect(input().value).toBe("7");
    expect(screen.getByText("1 unsaved change")).toBeTruthy();
  });

  it("shows an Update now through requested, updating and updated as the harness reports it", async () => {
    const { rerender } = renderLive(
      <HarnessSettingsSection harness={inheriting} globalDesiredVersion="1.4.0" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Update now" }));
    const requested = {
      ...inheriting,
      updateRequest: { version: "2.0.0", requestedAt: SAVED_AT },
    } as HarnessRow;
    rerender(<HarnessSettingsSection harness={requested} globalDesiredVersion="1.4.0" />);
    expect(
      await screen.findByText(
        "Update to 2.0.0 requested; build-01 starts it with its next heartbeat.",
      ),
    ).toBeTruthy();
    const update = {
      state: "installing",
      version: "2.0.0",
      previous: "1.0.0",
      startsSincePending: 0,
      error: null,
    } as const;
    rerender(
      <HarnessSettingsSection harness={{ ...inheriting, update }} globalDesiredVersion="1.4.0" />,
    );
    expect(screen.getByText("build-01 is updating to 2.0.0: installing it.")).toBeTruthy();
    rerender(
      <HarnessSettingsSection
        harness={{ ...inheriting, version: "2.0.0", update: { ...update, state: "idle" } }}
        globalDesiredVersion="1.4.0"
      />,
    );
    expect(screen.getByText("build-01 updated to 2.0.0.")).toBeTruthy();
  });
});

describe("pickupState", () => {
  it("is pending until a heartbeat later than the save", () => {
    expect(pickupState(null, SAVED_AT)).toBeNull();
    expect(pickupState(SAVED_AT, null)).toBe("pending");
    expect(pickupState(SAVED_AT, "2026-10-16T09:59:59.000Z")).toBe("pending");
    expect(pickupState(SAVED_AT, SAVED_AT)).toBe("pending");
    expect(pickupState(SAVED_AT, "2026-10-16T10:00:01.000Z")).toBe("applied");
  });
});

describe("updateProgress", () => {
  const base = {
    name: "build-01",
    version: "1.0.0",
    update: null,
    failedVersions: [],
    updateRequest: null,
  };
  it("reports a failed version with the harness's error", () => {
    expect(
      updateProgress(
        {
          ...base,
          failedVersions: ["2.0.0"],
          update: {
            state: "idle",
            version: null,
            previous: "1.0.0",
            startsSincePending: 3,
            error: "didn't stay up",
          },
        },
        "2.0.0",
      ),
    ).toEqual({ stage: "failed", text: "Update to 2.0.0 failed: didn't stay up" });
    expect(
      updateProgress(
        {
          ...base,
          update: {
            state: "draining",
            version: "2.0.0",
            previous: null,
            startsSincePending: 0,
            error: null,
          },
        },
        "2.0.0",
      ),
    ).toEqual({
      stage: "updating",
      text: "build-01 is updating to 2.0.0: letting its running jobs finish.",
    });
  });
});

describe("versionInput", () => {
  it("clears the override while inherited and checks an override", () => {
    expect(versionInput(versionDraft({ desiredVersionOverride: null }))).toEqual({ version: "" });
    expect(versionInput({ inherit: false, version: " 1.5.0 " })).toEqual({ version: "1.5.0" });
    expect(versionInput({ inherit: false, version: "v1.5.0" })).toEqual({ version: "v1.5.0" });
    expect(versionInput({ inherit: false, version: "" })).toHaveProperty("error");
    expect(versionInput({ inherit: false, version: "latest" })).toHaveProperty("error");
  });
});

describe("configInput", () => {
  it("saves null for inherited fields", () => {
    expect(configInput(configDraft(inheriting))).toEqual({
      maxConcurrency: null,
      acceptedTaskTypes: null,
      poolLimits: {},
    });
  });

  it("saves an override starting from the inherited values", () => {
    const draft = { ...configDraft(inheriting), inheritMaxConcurrency: false };
    expect(configInput(draft)).toEqual({
      maxConcurrency: 6,
      acceptedTaskTypes: null,
      poolLimits: {},
    });
    expect(
      configInput({ ...draft, inheritTaskTypes: false, taskTypes: ["coding", "query"] }),
    ).toEqual({ maxConcurrency: 6, acceptedTaskTypes: ["query", "coding"], poolLimits: {} });
  });

  it("saves the harness's own values and switches back to inheriting", () => {
    const draft = { ...configDraft(overriding), limits: { long: "1", short: " " } };
    expect(configInput(draft)).toEqual({
      maxConcurrency: 2,
      acceptedTaskTypes: ["coding"],
      poolLimits: { long: 1 },
    });
    expect(configInput({ ...draft, inheritMaxConcurrency: true, inheritTaskTypes: true })).toEqual({
      maxConcurrency: null,
      acceptedTaskTypes: null,
      poolLimits: { long: 1 },
    });
  });
});
