"use client";

import { IconX } from "@tabler/icons-react";
import {
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
} from "react";
import { useControlIds } from "./field-context.js";
import { FieldError } from "./field-error.js";

/** Pasted or typed text splits into one token per line or comma. */
const SEPARATORS = /[,\r\n]/;
/** With `splitOnWhitespace`, any whitespace separates tokens too. */
const WHITESPACE_SEPARATORS = /[,\s]/;

/** What a parent can ask of a `TokenInput` (through `handle`). */
export type TokenInputHandle = {
  /**
   * Commits the typed draft as `blur` would and returns the resulting values, or null when
   * part of the draft is invalid (its error shows and it stays in the input).
   */
  commit: () => string[] | null;
};

export type TokenInputProps = {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Returns an error message for a value that can't be added, or null to accept it. */
  validate?: (value: string) => string | null;
  /** Geist Mono for the tokens and the input (paths, globs). Default true. */
  mono?: boolean;
  /**
   * Space and whitespace in pasted text separate tokens too. Off by default: globs and paths
   * can contain spaces.
   */
  splitOnWhitespace?: boolean;
  /** The typed, not yet committed text, when the parent controls it. */
  draft?: string;
  onDraftChange?: (draft: string) => void;
  /** Lets the parent commit the draft (e.g. before submitting the form). */
  handle?: Ref<TokenInputHandle>;
  ref?: Ref<HTMLInputElement>;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type" | "children" | "aria-invalid" | "placeholder"
>;

/**
 * A list of values edited one chip at a time (Design rule 18). Enter or comma adds the
 * typed value, as does leaving the input (Tab or a click elsewhere); pasting lines or
 * comma-separated text adds one token per part; Backspace in the empty input removes the
 * last token. Focus stays in the text input throughout.
 */
export function TokenInput(props: TokenInputProps) {
  const {
    values,
    onChange,
    placeholder,
    validate,
    mono = true,
    splitOnWhitespace = false,
    draft: draftProp,
    onDraftChange,
    handle,
    className,
    id: idProp,
    "aria-describedby": describedByProp,
    ref,
    disabled,
    onKeyDown,
    onPaste,
    onBlur,
    ...rest
  } = props;
  const [ownDraft, setOwnDraft] = useState("");
  const draft = draftProp ?? ownDraft;
  const separators = splitOnWhitespace ? WHITESPACE_SEPARATORS : SEPARATORS;
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

  function setDraft(next: string) {
    if (draftProp === undefined) setOwnDraft(next);
    if (next !== draft) onDraftChange?.(next);
  }

  /**
   * Adds every non-empty, new, valid part of `text`. Returns the parts that failed
   * validation (joined back up) so they stay in the input, and shows the first error.
   */
  function commit(text: string): { values: string[]; rejected: string } {
    const next = [...values];
    const rejected: string[] = [];
    let firstError: string | null = null;
    for (const part of text.split(separators)) {
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
    return { values: next, rejected: rejected.join(", ") };
  }

  /** Commits the whole draft, leaving any rejected parts in the input. */
  function commitDraft(): string[] | null {
    if (draft.trim() === "") return values;
    const { values: next, rejected } = commit(draft);
    setDraft(rejected);
    return rejected === "" ? next : null;
  }

  useImperativeHandle(handle, () => ({ commit: commitDraft }));

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
    setError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" || event.key === "," || (splitOnWhitespace && event.key === " ")) {
      // Enter in an empty input keeps its default (e.g. submitting the form).
      if (event.key === "Enter" && draft.trim() === "") return;
      event.preventDefault();
      commitDraft();
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
    if (!separators.test(text)) return;
    event.preventDefault();
    const { rejected } = commit(text);
    if (rejected !== "") setDraft(rejected);
  }

  /** Leaving the input (Tab, a click elsewhere) commits what was typed. */
  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    onBlur?.(event);
    commitDraft();
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
          onBlur={handleBlur}
        />
      </div>
      {error === null ? null : <FieldError id={ids.errorId}>{error}</FieldError>}
    </>
  );
}
