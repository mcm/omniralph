import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./field.js";
import { Select, Textarea, TextInput } from "./text-input.js";

describe.each([
  ["TextInput", "textbox", TextInput],
  ["Textarea", "textbox", Textarea],
] as const)("%s", (_name, role, Control) => {
  it("is named by its label", () => {
    render(
      <>
        <label htmlFor="c">Prompt</label>
        <Control id="c" />
      </>,
    );
    expect(screen.getByRole(role, { name: "Prompt" })).toBeTruthy();
  });

  it("is not invalid by default", () => {
    render(<Control aria-label="Prompt" />);
    const control = screen.getByRole(role);
    expect(control.hasAttribute("aria-invalid")).toBe(false);
    expect(control.hasAttribute("aria-describedby")).toBe(false);
    expect(control.className).toContain("or-input");
  });

  it("sets aria-invalid when invalid", () => {
    render(<Control aria-label="Prompt" invalid />);
    expect(screen.getByRole(role).getAttribute("aria-invalid")).toBe("true");
  });

  it("links the error message by aria-describedby", () => {
    render(
      <Field label="Prompt" description="Sent to Om first.">
        <Control errorMessage="Write a prompt." aria-describedby="extra" />
        <span id="extra">Markdown works.</span>
      </Field>,
    );
    const control = screen.getByRole(role, {
      name: "Prompt",
      description: "Sent to Om first. Write a prompt. Markdown works.",
    });
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Write a prompt.").className).toBe("or-field-error");
  });

  it("uses Geist Mono when mono", () => {
    render(<Control aria-label="Path" mono />);
    expect(screen.getByRole(role).className).toContain("or-input--mono");
  });
});

describe("TextInput", () => {
  it("defaults to type text and passes other types through", () => {
    render(
      <>
        <TextInput aria-label="Name" />
        <TextInput aria-label="Email" type="email" />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("type", "text");
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveProperty("type", "email");
  });
});

describe("Select", () => {
  const options = (
    <>
      <option value="main">main</option>
      <option value="develop">develop</option>
    </>
  );

  it("is a native select named by its field label", () => {
    render(
      <Field label="Default branch">
        <Select defaultValue="develop">{options}</Select>
      </Field>,
    );
    const select = screen.getByRole("combobox", { name: "Default branch" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveProperty("value", "develop");
    expect(select.className).toContain("or-select__control");
  });

  it("sets aria-invalid and links the error message", () => {
    render(
      <Select aria-label="Default branch" errorMessage="Branch not found.">
        {options}
      </Select>,
    );
    const select = screen.getByRole("combobox", {
      name: "Default branch",
      description: "Branch not found.",
    });
    expect(select.getAttribute("aria-invalid")).toBe("true");
  });

  it("can be marked invalid without a message", () => {
    render(
      <Select aria-label="Default branch" invalid>
        {options}
      </Select>,
    );
    const select = screen.getByRole("combobox");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.hasAttribute("aria-describedby")).toBe(false);
  });
});
