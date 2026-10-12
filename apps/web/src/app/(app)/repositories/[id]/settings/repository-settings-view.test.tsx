import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import { RepositorySettingsView } from "./repository-settings-view";
import type { RalphSettingsValues } from "./ralph-settings-section";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/current-user", () => ({ useCurrentUser: () => ({ role: "admin" }) }));
vi.mock("@/components/use-action", () => ({
  useAction: () => ({ pending: false, run: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories/repo-1/settings",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./actions", () => ({ updateRalphSettings: vi.fn(), updateRepositorySettings: vi.fn() }));
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
  ralphEnabled: true,
  linearTeamKeys: [],
  linearProjectNames: [],
  linearLabels: [],
  codingPath: "tasks",
  storyTaskId: STORY_ID,
  requestTaskId: REQUEST_ID,
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
};

function render(overrides: { correlationTaskId?: string; ralph?: RalphSettingsValues } = {}) {
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
