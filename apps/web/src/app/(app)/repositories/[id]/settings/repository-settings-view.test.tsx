import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import { RepositorySettingsView } from "./repository-settings-view";
import type { RalphSettingsValues } from "./ralph-settings-section";
import {
  inheritLabel,
  taskTypeChoice,
  taskTypeValue,
  type TaskTypesValues,
} from "./task-types-card";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/current-user", () => ({ useCurrentUser: () => ({ role: "admin" }) }));
vi.mock("@/components/use-action", () => ({
  useAction: () => ({ pending: false, run: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/settings",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./actions", () => ({
  updateRalphSettings: vi.fn(),
  updateRepositorySettings: vi.fn(),
  updateRepositoryTaskTypes: vi.fn(),
}));
// `ProviderIcon`'s module imports the Repositories page's server actions.
vi.mock("../../actions", () => ({
  connectGitLab: vi.fn(),
  disconnectRepository: vi.fn(),
  removeScmConnection: vi.fn(),
  setRepositoryEnabled: vi.fn(),
  recreateGitLabWebhook: vi.fn(),
}));

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";
const STORY_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

const ralph: RalphSettingsValues = {
  linearTeamKeys: [],
  linearProjectNames: [],
  linearLabels: [],
  codingPath: "tasks",
  storyTaskId: STORY_ID,
  requestTaskId: REQUEST_ID,
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
};

const inheritAll: TaskTypesValues = {
  overrides: { query: null, review: null, coding: null },
  inherited: { query: true, review: true, coding: false },
};

function render(
  overrides: {
    correlationTaskId?: string;
    ralph?: RalphSettingsValues;
    taskTypes?: TaskTypesValues;
  } = {},
) {
  return renderToStaticMarkup(
    <RepositorySettingsView
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
        pinnedHarnessIds: [],
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
        { id: REVIEW_ID, name: "Security review", description: "Looks for holes.", builtin: false },
      ]}
      correlationTasks={[
        { id: "builtin:correlate-findings", name: "Correlate findings", builtin: true },
        { id: CORRELATION_ID, name: "Strict correlation", builtin: false },
      ]}
      profiles={[]}
      agents={[]}
      ralph={overrides.ralph ?? ralph}
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
      taskTypes={overrides.taskTypes ?? inheritAll}
    />,
  );
}

/** The markup of the select with `id`. */
function select(html: string, id: string): string {
  const match = new RegExp(`<select[^>]*id="${id}"[^>]*>(.*?)</select>`).exec(html);
  expect(match, id).not.toBeNull();
  return match![1]!;
}

describe("RepositorySettingsView task pickers", () => {
  it("lists custom review tasks beside the built-ins, checked when enabled", () => {
    const html = render();
    expect(html).toContain("Security review");
    expect(html).toMatch(
      new RegExp(`<button[^>]*aria-checked="true"[^>]*id="review-task-${REVIEW_ID}"`),
    );
    expect(html).toContain("Built-in");
  });

  it("offers a custom correlation task, selected when it is the repository's", () => {
    const options = select(render(), "correlation-task");
    expect(options).toContain(
      '<option value="builtin:correlate-findings">Correlate findings (built-in)</option>',
    );
    expect(options).toContain(
      `<option value="${CORRELATION_ID}" selected="">Strict correlation</option>`,
    );
  });

  it("offers custom story and request tasks in the Ralph section", () => {
    const html = render();
    const story = select(html, "ralph-story-task");
    expect(story).toContain("Implement story (built-in)");
    expect(story).toContain(`<option value="${STORY_ID}" selected="">Careful story</option>`);
    const request = select(html, "ralph-request-task");
    expect(request).toContain("Handle request (built-in)");
    expect(request).toContain(`<option value="${REQUEST_ID}" selected="">Careful request</option>`);
  });

  it("keeps a current task that is no longer offered selectable", () => {
    const gone = "55555555-5555-4555-8555-555555555555";
    const html = render({ correlationTaskId: gone, ralph: { ...ralph, storyTaskId: gone } });
    expect(select(html, "correlation-task")).toContain(`<option value="${gone}" selected="">`);
    expect(select(html, "ralph-story-task")).toContain(`<option value="${gone}" selected="">`);
  });
});

describe("RepositorySettingsView cards", () => {
  it("gives every card its own save action", () => {
    const html = render();
    // Task types, 5 review cards and 6 Ralph cards.
    expect(html.match(/type="submit"/g)).toHaveLength(12);
    expect(html).not.toContain("Save settings");
    expect(html).not.toContain("Save Ralph settings");
  });

  it("labels settings in plain words, not by their config keys", () => {
    const labels = [...render().matchAll(/<label[^>]*>(.*?)<\/label>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, ""),
    );
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) expect(label).not.toMatch(/\b[a-z]+[A-Z][a-zA-Z]*\b/);
  });

  it("states each setting's default", () => {
    const html = render();
    expect(html).toContain("Default: Off.");
    expect(html).toContain("Default: opus.");
    expect(html).toContain("Default: Legacy jobs.");
    expect(html).toContain("Default: Correlate findings.");
  });
});

describe("RepositorySettingsView task types", () => {
  const SWITCHES = ["query", "review", "coding"] as const;

  it("offers Use organization default (showing the inherited value), On and Off for each", () => {
    const html = render();
    expect(select(html, "task-type-query")).toContain(
      '<option value="inherit" selected="">Use organization default (On)</option>',
    );
    expect(select(html, "task-type-review")).toContain(
      '<option value="inherit" selected="">Use organization default (On)</option>',
    );
    expect(select(html, "task-type-coding")).toContain(
      '<option value="inherit" selected="">Use organization default (Off)</option>',
    );
    for (const key of SWITCHES) {
      const options = select(html, `task-type-${key}`);
      expect(options).toContain('<option value="on">On</option>');
      expect(options).toContain('<option value="off">Off</option>');
    }
    expect(html).toContain(">Query<");
    expect(html).toContain(">Reviews<");
    expect(html).toContain(">Coding<");
  });

  it("selects each switch's own value: inherit, on or off", () => {
    for (const key of SWITCHES) {
      for (const [value, choice] of [
        [null, "inherit"],
        [true, "on"],
        [false, "off"],
      ] as const) {
        const html = render({
          taskTypes: { ...inheritAll, overrides: { ...inheritAll.overrides, [key]: value } },
        });
        expect(select(html, `task-type-${key}`)).toMatch(
          new RegExp(`<option value="${choice}" selected="">`),
        );
      }
    }
  });

  it("no longer has a Ralph enable switch", () => {
    const html = render();
    expect(html).not.toContain("Enable Ralph");
    expect(html).not.toContain('id="ralph-enabled"');
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
