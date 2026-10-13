// @vitest-environment jsdom
import "./pickers/test-dom";
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SettingChange } from "@/lib/settings/changes";
import type { SettingsSave } from "./settings-card";
import { sectionStatus, SettingsSection, SettingsSubsection } from "./settings-section";

const run = vi.fn(
  (action: () => unknown, _success: string, onSuccess?: () => void) => {
    action();
    onSuccess?.();
  },
);
vi.mock("./use-action", () => ({ useAction: () => ({ pending: false, run }) }));

const CHANGE: SettingChange = { key: "model", label: "Model", from: "opus", to: "sonnet" };

function Section({
  changes = [],
  prepare = () => ({ action: vi.fn(), success: "Saved" }) as unknown as SettingsSave,
  onDiscard = vi.fn(),
  confirm,
  readOnly,
  invalid = false,
}: {
  changes?: SettingChange[];
  prepare?: () => SettingsSave | null;
  onDiscard?: () => void;
  confirm?: { consequence: string };
  readOnly?: boolean;
  invalid?: boolean;
}) {
  return (
    <SettingsSection
      id="coding"
      title="Coding"
      showTitle={false}
      description="How issues are built."
      changes={changes}
      prepare={prepare}
      onDiscard={onDiscard}
      confirm={confirm}
      readOnly={readOnly}
    >
      <SettingsSubsection id="coding-agent" title="Agent" description="Which model.">
        <label htmlFor="model">Model</label>
        <input id="model" aria-invalid={invalid} />
      </SettingsSubsection>
    </SettingsSection>
  );
}

describe("sectionStatus", () => {
  it("counts unsaved changes and fields that need attention", () => {
    expect(sectionStatus({ changes: 0, invalid: 0, saved: false })).toBe("No unsaved changes");
    expect(sectionStatus({ changes: 0, invalid: 0, saved: true })).toBe("Saved");
    expect(sectionStatus({ changes: 1, invalid: 0, saved: false })).toBe("1 unsaved change");
    expect(sectionStatus({ changes: 3, invalid: 0, saved: false })).toBe("3 unsaved changes");
    expect(sectionStatus({ changes: 3, invalid: 1, saved: false })).toBe("1 field needs attention");
    expect(sectionStatus({ changes: 3, invalid: 2, saved: false })).toBe(
      "2 fields need attention",
    );
  });
});

describe("SettingsSection", () => {
  it("names itself for screen readers and keeps Save disabled while clean", () => {
    render(<Section />);
    expect(screen.getByRole("heading", { level: 2, name: "Coding" })).toHaveProperty(
      "className",
      "sr-only",
    );
    expect(screen.getByRole("heading", { level: 3, name: "Agent" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No unsaved changes");
    expect(screen.getByRole("button", { name: "Save coding" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("saves its changes with one button and says it saved", async () => {
    const prepare = vi.fn(() => ({ action: vi.fn(), success: "Saved" }) as unknown as SettingsSave);
    const { rerender } = render(<Section changes={[CHANGE]} prepare={prepare} />);
    expect(screen.getByRole("status").textContent).toBe("1 unsaved change");
    await userEvent.click(screen.getByRole("button", { name: "Save coding" }));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalled();
    rerender(<Section changes={[]} prepare={prepare} />);
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("discards its changes", async () => {
    const onDiscard = vi.fn();
    render(<Section changes={[CHANGE]} onDiscard={onDiscard} />);
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("counts the fields that need attention and focuses the first", async () => {
    render(<Section changes={[CHANGE]} prepare={() => null} invalid />);
    await userEvent.click(screen.getByRole("button", { name: "Save coding" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("1 field needs attention"),
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Model"));
  });

  it("lists the changes in a confirmation before saving", async () => {
    run.mockClear();
    render(<Section changes={[CHANGE]} confirm={{ consequence: "Runs pick it up." }} />);
    await userEvent.click(screen.getByRole("button", { name: "Save coding" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Save coding?");
    expect(dialog.textContent).toContain("Runs pick it up.");
    expect(dialog.textContent).toContain("opus");
    expect(run).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("has no save footer when read-only", () => {
    render(<Section changes={[CHANGE]} readOnly />);
    expect(screen.queryByRole("button", { name: "Save coding" })).toBeNull();
  });
});
