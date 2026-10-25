import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./field.js";
import { Select, TextInput } from "./text-input.js";
import { TokenInput } from "./token-input.js";

describe("Field", () => {
  it("labels its control with a <label for> the control's id", () => {
    render(
      <Field label="Branch prefix">
        <TextInput />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Branch prefix" });
    const label = screen.getByText("Branch prefix");
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.id).not.toBe("");
  });

  it("uses htmlFor as the control's id", () => {
    render(
      <Field label="Default branch" htmlFor="default-branch">
        <Select>
          <option>main</option>
        </Select>
      </Field>,
    );
    expect(screen.getByRole("combobox", { name: "Default branch" }).id).toBe("default-branch");
  });

  it("links the description to the control", () => {
    render(
      <Field label="Concurrency" description="How many runs an agent takes at once.">
        <TextInput />
      </Field>,
    );
    const input = screen.getByRole("textbox", {
      name: "Concurrency",
      description: "How many runs an agent takes at once.",
    });
    const description = document.getElementById(input.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe("How many runs an agent takes at once.");
  });

  it("names the token input's text input", () => {
    render(
      <Field label="Watched paths">
        <TokenInput values={["src/**"]} onChange={() => {}} />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Watched paths" })).toBeTruthy();
  });

  it("lays out label, description and control in field slots", () => {
    const { container } = render(
      <Field label="Name" description="Shown in the sidebar." className="extra">
        <TextInput />
      </Field>,
    );
    const field = container.firstElementChild!;
    expect(field.className).toBe("or-field extra");
    expect(field.querySelector(".or-field__head .or-field__label")).toBeTruthy();
    expect(field.querySelector(".or-field__head .or-field__description")).toBeTruthy();
    expect(field.querySelector(".or-field__control input")).toBeTruthy();
  });

  it("adds the stacked modifier when stacked", () => {
    const { container } = render(
      <Field label="Email" stacked>
        <TextInput />
      </Field>,
    );
    expect(container.firstElementChild!.className).toBe("or-field or-field--stacked");
  });
});
