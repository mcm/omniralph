import { describe, expect, it } from "vitest";
import { repositories } from "@omniralph/db";
import {
  DEFAULT_RALPH_SETTINGS,
  DEFAULT_REVIEW_DEPTH,
  RalphSettingsInput,
  ralphSettingsFormValues,
  type RalphSettingsInput as RalphInput,
} from "@omniralph/shared";
import { settingChanges } from "./changes";
import {
  pickKeys,
  CODING_SECTIONS,
  RALPH_CARDS,
  RALPH_REPOSITORY_DEFAULTS,
  ralphDraft,
  ralphSpecs,
  ralphValues,
  REPOSITORY_CARDS,
  REPOSITORY_SECTIONS,
  REPOSITORY_SETTING_DEFAULTS,
  repositoryDraft,
  repositoryInput,
  repositorySpecs,
  repositoryValues,
  type RalphDraft,
} from "./forms";

const STORY = "33333333-3333-4333-8333-333333333333";

const ralph: RalphInput = {
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
  verifyCommands: ["pnpm test"],
};

const taskNames = new Map([
  ["builtin:implement-story", "Implement story"],
  [STORY, "Careful story"],
]);

/** The change list a Ralph card's confirmation shows after `edit`. */
function ralphCardChanges(card: keyof typeof RALPH_CARDS, edit: Partial<RalphDraft>) {
  const saved = ralphDraft(ralph);
  const specs = ralphSpecs(taskNames);
  return settingChanges(
    RALPH_CARDS[card].map((key) => specs[key]),
    ralphValues(saved),
    ralphValues({ ...saved, ...edit }),
  );
}

describe("Ralph change lists", () => {
  it("lists the story task by name", () => {
    expect(ralphCardChanges("ralph", { storyTaskId: STORY })).toEqual([
      { key: "storyTaskId", label: "Story task", from: "Implement story", to: "Careful story" },
    ]);
  });

  it("lists verify commands one per line", () => {
    expect(
      ralphCardChanges("verification", { verifyCommands: "pnpm test\n\n  pnpm lint  \n" }),
    ).toEqual([
      {
        key: "verifyCommands",
        label: "Verify commands",
        from: "pnpm test",
        to: "pnpm test\npnpm lint",
      },
    ]);
  });

  it("lists the model and a cleared fallback model", () => {
    const saved = { ...ralph, fallbackModel: "sonnet" };
    const specs = ralphSpecs(taskNames);
    expect(
      settingChanges(
        RALPH_CARDS.prompt.map((key) => specs[key]),
        ralphValues(ralphDraft(saved)),
        ralphValues({ ...ralphDraft(saved), model: " claude-opus-5-5 ", fallbackModel: "" }),
      ),
    ).toEqual([
      { key: "model", label: "Model", from: "opus", to: "claude-opus-5-5" },
      { key: "fallbackModel", label: "Fallback model", from: "sonnet", to: "Not set" },
    ]);
  });

  it("ignores edits that save the same values (text trimmed, numbers as typed)", () => {
    expect(ralphCardChanges("prompt", { model: " opus " })).toEqual([]);
    expect(ralphCardChanges("followUp", { maxReviewRounds: "3" })).toEqual([]);
  });

  it("keeps each card's changes to its own settings", () => {
    expect(ralphCardChanges("prompt", { verifyCommands: "pnpm lint" })).toEqual([]);
  });

  it("labels every setting in plain words, never by its config key", () => {
    const specs = ralphSpecs(taskNames);
    for (const spec of Object.values(specs)) {
      expect(spec.label).not.toMatch(/\b[a-z]+[A-Z]/);
    }
  });

  it("saves the saved settings with only the card's changes", () => {
    const saved = ralphDraft(ralph);
    const draft = { ...saved, model: "sonnet", verifyCommands: "pnpm lint" };
    const input = { ...ralphValues(saved), ...pickKeys(ralphValues(draft), RALPH_CARDS.prompt) };
    const parsed = RalphSettingsInput.parse(input);
    expect(parsed.model).toBe("sonnet");
    expect(parsed.verifyCommands).toEqual(["pnpm test"]);
  });

  it("covers every Ralph setting with exactly one card", () => {
    const keys = Object.values(RALPH_CARDS).flat();
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(RalphSettingsInput.shape).sort());
  });

  it("covers every Coding setting with exactly one section, the destructive ones in the Danger zone", () => {
    const keys = Object.values(CODING_SECTIONS).flat();
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(RalphSettingsInput.shape).sort());
    expect([...CODING_SECTIONS.danger].sort()).toEqual([
      "cleanupMergedWorktrees",
      "historyRewrite",
      "unmergedBranchTimeoutMinutes",
    ]);
  });
});

