import { describe, expect, it } from "vitest";
import { harnesses, repositories } from "@omniralph/db";
import {
  DEFAULT_RALPH_SETTINGS,
  RalphSettingsInput,
  ralphSettingsFormValues,
  type RalphSettingsInput as RalphInput,
} from "@omniralph/shared";
import { settingChanges } from "./changes";
import {
  pickKeys,
  PROFILE_SPECS,
  profileDraft,
  profileValues,
  RALPH_CARDS,
  RALPH_REPOSITORY_DEFAULTS,
  ralphDraft,
  ralphSpecs,
  ralphValues,
  REPOSITORY_CARDS,
  regroupTyped,
  REPOSITORY_SETTING_DEFAULTS,
  repositoryDraft,
  repositoryInput,
  repositorySpecs,
  repositoryValues,
  type RalphDraft,
} from "./forms";

const STORY = "33333333-3333-4333-8333-333333333333";

const ralph: RalphInput = {
  ralphEnabled: false,
  linearTeamKeys: ["ENG"],
  linearProjectNames: [],
  linearLabels: [],
  codingPath: "legacy",
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
  it("lists enabling, the coding path and the story task by name", () => {
    expect(
      ralphCardChanges("ralph", { ralphEnabled: true, codingPath: "tasks", storyTaskId: STORY }),
    ).toEqual([
      { key: "ralphEnabled", label: "Enable Ralph", from: "Off", to: "On" },
      { key: "codingPath", label: "Coding path", from: "Legacy jobs", to: "Coding tasks" },
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

  it("ignores edits that save the same values (spacing, case of team keys)", () => {
    expect(ralphCardChanges("ralph", { linearTeamKeys: " eng ," })).toEqual([]);
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
});

describe("repository change lists", () => {
  const settings = {
    profileId: "standard",
    triggers: { onOpen: true, onPush: true, drafts: false },
    pathExcludes: ["*.snap"],
    customInstructions: "",
    pinnedHarnessIds: ["h1"],
    reviewTaskIds: ["builtin:review-pr"],
    correlationTaskId: "builtin:correlate-findings",
  };
  const context = { reviewTaskIds: ["builtin:review-pr", "t2"], harnessIds: ["h1", "h2"] };
  const specs = repositorySpecs({
    profiles: new Map([
      ["standard", "Standard"],
      ["deep", "Deep"],
    ]),
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

  it("names profiles, tasks and harnesses", () => {
    expect(changes("profile", { profileId: "deep" })).toEqual([
      { key: "profileId", label: "Review profile", from: "Standard", to: "Deep" },
    ]);
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

  it("nests the trigger switches for the server", () => {
    const values = repositoryValues(repositoryDraft(settings), context);
    expect(repositoryInput({ ...values, onPush: false }).triggers).toEqual({
      onOpen: true,
      onPush: false,
      drafts: false,
    });
  });
});

describe("profile change lists", () => {
  it("lists the token cap and model old → new", () => {
    const saved = profileDraft({
      model: "claude-sonnet-5-5",
      maxTokensPerReview: 200_000,
      maxFiles: 40,
      allowRepoExploration: true,
    });
    expect(
      settingChanges(
        PROFILE_SPECS,
        profileValues(saved),
        profileValues({ ...saved, maxTokensPerReview: "150000", allowRepoExploration: false }),
      ),
    ).toEqual([
      { key: "maxTokensPerReview", label: "Token cap per review", from: "200,000", to: "150,000" },
      { key: "allowRepoExploration", label: "Allow repository exploration", from: "On", to: "Off" },
    ]);
  });
});

describe("profile token cap", () => {
  it("shows the cap with separators and reads it back with or without them", () => {
    const saved = profileDraft({
      model: "claude-haiku-5-5",
      maxTokensPerReview: 60_000,
      maxFiles: 15,
      allowRepoExploration: false,
    });
    expect(saved.maxTokensPerReview).toBe("60,000");
    expect(profileValues(saved).maxTokensPerReview).toBe(60_000);
    for (const typed of ["70000", "70,000", "70 000", " 70_000 "]) {
      expect(profileValues({ ...saved, maxTokensPerReview: typed }).maxTokensPerReview).toBe(
        70_000,
      );
    }
    expect(profileValues({ ...saved, maxTokensPerReview: "" }).maxTokensPerReview).toBeNaN();
    expect(profileValues({ ...saved, maxTokensPerReview: "7o,000" }).maxTokensPerReview).toBeNaN();
  });
});

describe("stated defaults", () => {
  it("match the repository column defaults", () => {
    expect(repositories.profileId.default).toBe(REPOSITORY_SETTING_DEFAULTS.profileId);
    expect(repositories.triggers.default).toEqual(REPOSITORY_SETTING_DEFAULTS.triggers);
    expect(repositories.correlationTaskId.default).toBe(
      REPOSITORY_SETTING_DEFAULTS.correlationTaskId,
    );
    expect(repositories.ralphEnabled.default).toBe(RALPH_REPOSITORY_DEFAULTS.ralphEnabled);
    expect(repositories.codingPath.default).toBe(RALPH_REPOSITORY_DEFAULTS.codingPath);
    expect(repositories.storyTaskId.default).toBe(RALPH_REPOSITORY_DEFAULTS.storyTaskId);
    expect(repositories.requestTaskId.default).toBe(RALPH_REPOSITORY_DEFAULTS.requestTaskId);
    expect(harnesses.maxConcurrency.default).toBe(1);
  });
});

describe("regroupTyped", () => {
  it("regroups a typed count and keeps the caret after the same digit", () => {
    // "15000|" + "0" typed at the end.
    expect(regroupTyped("150000", 6)).toEqual({ value: "150,000", caret: 7 });
    // A digit typed after "1" in "1,000": "12|,000".
    expect(regroupTyped("12,000", 2)).toEqual({ value: "12,000", caret: 2 });
    // "1|,000" → "1|0,000" after typing "0" behind the 1.
    expect(regroupTyped("10,000", 2)).toEqual({ value: "10,000", caret: 2 });
    expect(regroupTyped("100,00", 4)).toEqual({ value: "10,000", caret: 4 });
  });

  it("leaves text that isn't a count, and empties an empty one", () => {
    expect(regroupTyped("15k", 3)).toEqual({ value: "15k", caret: 3 });
    expect(regroupTyped("", 0)).toEqual({ value: "", caret: 0 });
    expect(regroupTyped("007", 3)).toEqual({ value: "7", caret: 1 });
  });
});
