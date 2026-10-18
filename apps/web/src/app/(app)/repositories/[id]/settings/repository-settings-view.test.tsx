import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import {
  createTestQueryClient,
  mockFetch,
  queryWrapper,
  TEST_ORGANIZATION_ID,
} from "@/components/query-test-utils";
import {
  RepositorySettingsContent,
  type RepositoryHarness,
  type RepositorySettingsTab,
} from "./repository-settings-view";
import type { CodingChoices, RalphSettingsValues } from "./ralph-settings-section";
import {
  inheritLabel,
  saveWithTaskTypes,
  taskTypeChoice,
  taskTypeValue,
  type TaskTypesValues,
} from "./task-types";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/use-settings-save", () => ({
  useSettingsSave: () => ({ pending: false, run: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/settings",
  useRouter: () => ({ push: vi.fn() }),
}));

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const STORY_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const ralph: RalphSettingsValues = {
  codingPath: "tasks",
  storyTaskId: STORY_ID,
  requestTaskId: REQUEST_ID,
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
};

const inheritAll: TaskTypesValues = {
  overrides: { query: null, review: null, coding: null },
  inherited: { query: true, review: true, coding: false },
};

/** A connected Linear workspace and the models of two harnesses accepting coding. */
const choices: CodingChoices = {
  linear: {
    status: "connected",
    options: {
      teams: [
        { key: "ENG", name: "Engineering" },
        { key: "OPS", name: "Operations" },
      ],
      labels: ["backend", "manual"],
      projects: ["Omniralph"],
      states: ["In Review", "Done"],
      projectMilestones: [],
      cycles: [],
      users: [],
    },
  },
  models: [
    { value: "opus", displayName: "Opus", harnessIds: ["h1", "h2"] },
    { value: "sonnet", displayName: "Sonnet", harnessIds: ["h1"] },
  ],
  harnessCount: 2,
  pinned: false,
  routingRules: [],
};

/** Coding on for the repository, so the Coding tab shows its settings. */
const codingOn: TaskTypesValues = {
  ...inheritAll,
  overrides: { ...inheritAll.overrides, coding: true },
};

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
    correlationTaskId?: string;
    ralph?: RalphSettingsValues;
    choices?: CodingChoices;
    taskTypes?: TaskTypesValues;
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
          profileId: "standard",
          triggers: { onOpen: true, onPush: true, drafts: false },
          pathExcludes: [],
          customInstructions: "",
          pinnedHarnessIds: overrides.pinnedHarnessIds ?? [],
          reviewTaskIds: ["builtin:review-pr", REVIEW_ID],
          correlationTaskId: overrides.correlationTaskId ?? CORRELATION_ID,
        }}
        reviewTasks={[
          {
            id: "builtin:review-pr",
            name: "Review PR",
            description: "Reviews the change.",
            builtin: true,
          },
          {
            id: REVIEW_ID,
            name: "Security review",
            description: "Looks for holes.",
            builtin: false,
          },
        ]}
        correlationTasks={[
          { id: "builtin:correlate-findings", name: "Correlate findings", builtin: true },
          { id: CORRELATION_ID, name: "Strict correlation", builtin: false },
        ]}
        profiles={[
          {
            id: "standard",
            name: "Standard",
            description: "Balanced.",
            model: "claude-sonnet-4-5",
            maxTokensPerReview: 200000,
            maxFiles: 50,
            allowRepoExploration: true,
          },
        ]}
        harnesses={overrides.harnesses ?? HARNESSES}
        ralph={overrides.ralph ?? ralph}
        codingChoices={overrides.choices ?? choices}
        codingTasks={{
          story: [
            { id: "builtin:implement-story", name: "Implement story", builtin: true },
            { id: STORY_ID, name: "Careful story", builtin: false },
          ],
          request: [
            { id: "builtin:handle-request", name: "Handle request", builtin: true },
            { id: REQUEST_ID, name: "Careful request", builtin: false },
          ],
        }}
        taskTypes={overrides.taskTypes ?? (tab === "coding" ? codingOn : inheritAll)}
      />
    </Wrapper>,
  );
}

