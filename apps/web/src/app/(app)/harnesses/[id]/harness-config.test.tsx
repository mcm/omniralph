// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render as renderDom, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessRow } from "@/lib/harnesses/rows";
import {
  configDraft,
  configInput,
  HarnessSettingsSection,
  versionDraft,
  versionInput,
} from "./harness-detail-view";

const actions = vi.hoisted(() => ({
  searchPinnableRepositories: vi.fn(),
  pinRepository: vi.fn(),
  unpinRepository: vi.fn(),
  updateHarnessConfig: vi.fn(async () => ({ ok: true }) as const),
  setHarnessDesiredVersion: vi.fn(async () => ({ ok: true }) as const),
  requestHarnessUpdate: vi.fn(),
}));
vi.mock("../actions", () => actions);
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
  } as unknown as HarnessRow;
}

const inheriting = harness({ acceptedTaskTypes: null, maxConcurrency: null });
const overriding = harness({ acceptedTaskTypes: ["coding"], maxConcurrency: 2 });

/** The opening tag of the element with `id`. */
function tag(html: string, id: string): string {
  return html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
}

function render(harness: HarnessRow): string {
  return renderToStaticMarkup(
    <HarnessSettingsSection harness={harness} globalDesiredVersion="1.4.0" />,
  );
}

describe("HarnessSettingsSection", () => {
  beforeEach(() => vi.clearAllMocks());

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
      <HarnessSettingsSection harness={inheriting} globalDesiredVersion={null} />,
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
    renderDom(<HarnessSettingsSection harness={inheriting} globalDesiredVersion="1.4.0" />);
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
    await waitFor(() =>
      expect(actions.updateHarnessConfig).toHaveBeenCalledWith(inheriting.id, {
        maxConcurrency: 3,
        acceptedTaskTypes: null,
        poolLimits: {},
      }),
    );
    expect(actions.setHarnessDesiredVersion).not.toHaveBeenCalled();
  });

  it("goes back to inheriting an overridden version, and saves that as no override", async () => {
    renderDom(
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
      expect(actions.setHarnessDesiredVersion).toHaveBeenCalledWith(overriding.id, ""),
    );
    expect(actions.updateHarnessConfig).not.toHaveBeenCalled();
  });

  it("needs a version to override the organization's", async () => {
    renderDom(<HarnessSettingsSection harness={inheriting} globalDesiredVersion="1.4.0" />);
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
      expect(actions.setHarnessDesiredVersion).toHaveBeenCalledWith(inheriting.id, "1.5.0"),
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
