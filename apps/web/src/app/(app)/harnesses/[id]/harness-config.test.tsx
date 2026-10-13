import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { configDraft, configInput, HarnessSettingsSection } from "./harness-detail-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("../actions", () => ({}));
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
  it("shows the organization's values, locked, while the harness inherits them", () => {
    const html = render(inheriting);
    expect(html.match(/Use organization default/g)).toHaveLength(2);
    expect(tag(html, "max-concurrency-inherit")).toContain('aria-checked="true"');
    expect(tag(html, "task-types-inherit")).toContain('aria-checked="true"');
    expect(tag(html, "max-concurrency")).toContain('value="6"');
    expect(tag(html, "max-concurrency")).toMatch(/ disabled=""/);
    expect(tag(html, "task-type-query")).toContain('aria-checked="true"');
    expect(tag(html, "task-type-review")).toContain('aria-checked="true"');
    expect(tag(html, "task-type-coding")).toContain('aria-checked="false"');
    expect(tag(html, "task-type-coding")).toMatch(/ disabled=""/);
    expect(html).toContain("Organization default: Query and Review.");
  });

  it("shows the harness's own values, editable, when it overrides them", () => {
    const html = render(overriding);
    expect(tag(html, "max-concurrency-inherit")).toContain('aria-checked="false"');
    expect(tag(html, "task-types-inherit")).toContain('aria-checked="false"');
    expect(tag(html, "max-concurrency")).toContain('value="2"');
    expect(tag(html, "max-concurrency")).not.toMatch(/ disabled=""/);
    expect(tag(html, "task-type-coding")).toContain('aria-checked="true"');
    expect(tag(html, "task-type-query")).toContain('aria-checked="false"');
    expect(tag(html, "task-type-query")).not.toMatch(/ disabled=""/);
  });

  it("saves concurrency, task types, pins and the version override with one save", () => {
    const html = render(inheriting);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain("Save settings");
    for (const title of ["Concurrency", "Task types", "Pinned repositories", "Version"]) {
      expect(html).toContain(`>${title}</h3>`);
    }
    expect(tag(html, "desired-version")).toContain('placeholder="Organization (1.4.0)"');
    expect(html).toContain("Update now</button>");
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
    const html = render({ ...overriding, revoked: true } as HarnessRow);
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain("Update now</button>");
    expect(tag(html, "max-concurrency")).toMatch(/ disabled=""/);
    expect(tag(html, "desired-version")).toMatch(/ disabled=""/);
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