/** The markup of the select with `id`. */
function select(html: string, id: string): string {
  const match = new RegExp(`<select[^>]*id="${id}"[^>]*>(.*?)</select>`).exec(html);
  expect(match, id).not.toBeNull();
  return match![1]!;
}

/** The page's visible text, tags dropped. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/** The labels of every tab. */
function allLabels(): string[] {
  return (["settings", "coding", "harnesses"] as const).flatMap((tab) =>
    [...render(tab).matchAll(/<label[^>]*>(.*?)<\/label>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ""),
    ),
  );
}

describe("RepositorySettingsView task pickers", () => {
  it("lists custom review tasks beside the built-ins, checked when enabled", () => {
    const html = render("settings");
    expect(html).toContain("Security review");
    expect(html).toMatch(
      new RegExp(`<button[^>]*aria-checked="true"[^>]*id="review-task-${REVIEW_ID}"`),
    );
    expect(html).toContain("Built-in");
  });

  it("offers a custom correlation task, selected when it is the repository's", () => {
    const options = select(render("settings"), "correlation-task");
    expect(options).toContain(
      '<option value="builtin:correlate-findings">Correlate findings (built-in)</option>',
    );
    expect(options).toContain(
      `<option value="${CORRELATION_ID}" selected="">Strict correlation</option>`,
    );
  });

  it("offers custom story and request tasks on the Coding tab", () => {
    const html = render("coding");
    const story = select(html, "ralph-story-task");
    expect(story).toContain("Implement story (built-in)");
    expect(story).toContain(`<option value="${STORY_ID}" selected="">Careful story</option>`);
    const request = select(html, "ralph-request-task");
    expect(request).toContain("Handle request (built-in)");
    expect(request).toContain(`<option value="${REQUEST_ID}" selected="">Careful request</option>`);
  });

  it("keeps a current task that is no longer offered selectable", () => {
    const gone = "55555555-5555-4555-8555-555555555555";
    const changed = { correlationTaskId: gone, ralph: { ...ralph, storyTaskId: gone } };
    expect(select(render("settings", changed), "correlation-task")).toContain(
      `<option value="${gone}" selected="">`,
    );
    expect(select(render("coding", changed), "ralph-story-task")).toContain(
      `<option value="${gone}" selected="">`,
    );
  });
});

describe("RepositorySettingsView tabs", () => {
  it("shows one section with one save per tab, and the Danger zone apart on Coding", () => {
    const saves = (tab: RepositorySettingsTab) =>
      [...render(tab).matchAll(/<button[^>]*type="submit"[^>]*>(.*?)<\/button>/g)].map((m) =>
        m[1]!.replace(/<[^>]+>/g, ""),
      );
    expect(saves("settings")).toEqual(["Save review settings"]);
    expect(saves("coding")).toEqual(["Save coding", "Save danger zone"]);
    expect(saves("harnesses")).toEqual(["Save harnesses"]);
  });

  it("shows only its own tab's settings", () => {
    const settings = render("settings");
    expect(settings).toContain('id="path-excludes"');
    expect(settings).not.toContain('id="ralph-model"');
    expect(settings).not.toContain("Pinned harnesses");
    const coding = render("coding");
    expect(coding).toContain('id="ralph-model"');
    expect(coding).not.toContain('id="path-excludes"');
    const harnesses = render("harnesses");
    expect(harnesses).toContain("Any harness can run this repository&#x27;s jobs.");
    expect(harnesses).not.toContain('id="path-excludes"');
  });

  it("names the tab in the breadcrumb-free section only for screen readers", () => {
    const html = render("settings");
    expect(html).toMatch(/<h2[^>]*class="sr-only"[^>]*>Review settings<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>When<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Who reviews<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Scope<\/h3>/);
  });

  it("compares review profiles in a radio table", () => {
    const html = render("settings");
    expect(html).toContain('class="settings-profile-table"');
    for (const column of ["Profile", "Model", "Token cap", "Max files", "Exploration"]) {
      expect(html).toMatch(new RegExp(`<th[^>]*>${column}</th>`));
    }
    expect(html).toContain("200,000");
    expect(html).toContain("Explores the repository");
  });

  it("keeps the settings that rewrite history or delete branches in the red Danger zone", () => {
    const html = render("coding");
    const danger = html.slice(html.indexOf('id="danger-zone"'));
    expect(html).toMatch(/id="danger-zone"[^>]*data-tone="danger"/);
    for (const id of ["ralph-history-rewrite", "ralph-cleanup", "ralph-unmerged-timeout"]) {
      expect(danger).toContain(`id="${id}"`);
      expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(html.indexOf('id="danger-zone"'));
    }
  });

  it("labels settings in plain words, not by their config keys", () => {
    const labels = allLabels();
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) expect(label).not.toMatch(/\b[a-z]+[A-Z][a-zA-Z]*\b/);
  });

  it("states each setting's default", () => {
    const settings = render("settings");
    expect(settings).toContain("Default: Off.");
    expect(settings).toContain("Default: Correlate findings.");
    const coding = render("coding");
    expect(coding).toContain("Default: opus.");
    expect(coding).toContain("Default: Legacy jobs.");
  });
});

