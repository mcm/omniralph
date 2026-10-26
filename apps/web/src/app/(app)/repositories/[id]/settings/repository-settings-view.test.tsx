import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import {
  RepositorySettingsContent,
  type RepositoryAgent,
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

const AGENTS: RepositoryAgent[] = [
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
    agents?: RepositoryAgent[];
    pinnedAgentIds?: string[];
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
          pinnedAgentIds: overrides.pinnedAgentIds ?? [],
        }}
        agents={overrides.agents ?? AGENTS}
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
  return (["settings", "agents"] as const).flatMap((tab) =>
    [...render(tab).matchAll(/<label[^>]*>(.*?)<\/label>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ""),
    ),
  );
}

describe("RepositorySettingsView playbook bindings", () => {
  it("has no review, correlation, story or request playbook selects", () => {
    const html = render("settings") + render("agents");
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
    expect(saves("agents")).toEqual(["Save agents"]);
  });

  it("shows only its own tab's settings", () => {
    const settings = render("settings");
    expect(settings).toContain('id="path-excludes"');
    expect(settings).not.toContain("Pinned agents");
    const agents = render("agents");
    expect(agents).toContain("Any agent can run this repository&#x27;s jobs.");
    expect(agents).not.toContain('id="path-excludes"');
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
    for (const tab of ["settings", "agents"] as const) {
      const html = render(tab);
      expect(html).not.toMatch(/id="task-type-/);
      expect(text(html)).not.toContain("Use organization default");
      expect(text(html)).not.toContain("Settings › Agents");
    }
  });

  it("says when reviews are off", () => {
    expect(render("settings")).not.toContain("Reviews are off");
    const off = render("settings", { taskTypes: { ...allOn, reviews: false } });
    expect(off).toContain("Reviews are off");
  });

  it("never says Ralph", () => {
    for (const tab of ["settings", "agents"] as const) {
      expect(text(render(tab))).not.toMatch(/\bRalph\b/);
    }
  });
});

describe("RepositorySettingsView pinned agents", () => {
  it("picks pinned agents from a searchable list, not a checkbox per agent", () => {
    const html = render("agents");
    expect(html).toMatch(
      /<button[^>]*role="combobox"[^>]*id="pinned-agents"|<button[^>]*id="pinned-agents"[^>]*role="combobox"/,
    );
    expect(html).not.toContain('id="pin-h1"');
    expect(text(html)).toContain("Any agent");
  });

  it("shows the pinned agents as chips by name", () => {
    const html = render("agents", { pinnedAgentIds: ["h2"] });
    expect(text(html)).toContain("build-02");
    expect(text(html)).not.toContain("build-01");
    expect(html).toContain("Only the pinned agent runs this repository&#x27;s jobs.");
  });

  it("lists the pinned agents below the picker with their status", () => {
    const html = render("agents", { pinnedAgentIds: ["h2"] });
    const list = /<ul[^>]*aria-label="Pinned agents"[^>]*>(.*?)<\/ul>/.exec(html);
    expect(list).not.toBeNull();
    expect(text(list![1]!)).toMatch(/build-02.*Review.*Offline/);
    expect(list![1]).toContain('aria-label="Unpin build-02"');
    expect(text(html)).not.toContain("None pinned");
  });

  it("says jobs go to any eligible agent when none is pinned", () => {
    const html = render("agents");
    expect(html).not.toContain('aria-label="Pinned agents"');
    expect(text(html)).toContain("None pinned: jobs go to any eligible agent");
  });

  it("lists a pin to a revoked agent as revoked", () => {
    const html = render("agents", {
      agents: [...AGENTS, { ...AGENTS[0]!, id: "h3", name: "old-01", revoked: true }],
      pinnedAgentIds: ["h3"],
    });
    expect(text(html)).toMatch(/old-01.*Revoked/);
    expect(text(html)).toMatch(/“old-01” is not available\. It was revoked or deleted/);
  });

  it("keeps a pin to an agent that is no longer pinnable, with a warning", () => {
    const html = render("agents", { pinnedAgentIds: ["gone"] });
    expect(text(html)).toMatch(/gone/);
    expect(text(html)).toMatch(/revoked or deleted/);
  });

  it("says any agent runs the jobs when none is enrolled", () => {
    const html = render("agents", { agents: [] });
    expect(html).not.toContain('id="pinned-agents"');
    expect(text(html)).toMatch(/No agents are enrolled yet/);
  });
});