describe("repository sections", () => {
  it("covers every repository setting with exactly one section", () => {
    const keys = Object.values(REPOSITORY_SECTIONS).flat();
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.values(REPOSITORY_CARDS).flat().sort());
  });
});

describe("repository change lists", () => {
  const settings = {
    triggers: { onOpen: true, onPush: true, drafts: false },
    pathExcludes: ["*.snap"],
    customInstructions: "",
    pinnedHarnessIds: ["h1"],
    reviewTaskIds: ["builtin:review-pr"],
    correlationTaskId: "builtin:correlate-findings",
  };
  const context = { reviewTaskIds: ["builtin:review-pr", "t2"], harnessIds: ["h1", "h2"] };
  const specs = repositorySpecs({
    tasks: new Map([
      ["builtin:review-pr", "Review PR"],
      ["t2", "Security review"],
    ]),
    harnesses: new Map([
      ["h1", "build-01"],
      ["h2", "build-02"],
    ]),
  });
  const changes = (card: keyof typeof REPOSITORY_CARDS, edit: object) => {
    const saved = repositoryDraft(settings);
    return settingChanges(
      REPOSITORY_CARDS[card].map((key) => specs[key]),
      repositoryValues(saved, context),
      repositoryValues({ ...saved, ...edit }, context),
    );
  };

  it("names tasks and harnesses", () => {
    expect(changes("tasks", { reviewTaskIds: ["t2", "builtin:review-pr"] })).toEqual([
      {
        key: "reviewTaskIds",
        label: "Review tasks",
        from: "Review PR",
        to: "Review PR, Security review",
      },
    ]);
    expect(changes("pinning", { pinnedHarnessIds: [] })).toEqual([
      {
        key: "pinnedHarnessIds",
        label: "Pinned harnesses",
        from: "build-01",
        to: "Not set (any harness)",
      },
    ]);
  });

  it("lists trigger switches as On/Off", () => {
    expect(changes("triggers", { drafts: true })).toEqual([
      { key: "drafts", label: "Include drafts", from: "Off", to: "On" },
    ]);
  });

  it("doesn't count picking pins in another order or blank exclude lines as changes", () => {
    const saved = repositoryDraft({ ...settings, pinnedHarnessIds: ["h1", "h2"] });
    expect(
      settingChanges(
        REPOSITORY_CARDS.pinning.map((key) => specs[key]),
        repositoryValues(saved, context),
        repositoryValues({ ...saved, pinnedHarnessIds: ["h2", "h1"] }, context),
      ),
    ).toEqual([]);
    expect(changes("files", { pathExcludes: "*.snap\n\n" })).toEqual([]);
  });

  it("nests the trigger switches for the server and keeps the repository's depth", () => {
    const values = repositoryValues(repositoryDraft(settings), context);
    const input = repositoryInput({ ...values, onPush: false }, "deep");
    expect(input.triggers).toEqual({ onOpen: true, onPush: false, drafts: false });
    expect(input.depth).toBe("deep");
  });
});

describe("stated defaults", () => {
  it("match the repository column defaults", () => {
    expect(repositories.reviewDepth.default).toBe(DEFAULT_REVIEW_DEPTH);
    expect(repositories.triggers.default).toEqual(REPOSITORY_SETTING_DEFAULTS.triggers);
    expect(repositories.correlationTaskId.default).toBe(
      REPOSITORY_SETTING_DEFAULTS.correlationTaskId,
    );
    // Null inherits the organization's allowed task types.
    expect(repositories.ralphEnabled.default).toBeUndefined();
    expect(repositories.storyTaskId.default).toBe(RALPH_REPOSITORY_DEFAULTS.storyTaskId);
    expect(repositories.requestTaskId.default).toBe(RALPH_REPOSITORY_DEFAULTS.requestTaskId);
  });
});