describe("RepositorySettingsView task types", () => {
  it("offers Use organization default (showing the inherited value), On and Off for each", () => {
    const settings = render("settings");
    const coding = render("coding", { taskTypes: inheritAll });
    expect(select(settings, "task-type-query")).toContain(
      '<option value="inherit" selected="">Use organization default (On)</option>',
    );
    expect(select(settings, "task-type-review")).toContain(
      '<option value="inherit" selected="">Use organization default (On)</option>',
    );
    expect(select(coding, "task-type-coding")).toContain(
      '<option value="inherit" selected="">Use organization default (Off)</option>',
    );
    for (const [html, key] of [
      [settings, "query"],
      [settings, "review"],
      [coding, "coding"],
    ] as const) {
      const options = select(html, `task-type-${key}`);
      expect(options).toContain('<option value="on">On</option>');
      expect(options).toContain('<option value="off">Off</option>');
    }
    expect(settings).toContain(">Query<");
    expect(settings).toContain(">Reviews<");
    expect(coding).toContain(">Coding<");
  });

  it("selects each switch's own value: inherit, on or off", () => {
    for (const [key, tab] of [
      ["query", "settings"],
      ["review", "settings"],
      ["coding", "coding"],
    ] as const) {
      for (const [value, choice] of [
        [null, "inherit"],
        [true, "on"],
        [false, "off"],
      ] as const) {
        const html = render(tab, {
          taskTypes: { ...inheritAll, overrides: { ...inheritAll.overrides, [key]: value } },
        });
        expect(select(html, `task-type-${key}`)).toMatch(
          new RegExp(`<option value="${choice}" selected="">`),
        );
      }
    }
  });

  it("hides the Coding settings while coding is off, keeping them", () => {
    const off = render("coding", { taskTypes: inheritAll });
    expect(off).toContain("Coding is off");
    expect(off).toMatch(/<div hidden="">\s*<section id="coding-routing"/);
    const on = render("coding");
    expect(on).not.toContain("Coding is off");
    expect(on).not.toContain('hidden=""');
  });

  it("says when reviews are off", () => {
    expect(render("settings")).not.toContain("Reviews are off");
    const off = render("settings", {
      taskTypes: { ...inheritAll, overrides: { ...inheritAll.overrides, review: false } },
    });
    expect(off).toContain("Reviews are off");
  });

  it("no longer has a Ralph enable switch", () => {
    const html = render("coding");
    expect(html).not.toContain("Enable Ralph");
    expect(html).not.toContain('id="ralph-enabled"');
  });

  it("calls the coding settings Coding, not Ralph", () => {
    const coding = text(render("coding"));
    for (const title of ["Coding", "Routing", "Agent", "Verification", "Pull requests", "Linear"]) {
      expect(coding).toContain(title);
    }
    for (const tab of ["settings", "coding", "harnesses"] as const) {
      expect(text(render(tab))).not.toMatch(/\bRalph\b/);
    }
  });

  it("maps choices to stored values and back", () => {
    for (const value of [true, false, null]) {
      expect(taskTypeValue(taskTypeChoice(value))).toBe(value);
    }
    expect(taskTypeChoice(null)).toBe("inherit");
    expect(taskTypeValue("on")).toBe(true);
    expect(taskTypeValue("off")).toBe(false);
    expect(inheritLabel(false)).toBe("Use organization default (Off)");
  });
});

