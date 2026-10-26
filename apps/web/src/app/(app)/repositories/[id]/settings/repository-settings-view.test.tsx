import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import {
  RepositorySettingsContent,
  type RepositoryHarness,
  type RepositorySettingsTab,
} from "./repository-settings-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/use-settings-save", () => ({
  useSettingsSave: () => ({ pending: false, run: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/settings",
  useRouter: () => ({ push: vi.fn() }),
}));

type TaskTypes = Parameters<typeof RepositorySettingsContent>[0]["taskTypes"];

const allOn: TaskTypes = { reviews: true, coding: true, ask: true };

const HARNESSES: RepositoryHarness[] = [
  {
    id: "h1",
    name: "build-01",
    online: true,
    revoked: false,
    updating: false,
    acceptedTaskTypes: ["review", "coding"],
  },
  {
    id: "h2",
    name: "build-02",
    online: false,
    revoked: false,
    updating: false,
    acceptedTaskTypes: ["review"],
  },
];

function render(
  tab: RepositorySettingsTab,
  overrides: {
    taskTypes?: TaskTypes;
    harnesses?: RepositoryHarness[];
    pinnedHarnessIds?: string[];
  } = {},
) {
  const Wrapper = queryWrapper(createTestQueryClient());
  return renderToStaticMarkup(
    <Wrapper>
      <RepositorySettingsContent
        tab={tab}
        repository={{
          id: "repo-1",
          provider: "github",
          fullPath: "acme/app",
          webUrl: "https://github.com/acme/app",
        }}
        settings={{
          depth: "standard",
          triggers: { onOpen: true, onPush: true, drafts: false },
          pathExcludes: [],
          customInstructions: "",
          pinnedHarnessIds: overrides.pinnedHarnessIds ?? [],
        }}
        harnesses={overrides.harnesses ?? HARNESSES}
        taskTypes={overrides.taskTypes ?? allOn}
      />
    </Wrapper>,
  );
}

/** The page's visible text, tags dropped. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/** The labels of every tab. */
function allLabels(): string[] {
  return (["settings", "harnesses"] as const).flatMap((tab) =>
    [...render(tab).matchAll(/<label[^>]*>(.*?)<\/label>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ""),
    ),
  );
}

describe("RepositorySettingsView playbook bindings", () => {
  it("has no review, correlation, story or request playbook selects", () => {
    const html = render("settings") + render("harnesses");
    for (const id of [
      "review-task-",
      "correlation-task",
      "ralph-story-task",
      "ralph-request-task",
    ]) {
      expect(html).not.toContain(`id="${id}`);
    }
    expect(html).not.toMatch(/Who reviews|Story task|Request task|Correlation task/);
  });
});

describe("RepositorySettingsView tabs", () => {
  it("shows one section with one save per tab", () => {
    const saves = (tab: RepositorySettingsTab) =>
      [...render(tab).matchAll(/<button[^>]*type="submit"[^>]*>(.*?)<\/button>/g)].map((m) =>
        m[1]!.replace(/<[^>]+>/g, ""),
      );
    expect(saves("settings")).toEqual(["Save review settings"]);
    expect(saves("harnesses")).toEqual(["Save harnesses"]);
  });

  it("shows only its own tab's settings", () => {
    const settings = render("settings");
    expect(settings).toContain('id="path-excludes"');
    expect(settings).not.toContain("Pinned harnesses");
    const harnesses = render("harnesses");
    expect(harnesses).toContain("Any harness can run this repository&#x27;s jobs.");
    expect(harnesses).not.toContain('id="path-excludes"');
  });

  it("names the tab in the breadcrumb-free section only for screen readers", () => {
    const html = render("settings");
    expect(html).toMatch(/<h2[^>]*class="sr-only"[^>]*>Review settings<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>When<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Scope<\/h3>/);
  });

  it("has no review profile control (the depth is set elsewhere)", () => {
    const html = render("settings");
    expect(html).not.toContain("settings-profile");
    expect(html).not.toContain("/settings/profiles");
    expect(html).not.toMatch(/>Profile</);
  });

  it("labels settings in plain words, not by their config keys", () => {
    const labels = allLabels();
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (const label of labels) expect(label).not.toMatch(/\b[a-z]+[A-Z][a-zA-Z]*\b/);
  });

  it("states each setting's default", () => {
    const settings = render("settings");
    expect(settings).toContain("Default: Off.");
  });
});

describe("RepositorySettingsView task types", () => {
  it("has no task-type selects: the switches aren't edited here", () => {
    for (const tab of ["settings", "harnesses"] as const) {
      const html = render(tab);
      expect(html).not.toMatch(/id="task-type-/);
      expect(text(html)).not.toContain("Use organization default");
      expect(text(html)).not.toContain("Settings › Harnesses");
    }
  });

  it("says when reviews are off", () => {
    expect(render("settings")).not.toContain("Reviews are off");
    const off = render("settings", { taskTypes: { ...allOn, reviews: false } });
    expect(off).toContain("Reviews are off");
  });

  it("never says Ralph", () => {
    for (const tab of ["settings", "harnesses"] as const) {
      expect(text(render(tab))).not.toMatch(/\bRalph\b/);
    }
  });
});

describe("RepositorySettingsView pinned harnesses", () => {
  it("picks pinned harnesses from a searchable list, not a checkbox per harness", () => {
    const html = render("harnesses");
    expect(html).toMatch(
      /<button[^>]*role="combobox"[^>]*id="pinned-harnesses"|<button[^>]*id="pinned-harnesses"[^>]*role="combobox"/,
    );
    expect(html).not.toContain('id="pin-h1"');
    expect(text(html)).toContain("Any harness");
  });

  it("shows the pinned harnesses as chips by name", () => {
    const html = render("harnesses", { pinnedHarnessIds: ["h2"] });
    expect(text(html)).toContain("build-02");
    expect(text(html)).not.toContain("build-01");
    expect(html).toContain("Only the pinned harness runs this repository&#x27;s jobs.");
  });

  it("lists the pinned harnesses below the picker with their status", () => {
    const html = render("harnesses", { pinnedHarnessIds: ["h2"] });
    const list = /<ul[^>]*aria-label="Pinned harnesses"[^>]*>(.*?)<\/ul>/.exec(html);
    expect(list).not.toBeNull();
    expect(text(list![1]!)).toMatch(/build-02.*Review.*Offline/);
    expect(list![1]).toContain('aria-label="Unpin build-02"');
    expect(text(html)).not.toContain("None pinned");
  });

  it("says jobs go to any eligible harness when none is pinned", () => {
    const html = render("harnesses");
    expect(html).not.toContain('aria-label="Pinned harnesses"');
    expect(text(html)).toContain("None pinned: jobs go to any eligible harness");
  });

  it("lists a pin to a revoked harness as revoked", () => {
    const html = render("harnesses", {
      harnesses: [...HARNESSES, { ...HARNESSES[0]!, id: "h3", name: "old-01", revoked: true }],
      pinnedHarnessIds: ["h3"],
    });
    expect(text(html)).toMatch(/old-01.*Revoked/);
    expect(text(html)).toMatch(/“old-01” is not available\. It was revoked or deleted/);
  });

  it("keeps a pin to a harness that is no longer pinnable, with a warning", () => {
    const html = render("harnesses", { pinnedHarnessIds: ["gone"] });
    expect(text(html)).toMatch(/gone/);
    expect(text(html)).toMatch(/revoked or deleted/);
  });

  it("says any harness runs the jobs when none is enrolled", () => {
    const html = render("harnesses", { harnesses: [] });
    expect(html).not.toContain('id="pinned-harnesses"');
    expect(text(html)).toMatch(/No harnesses are enrolled yet/);
  });
});
