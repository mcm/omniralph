import { describe, expect, it } from "vitest";
import { repositories } from "@omniralph/db";
import { DEFAULT_REVIEW_DEPTH } from "@omniralph/shared";
import { settingChanges } from "./changes";
import {
  REPOSITORY_CARDS,
  REPOSITORY_SECTIONS,
  REPOSITORY_SETTING_DEFAULTS,
  repositoryDraft,
  repositoryInput,
  repositorySpecs,
  repositoryValues,
} from "./forms";

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
  };
  const context = { harnessIds: ["h1", "h2"] };
  const specs = repositorySpecs({
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

  it("names harnesses", () => {
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
    // Null inherits the organization's allowed task types.
    expect(repositories.ralphEnabled.default).toBeUndefined();
  });
});