describe("RepositorySettingsView Coding pickers", () => {
  const picked: RalphSettingsValues = {
    ...ralph,
    manualLabels: ["manual", "by-hand"],
    model: "opus",
    fallbackModel: "claude-gone-1",
    allowedTools: ["Read", "Bash(pnpm test:*)"],
    epicCompletedState: "In Review",
  };

  /** The markup of the Field around the control with `id`. */
  function field(html: string, id: string): string {
    const start = html.indexOf(`id="${id}"`);
    expect(start, id).toBeGreaterThan(-1);
    // From the label before the control to the next field's label.
    const from = html.lastIndexOf("<label", start);
    const next = html.indexOf("<label", start);
    return html.slice(from, next === -1 ? undefined : next);
  }

  it("lists the routing rules that target the repository, linking to Settings › Routing", () => {
    const html = render("coding", {
      ralph: picked,
      choices: {
        ...choices,
        routingRules: [
          { number: 1, summary: "Labels contains any of backend" },
          { number: 3, summary: "Team is ENG" },
        ],
      },
    });
    const routing = html.slice(
      html.indexOf('id="coding-routing"'),
      html.indexOf('id="coding-agent"'),
    );
    expect(routing).toContain('href="/settings/routing"');
    expect(text(routing)).toMatch(/Rule 1\s*Labels contains any of backend/);
    expect(text(routing)).toMatch(/Rule 3\s*Team is ENG/);
    // The old pickers are gone.
    for (const id of ["ralph-labels", "ralph-projects", "ralph-teams"]) {
      expect(html).not.toContain(`id="${id}"`);
    }
    const none = render("coding", { ralph: picked });
    expect(text(none)).toMatch(/No routing rule targets this repository/);
  });

  it("picks Linear labels as chips, stale ones flagged", () => {
    const html = render("coding", { ralph: picked });
    const manual = field(html, "ralph-manual-labels");
    expect(manual).toContain('role="combobox"');
    expect(text(manual)).toContain("manual");
    expect(text(manual)).toMatch(/“by-hand” is not available/);
    // No comma-separated text boxes left.
    expect(text(html)).not.toMatch(/Comma-separated/);
  });

  it("picks blocked labels from the workspace, never flagging the defaults as stale", () => {
    const html = render("coding", {
      ralph: { ...picked, blockedLabels: ["under-review", "blocked", "on-hold"] },
    });
    const blocked = text(field(html, "ralph-blocked-labels"));
    expect(blocked).toContain("under-review");
    expect(blocked).not.toMatch(/“under-review” is not available/);
    expect(blocked).not.toMatch(/“blocked” is not available/);
    expect(blocked).toMatch(/“on-hold” is not available/);
  });

  it("describes the first manual label as the one Coding adds, in order", () => {
    const html = render("coding", { ralph: { ...picked, manualLabels: ["by-hand", "manual"] } });
    expect(text(html)).toMatch(/The first, “by-hand”, is the label Coding adds/);
    const manual = text(field(html, "ralph-manual-labels"));
    expect(manual.indexOf("by-hand")).toBeLessThan(manual.lastIndexOf("manual"));
  });

  it("offers the epic state as leave alone, started, completed, then the workspace's states", () => {
    const html = render("coding", { ralph: picked });
    const options = [
      ...select(html, "ralph-epic-completed-state").matchAll(/<option[^>]*>([^<]*)</g),
    ].map((m) => m[1]);
    expect(options).toEqual([
      "Leave the epic alone",
      "started: the team&#x27;s first started state",
      "completed: the team&#x27;s first completed state",
      "In Review",
      "Done",
    ]);
    expect(select(html, "ralph-epic-completed-state")).toMatch(
      /<option value="In Review" selected="">/,
    );

    const stale = render("coding", { ralph: { ...picked, epicCompletedState: "Shipped" } });
    expect(select(stale, "ralph-epic-completed-state")).toContain("Shipped (not available)");
    expect(text(stale)).toMatch(/“Shipped” is not available/);
  });

  it("picks the models the harnesses report, the fallback with None", () => {
    const html = render("coding", { ralph: picked });
    const model = field(html, "ralph-model");
    expect(model).toContain('role="combobox"');
    expect(text(model)).toContain("Opus");
    expect(text(model)).toMatch(/from those the harnesses that accept coding report/);
    // The saved fallback no harness reports is kept with a warning.
    expect(text(field(html, "ralph-fallback-model"))).toMatch(/not available/);
    const pinned = render("coding", { ralph: picked, choices: { ...choices, pinned: true } });
    expect(text(field(pinned, "ralph-model"))).toMatch(/the repository.{1,6}s pinned harnesses/);
    const none = render("coding", { ralph: { ...picked, fallbackModel: "" } });
    expect(text(field(none, "ralph-fallback-model"))).toContain("None");
  });

  it("says when no harness can run coding jobs", () => {
    const html = render("coding", {
      ralph: picked,
      choices: { ...choices, models: [], harnessCount: 0 },
    });
    expect(text(html)).toMatch(/No active harness accepts coding jobs/);
  });

  it("enters tools as chips, rules included", () => {
    const html = render("coding", { ralph: picked });
    const tools = text(field(html, "ralph-allowed-tools"));
    expect(tools).toContain("Read");
    expect(tools).toContain("Bash(pnpm test:*)");
    // Rules aren't Claude Code tool names, but they aren't stale either.
    expect(tools).not.toMatch(/not available/);
    expect(html).not.toMatch(/<textarea[^>]*id="ralph-allowed-tools"/);
  });

  it("shows the saved Linear values read-only, linking to Integrations, without Linear", () => {
    for (const linear of [{ status: "disconnected" }, { status: "unavailable" }] as const) {
      const html = render("coding", { ralph: picked, choices: { ...choices, linear } });
      expect(html).toContain('href="/settings/integrations"');
      for (const id of ["ralph-manual-labels", "ralph-blocked-labels"]) {
        expect(field(html, id)).toMatch(new RegExp(`id="${id}"[^>]*disabled=""`));
        expect(text(field(html, id))).not.toMatch(/not available/);
      }
      expect(text(field(html, "ralph-manual-labels"))).toContain("by-hand");
      expect(select(html, "ralph-epic-completed-state")).toContain("In Review");
      expect(html).toMatch(/<select[^>]*id="ralph-epic-completed-state"[^>]*disabled=""/);
    }
    const linked = render("coding", { ralph: picked });
    expect(linked).not.toContain('href="/settings/integrations"');
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

describe("saveWithTaskTypes", () => {
  const saved = { query: null, review: null, coding: null };
  const meta = { organizationId: TEST_ORGANIZATION_ID };
  const TASK_TYPES = "PUT /api/ui/repositories/repo-1/task-types";

  afterEach(() => vi.unstubAllGlobals());

  it("saves only the section's switches, the others as saved, then its settings", async () => {
    const seen = mockFetch({ [TASK_TYPES]: { ok: true } });
    const settingsSave = vi.fn().mockResolvedValue({ ok: true });
    const save = saveWithTaskTypes(
      "repo-1",
      saved,
      { query: false, review: true, coding: true },
      ["coding"],
      settingsSave,
    );
    await save(meta);
    expect(seen.map((r) => r.body)).toEqual([{ query: null, review: null, coding: true }]);
    expect(settingsSave).toHaveBeenCalledWith(meta);
  });

  it("skips unchanged switches, and stops at a failed switch save", async () => {
    const seen = mockFetch({
      [TASK_TYPES]: () =>
        new Response(JSON.stringify({ error: "Nope" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });
    const settingsSave = vi.fn().mockResolvedValue({ ok: true });
    await saveWithTaskTypes("repo-1", saved, saved, ["coding"], settingsSave)(meta);
    expect(seen).toHaveLength(0);
    expect(settingsSave).toHaveBeenCalledTimes(1);

    settingsSave.mockClear();
    await expect(
      saveWithTaskTypes(
        "repo-1",
        saved,
        { ...saved, review: false },
        ["review"],
        settingsSave,
      )(meta),
    ).rejects.toThrow("Nope");
    expect(seen).toHaveLength(1);
    expect(settingsSave).not.toHaveBeenCalled();
  });
});
