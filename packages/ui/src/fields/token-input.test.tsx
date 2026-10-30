import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Field } from "./field.js";
import { TokenInput, type TokenInputHandle, type TokenInputProps } from "./token-input.js";

function Subject(
  props: Partial<TokenInputProps> & { initial?: string[]; onValues?: (v: string[]) => void },
) {
  const { initial = [], onValues, ...rest } = props;
  const [values, setValues] = useState(initial);
  return (
    <Field label="Paths">
      <TokenInput
        placeholder="Add a path"
        {...rest}
        values={values}
        onChange={(next) => {
          onValues?.(next);
          setValues(next);
        }}
      />
    </Field>
  );
}

const tokens = () =>
  Array.from(document.querySelectorAll(".or-token__label"), (node) => node.textContent);

describe("TokenInput", () => {
  it("renders each value as a chip with a labeled remove button", () => {
    render(<Subject initial={["src/**", "docs/*.md"]} />);
    expect(tokens()).toEqual(["src/**", "docs/*.md"]);
    expect(screen.getByRole("button", { name: "Remove src/**" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove docs/*.md" })).toBeTruthy();
  });

  it("has a text input labeled by the field", () => {
    render(<Subject />);
    const input = screen.getByRole("textbox", { name: "Paths" });
    expect(input.getAttribute("placeholder")).toBe("Add a path");
  });

  it("uses Geist Mono by default, and not when mono is false", () => {
    const { container, unmount } = render(<Subject />);
    expect(container.querySelector(".or-tokens--mono")).toBeTruthy();
    unmount();
    const second = render(<Subject mono={false} />);
    expect(second.container.querySelector(".or-tokens")).toBeTruthy();
    expect(second.container.querySelector(".or-tokens--mono")).toBeNull();
  });

  it("adds the trimmed input on Enter, keeping focus in the input", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(<Subject onValues={onValues} />);
    const input = screen.getByRole("textbox", { name: "Paths" });
    await user.type(input, "  src/**  {Enter}");
    expect(onValues).toHaveBeenLastCalledWith(["src/**"]);
    expect(tokens()).toEqual(["src/**"]);
    expect(input).toHaveProperty("value", "");
    expect(document.activeElement).toBe(input);
  });

  it("adds a token on comma", async () => {
    const user = userEvent.setup();
    render(<Subject />);
    const input = screen.getByRole("textbox");
    await user.type(input, "bug,feature,");
    expect(tokens()).toEqual(["bug", "feature"]);
    expect(input).toHaveProperty("value", "");
  });

  it("does not add an empty value", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(<Subject onValues={onValues} />);
    await user.type(screen.getByRole("textbox"), "   ,{Enter}");
    expect(onValues).not.toHaveBeenCalled();
    expect(tokens()).toEqual([]);
  });

  it("lets Enter in an empty input submit the form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Subject />
      </form>,
    );
    await user.type(screen.getByRole("textbox"), "{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not add a duplicate value", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(<Subject initial={["bug"]} onValues={onValues} />);
    await user.type(screen.getByRole("textbox"), "bug{Enter}");
    expect(onValues).not.toHaveBeenCalled();
    expect(tokens()).toEqual(["bug"]);
  });

  it("adds one token per non-empty line or comma-separated part of pasted text", async () => {
    const user = userEvent.setup();
    render(<Subject initial={["a"]} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.paste("b\n\n c ,a, d\r\ne,");
    expect(tokens()).toEqual(["a", "b", "c", "d", "e"]);
    expect(input).toHaveProperty("value", "");
    expect(document.activeElement).toBe(input);
  });

  it("pastes plain text without separators into the input", async () => {
    const user = userEvent.setup();
    render(<Subject />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.paste("src/**");
    expect(tokens()).toEqual([]);
    expect(input).toHaveProperty("value", "src/**");
  });

  it("removes the last token on Backspace in an empty input, keeping focus", async () => {
    const user = userEvent.setup();
    render(<Subject initial={["a", "b"]} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(tokens()).toEqual(["a"]);
    expect(document.activeElement).toBe(input);
  });

  it("edits the text, not the tokens, on Backspace in a non-empty input", async () => {
    const user = userEvent.setup();
    render(<Subject initial={["a"]} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "bc{Backspace}");
    expect(tokens()).toEqual(["a"]);
    expect(input).toHaveProperty("value", "b");
  });

  it("removes a token with its remove button and returns focus to the input", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    render(<Subject initial={["a", "b", "c"]} onValues={onValues} />);
    await user.click(screen.getByRole("button", { name: "Remove b" }));
    expect(onValues).toHaveBeenLastCalledWith(["a", "c"]);
    expect(tokens()).toEqual(["a", "c"]);
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("shows a validate error linked by aria-describedby and blocks the add", async () => {
    const user = userEvent.setup();
    const onValues = vi.fn();
    const validate = (value: string) => (value.startsWith("/") ? "Use a relative path." : null);
    render(<Subject validate={validate} onValues={onValues} />);
    const input = screen.getByRole("textbox", { name: "Paths" });
    await user.type(input, "/etc{Enter}");
    expect(onValues).not.toHaveBeenCalled();
    expect(tokens()).toEqual([]);
    expect(input).toHaveProperty("value", "/etc");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("textbox", { description: "Use a relative path." })).toBe(input);
    expect(document.activeElement).toBe(input);

    // Editing clears the error; a valid value is added.
    await user.clear(input);
    expect(screen.queryByText("Use a relative path.")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    await user.type(input, "etc{Enter}");
    expect(tokens()).toEqual(["etc"]);
  });

  it("adds the valid parts of a paste and keeps the rejected ones in the input", async () => {
    const user = userEvent.setup();
    const validate = (value: string) => (value.includes(" ") ? "No spaces." : null);
    render(<Subject validate={validate} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.paste("good\nbad one\nfine");
    expect(tokens()).toEqual(["good", "fine"]);
    expect(input).toHaveProperty("value", "bad one");
    expect(screen.getByRole("textbox", { description: "No spaces." })).toBe(input);
  });

  it("adds the typed value on Tab, letting focus move on", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Subject />
        <button type="button">Next</button>
      </>,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "src/**");
    await user.tab();
    expect(tokens()).toEqual(["src/**"]);
    expect(input).toHaveProperty("value", "");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
  });

  it("adds the typed value on blur, and keeps an invalid one in the input with its error", async () => {
    const user = userEvent.setup();
    const validate = (value: string) => (value.startsWith("/") ? "Use a relative path." : null);
    render(
      <>
        <Subject validate={validate} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Paths" });
    await user.type(input, "docs");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(tokens()).toEqual(["docs"]);
    await user.type(input, "/etc");
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(tokens()).toEqual(["docs"]);
    expect(input).toHaveProperty("value", "/etc");
    expect(screen.getByRole("textbox", { description: "Use a relative path." })).toBe(input);
  });

  it("keeps spaces in a value unless splitOnWhitespace is on", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Subject />);
    await user.type(screen.getByRole("textbox"), "my docs/*.md{Enter}");
    expect(tokens()).toEqual(["my docs/*.md"]);
    unmount();

    render(<Subject splitOnWhitespace />);
    const input = screen.getByRole("textbox");
    await user.type(input, "a.io b.io ");
    expect(tokens()).toEqual(["a.io", "b.io"]);
    expect(input).toHaveProperty("value", "");
    await user.paste("c.io\td.io  e.io");
    expect(tokens()).toEqual(["a.io", "b.io", "c.io", "d.io", "e.io"]);
  });

  it("lets the parent control the draft", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    function Controlled() {
      const [draft, setDraft] = useState("seed");
      return (
        <Subject
          draft={draft}
          onDraftChange={(next) => {
            onDraftChange(next);
            setDraft(next);
          }}
        />
      );
    }
    render(<Controlled />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveProperty("value", "seed");
    await user.type(input, "s{Enter}");
    expect(onDraftChange).toHaveBeenNthCalledWith(1, "seeds");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
    expect(tokens()).toEqual(["seeds"]);
  });

  it("commits the draft through its handle, returning the values or null when invalid", async () => {
    const user = userEvent.setup();
    const handle = createRef<TokenInputHandle>();
    const validate = (value: string) => (value.startsWith("/") ? "Use a relative path." : null);
    render(<Subject initial={["a"]} handle={handle} validate={validate} />);
    const input = screen.getByRole("textbox", { name: "Paths" });
    expect(handle.current!.commit()).toEqual(["a"]);

    await user.type(input, "b");
    let committed: string[] | null = null;
    act(() => {
      committed = handle.current!.commit();
    });
    expect(committed).toEqual(["a", "b"]);
    expect(tokens()).toEqual(["a", "b"]);
    expect(input).toHaveProperty("value", "");

    await user.type(input, "/c");
    act(() => {
      committed = handle.current!.commit();
    });
    expect(committed).toBeNull();
    expect(tokens()).toEqual(["a", "b"]);
    expect(input).toHaveProperty("value", "/c");
    expect(screen.getByText("Use a relative path.")).toBeTruthy();
  });

  it("can be named without a Field", () => {
    render(<TokenInput aria-label="Labels" values={[]} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Labels" })).toBeTruthy();
  });

  it("disables the input and remove buttons when disabled", () => {
    render(<Subject initial={["a"]} disabled />);
    expect(screen.getByRole("textbox")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Remove a" })).toHaveProperty("disabled", true);
  });
});
