"use client";

import { IconX } from "@tabler/icons-react";
import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import { useControlIds } from "./field-context.js";
import { FieldError } from "./field-error.js";

/** Pasted or typed text splits into one token per line or comma. */
const SEPARATORS = /[,\r\n]/;

export type TokenInputProps = {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Returns an error message for a value that can't be added, or null to accept it. */
  validate?: (value: string) => string | null;
  /** Geist Mono for the tokens and the input (paths, globs). Default true. */
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type" | "children" | "aria-invalid" | "placeholder"
>;

/**
 * A list of values edited one chip at a time (Design rule 18). Enter or comma adds the
 * typed value; pasting lines or comma-separated text adds one token per part; Backspace in
 * the empty input removes the last token. Focus stays in the text input throughout.
 */
export function TokenInput(props: TokenInputProps) {
  const {
    values,
    onChange,
    placeholder,
    validate,
    mono = true,
    className,
    id: idProp,
    "aria-describedby": describedByProp,
    ref,
    disabled,
    onKeyDown,
    onPaste,
    ...rest
  } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ids = useControlIds({
    id: idProp,
    describedBy: describedByProp,
    hasError: error !== null,
  });

  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );

  /**
   * Adds every non-empty, new, valid part of `text`. Returns the parts that failed
   * validation (joined back up) so they stay in the input, and shows the first error.
   */
  function commit(text: string): string {
    const next = [...values];
    const rejected: string[] = [];
    let firstError: string | null = null;
    for (const part of text.split(SEPARATORS)) {
      const value = part.trim();
      if (value === "" || next.includes(value)) continue;
      const message = validate?.(value) ?? null;
      if (message !== null) {
        firstError ??= message;
        rejected.push(value);
        continue;
      }
      next.push(value);
    }
    if (next.length !== values.length) onChange(next);
    setError(firstError);
    return rejected.join(", ");
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
    setError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === ",") {
      // Enter in an empty input keeps its default (e.g. submitting the form).
      if (event.key === "Enter" && draft.trim() === "") return;
      event.preventDefault();
      setDraft(commit(draft));
      return;
    }
    if (event.key === "Backspace" && draft === "" && values.length > 0) {
      event.preventDefault();
      remove(values.length - 1);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    onPaste?.(event);
    if (event.defaultPrevented) return;
    const text = event.clipboardData.getData("text");
    if (!SEPARATORS.test(text)) return;
    event.preventDefault();
    const rejected = commit(text);
    if (rejected !== "") setDraft(rejected);
  }

  function handleRemoveClick(index: number) {
    remove(index);
    inputRef.current?.focus();
  }

  /** A click on the box (not a chip button) focuses the text input. */
  function handleBoxMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      inputRef.current?.focus();
    }
  }

  return (
    <>
      <div
        className={["or-tokens", mono && "or-tokens--mono", className].filter(Boolean).join(" ")}
        data-invalid={error === null ? undefined : ""}
        data-disabled={disabled ? "" : undefined}
        onMouseDown={handleBoxMouseDown}
      >
        {values.map((value, index) => (
          <span key={value} className="or-token">
            <span className="or-token__label">{value}</span>
            <button
              type="button"
              className="or-token__remove"
              aria-label={`Remove ${value}`}
              disabled={disabled}
              onClick={() => handleRemoveClick(index)}
            >
              <IconX size={12} stroke={2} aria-hidden />
            </button>
          </span>
        ))}
        <input
          {...rest}
          ref={setRef}
          type="text"
          id={ids.id}
          value={draft}
          placeholder={values.length === 0 ? placeholder : undefined}
          disabled={disabled}
          aria-invalid={ids.invalid}
          aria-describedby={ids.describedBy}
          className="or-tokens__input"
          onChange={(event) => {
            setDraft(event.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
      {error === null ? null : <FieldError id={ids.errorId}>{error}</FieldError>}
    </>
  );
}
