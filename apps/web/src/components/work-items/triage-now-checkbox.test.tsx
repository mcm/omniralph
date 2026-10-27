// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as workItems from "./triage-now-checkbox";
import { TRIAGE_NOW_DESCRIPTION, TriageNowCheckbox } from "./triage-now-checkbox";

afterEach(cleanup);

describe("TriageNowCheckbox", () => {
  it("is exported for reuse (Ask's Add to backlog)", () => {
    expect(workItems.TriageNowCheckbox).toBeTypeOf("function");
  });

  it('renders the Checkbox labeled "Triage now", described by what it does', () => {
    render(<TriageNowCheckbox checked onChange={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "Triage now" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(TRIAGE_NOW_DESCRIPTION).toBe("Om turns it into a PRD and sizes it.");
    const description = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(TRIAGE_NOW_DESCRIPTION);
    expect(box.closest(".or-checkbox")).not.toBeNull();
  });

  it("reports changes with onChange and follows checked", async () => {
    const onChange = vi.fn();
    function Controlled() {
      const [checked, setChecked] = useState(true);
      return (
        <TriageNowCheckbox
          checked={checked}
          onChange={(next) => {
            onChange(next);
            setChecked(next);
          }}
        />
      );
    }
    render(<Controlled />);
    const box = screen.getByRole("checkbox", { name: "Triage now" }) as HTMLInputElement;
    await userEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(box.checked).toBe(false);
    await userEvent.click(screen.getByText("Triage now"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(box.checked).toBe(true);
  });

  it("can be disabled", async () => {
    const onChange = vi.fn();
    render(<TriageNowCheckbox checked={false} onChange={onChange} disabled />);
    const box = screen.getByRole("checkbox", { name: "Triage now" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    await userEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });
});
