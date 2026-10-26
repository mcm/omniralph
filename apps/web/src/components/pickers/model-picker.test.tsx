// @vitest-environment jsdom
import "./test-dom";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Field } from "@iamthemcmaster/ui";
import { describe, expect, it, vi } from "vitest";
import {
  ModelPicker,
  agentCoverage,
  type ModelOption,
  type ModelPickerProps,
} from "./model-picker";

const MODELS: ModelOption[] = [
  { value: "opus", displayName: "Opus", agentIds: ["h1", "h2", "h3"] },
  { value: "sonnet", displayName: "Sonnet", agentIds: ["h1", "h2"] },
  { value: "haiku", displayName: "Haiku", agentIds: ["h3"] },
];

function Agent({
  initial = null,
  onChange,
  ...props
}: Partial<Omit<ModelPickerProps, "value">> & { initial?: string | null }) {
  const [value, setValue] = React.useState(initial);
  return (
    <Field label="Fallback model">
      <ModelPicker
        options={MODELS}
        agentCount={3}
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </Field>
  );
}

const trigger = () => screen.getByRole("combobox", { name: /^Fallback model/ });
const optionTexts = () => screen.getAllByRole("option").map((option) => option.textContent);

describe("agentCoverage", () => {
  it("says “all agents” or how many of them", () => {
    expect(agentCoverage(["h1", "h2", "h3"], 3)).toBe("all agents");
    expect(agentCoverage(["h1", "h2"], 3)).toBe("2 of 3 agents");
    expect(agentCoverage(["h1"], 1)).toBe("all agents");
    expect(agentCoverage([], 1)).toBe("0 of 1 agent");
  });
});

describe("ModelPicker", () => {
  it("names the chosen model and is named by its Field", () => {
    render(<Agent initial="sonnet" />);
    expect(trigger().textContent).toBe("Sonnet");
    expect(trigger().id).toBe(screen.getByText("Fallback model").closest("label")?.htmlFor);
  });

  it("shows how many agents report each model and selects one on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent onChange={onChange} />);
    expect(trigger().textContent).toBe("Choose a model…");

    await user.click(trigger());
    expect(optionTexts()).toEqual([
      "Opusopus · all agents",
      "Sonnetsonnet · 2 of 3 agents",
      "Haikuhaiku · 1 of 3 agents",
    ]);
    await user.click(screen.getByRole("option", { name: /Haiku/ }));
    expect(onChange).toHaveBeenLastCalledWith("haiku");
    expect(trigger().textContent).toBe("Haiku");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Haiku selected", { selector: "[role=status]" })).toBeTruthy();
  });

  it("offers a None entry for optional fields", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent initial="opus" allowNone noneLabel="No fallback" onChange={onChange} />);

    await user.click(trigger());
    expect(optionTexts()[0]).toBe("No fallback");
    await user.click(screen.getByRole("option", { name: "No fallback" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(trigger().textContent).toBe("No fallback");
  });

  it("has no None entry by default", async () => {
    const user = userEvent.setup();
    render(<Agent />);
    await user.click(trigger());
    expect(optionTexts()).toHaveLength(3);
  });

  it("is keyboard-operable: search, arrows and Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent onChange={onChange} />);

    await user.tab();
    expect(document.activeElement).toBe(trigger());
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search models" }));
    await user.keyboard("o");
    expect(optionTexts().map((text) => text?.split("·")[0]?.trim())).toEqual([
      "Opusopus",
      "Sonnetsonnet",
    ]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("sonnet");
    expect(document.activeElement).toBe(trigger());

    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a saved model no agent reports, warns about it, and never offers it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Agent initial="claude-3-opus" onChange={onChange} />);

    expect(trigger().textContent).toContain("claude-3-opus");
    expect(trigger().textContent).toContain("not available");
    const note = screen.getByText(/“claude-3-opus” is not available/);
    expect(trigger().getAttribute("aria-describedby")).toContain(note.closest("p")!.id);

    await user.click(trigger());
    expect(optionTexts().some((text) => text?.includes("claude-3-opus"))).toBe(false);
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: /Opus/ }));
    expect(onChange).toHaveBeenLastCalledWith("opus");
    expect(screen.queryByText(/is not available/)).toBeNull();
  });

  it("says when no agent has reported models", async () => {
    const user = userEvent.setup();
    render(<Agent options={[]} agentCount={0} />);
    await user.click(trigger());
    expect(screen.getByText("No agent has reported any models yet.")).toBeTruthy();
  });
});
