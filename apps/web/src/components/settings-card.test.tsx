import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingChangeList, SettingsCard } from "./settings-card";

vi.mock("./use-settings-save", () => ({
  useSettingsSave: () => ({ pending: false, run: vi.fn() }),
}));

const change = { key: "model", label: "Model", from: "opus", to: "sonnet" };

function render(changes: (typeof change)[], readOnly = false) {
  return renderToStaticMarkup(
    <SettingsCard
      title="Coding › Prompt and model"
      description="What the sessions are told."
      changes={changes}
      prepare={() => null}
      onDiscard={vi.fn()}
      readOnly={readOnly}
      confirm={{ consequence: "Runs pick it up." }}
    >
      <input id="model" />
    </SettingsCard>,
  );
}

describe("SettingsCard", () => {
  it("disables Save and hides Discard while the card has no unsaved changes", () => {
    const html = render([]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    expect(html).not.toContain("Discard");
    expect(html).not.toContain("Unsaved changes");
  });

  it("shows Discard, an unsaved badge and an enabled Save once it has changes", () => {
    const html = render([change]);
    expect(html).toContain("Discard");
    expect(html).toContain("Unsaved changes");
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
  });

  it("has no save actions for people who can't change the settings", () => {
    const html = render([change], true);
    expect(html).not.toContain("Discard");
    expect(html).not.toMatch(/type="submit"/);
  });
});

describe("SettingChangeList", () => {
  it("lists each changed setting old → new", () => {
    const html = renderToStaticMarkup(
      <SettingChangeList
        changes={[
          change,
          { key: "verifyCommands", label: "Verify commands", from: "Not set", to: "pnpm test" },
        ]}
      />,
    );
    expect(html).toContain('<dt class="settings-change-label">Model</dt>');
    expect(html).toMatch(/From <\/span>opus<\/span>.*→.*to <\/span>sonnet<\/span>/);
    expect(html).toContain("Verify commands");
    expect(html).toMatch(/From <\/span>Not set<\/span>.*to <\/span>pnpm test<\/span>/);
  });
});

describe("SettingsCard anchor", () => {
  it("gives the card an id the unsaved-changes bar links to", () => {
    expect(render([change])).toContain('id="settings-coding-prompt-and-model"');
  });
});
