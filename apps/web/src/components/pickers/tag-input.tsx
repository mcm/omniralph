"use client";

import * as React from "react";
import {
  Command,
  CommandItem,
  CommandList,
  Popover,
  PopoverAnchor,
  PopoverContent,
  cn,
  useFieldControl,
} from "@iamthemcmaster/ui";
import { IconPlus } from "@tabler/icons-react";
import { useActiveOption } from "./use-active-option";
import {
  NOT_AVAILABLE,
  PickerChip,
  StaleNote,
  joinIds,
  matchesQuery,
  useAnnouncer,
} from "./picker-parts";

export interface TagOption {
  value: string;
  /** Shown instead of the value (e.g. a team's name beside its key). */
  label?: string;
  hint?: string;
}

export interface TagInputProps {
  /** The selected values, in order. */
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** The values that may be chosen. Matching ignores case. */
  options: readonly (string | TagOption)[];
  /** Whether Enter adds the typed text when it isn't an option (such values aren't stale). */
  allowCustom?: boolean;
  /** The most values that may be chosen. */
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  /** What the warning under the field says about values that aren't options. */
  staleMessage?: string;
  className?: string;
  id?: string;
  error?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  "aria-required"?: React.AriaAttributes["aria-required"];
}

/** At most this many options are rendered at once; typing narrows the rest. */
export const TAG_INPUT_RENDER_LIMIT = 100;

const CUSTOM_PREFIX = "\u0000custom:";

function normalize(option: string | TagOption): TagOption {
  return typeof option === "string" ? { value: option } : option;
}

const key = (value: string) => value.toLowerCase();

/**
 * An ordered list of values entered as chips: typing filters the options, Enter or a click adds
 * one, Backspace on an empty query removes the last chip. With `allowCustom`, Enter also adds
 * text that isn't an option. A saved value that isn't an option stays as a warning chip until
 * removed, and is never offered. Works inside the library's `Field`.
 */
export function TagInput(props: TagInputProps) {
  const {
    value,
    onChange,
    options,
    allowCustom = false,
    max,
    placeholder,
    disabled = false,
    staleMessage = "Some saved values aren't available any more. They're kept until you remove them.",
    className,
    error,
    ...aria
  } = useFieldControl(props);
  const baseId = React.useId();
  const inputId = aria.id ?? `${baseId}-input`;
  const noteId = `${baseId}-stale`;
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlighted, setHighlighted] = React.useState("");
  const [activeId, listRef] = useActiveOption();
  const [announcer, announce] = useAnnouncer();

  const normalized = React.useMemo(() => options.map(normalize), [options]);
  const optionByKey = React.useMemo(
    () => new Map(normalized.map((option) => [key(option.value), option])),
    [normalized],
  );
  const selectedKeys = React.useMemo(() => new Set(value.map(key)), [value]);
  // With `allowCustom`, values that aren't options were typed on purpose: none is stale.
  const isStale = (item: string) => !allowCustom && !optionByKey.has(key(item));
  const stale = value.filter(isStale);
  const atMax = max !== undefined && value.length >= max;

  const deferredQuery = React.useDeferredValue(query);
  const matches = React.useMemo(
    () =>
      normalized.filter(
        (option) =>
          !selectedKeys.has(key(option.value)) &&
          matchesQuery(deferredQuery, option.value, option.label),
      ),
    [normalized, selectedKeys, deferredQuery],
  );
  const shown = atMax ? [] : matches.slice(0, TAG_INPUT_RENDER_LIMIT);
  const typed = query.trim();
  const customItem =
    allowCustom &&
    !atMax &&
    typed !== "" &&
    !selectedKeys.has(key(typed)) &&
    !optionByKey.has(key(typed))
      ? typed
      : null;
  const itemValues = [
    ...(customItem ? [CUSTOM_PREFIX + customItem] : []),
    ...shown.map((option) => option.value),
  ];
  const active = itemValues.includes(highlighted) ? highlighted : (itemValues[0] ?? "");
  const hasList = itemValues.length > 0 || atMax || typed !== "";
  const listOpen = open && !disabled && hasList;

  const labelOf = (item: string) => {
    const option = optionByKey.get(key(item));
    return option?.label ?? option?.value ?? item;
  };

  const add = (item: string) => {
    if (atMax || selectedKeys.has(key(item))) return;
    const canonical = optionByKey.get(key(item))?.value ?? item;
    onChange([...value, canonical]);
    setQuery("");
    announce(`Added ${labelOf(canonical)}`);
  };

  const remove = (index: number) => {
    const item = value[index];
    if (item === undefined) return;
    onChange(value.filter((_, i) => i !== index));
    announce(`Removed ${labelOf(item)}`);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && query === "" && value.length > 0) {
      event.preventDefault();
      remove(value.length - 1);
    } else if (event.key === "Escape" && listOpen) {
      // Close the list without letting the Escape close a dialog the field sits in.
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      setOpen(true);
    }
  };

  return (
    <div className={cn("picker", className)}>
      <Command
        shouldFilter={false}
        value={active}
        onValueChange={setHighlighted}
        loop
        className="picker-command"
      >
        <Popover open={listOpen} onOpenChange={setOpen}>
          <PopoverAnchor asChild>
            <div
              ref={anchorRef}
              className="picker-field focus-rime-within"
              data-invalid={error || undefined}
              data-disabled={disabled || undefined}
              onClick={(event) => {
                if (event.target === event.currentTarget) inputRef.current?.focus();
              }}
            >
              {value.length > 0 ? (
                <ul className="picker-chips" aria-label="Selected">
                  {value.map((item, index) => (
                    <li key={`${item}-${index}`}>
                      <PickerChip
                        label={labelOf(item)}
                        stale={isStale(item)}
                        disabled={disabled}
                        onRemove={() => {
                          remove(index);
                          inputRef.current?.focus();
                        }}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <input
                ref={inputRef}
                {...aria}
                id={inputId}
                type="text"
                role="combobox"
                className="picker-input"
                aria-autocomplete="list"
                aria-expanded={listOpen}
                aria-controls={listOpen ? `${baseId}-list` : undefined}
                aria-activedescendant={listOpen ? activeId : undefined}
                aria-describedby={joinIds(aria["aria-describedby"], stale.length > 0 && noteId)}
                aria-invalid={aria["aria-invalid"]}
                autoComplete="off"
                spellCheck={false}
                placeholder={value.length === 0 ? placeholder : undefined}
                disabled={disabled}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={onKeyDown}
              />
            </div>
          </PopoverAnchor>
          <PopoverContent
            align="start"
            className="picker-popover"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
            }}
          >
            <CommandList
              ref={listRef}
              id={`${baseId}-list`}
              className="picker-list"
              label={aria["aria-label"] ?? "Options"}
            >
              {customItem ? (
                <CommandItem value={CUSTOM_PREFIX + customItem} onSelect={() => add(customItem)}>
                  <IconPlus size={14} aria-hidden="true" />
                  <span>
                    Add <span className="picker-option-value">{customItem}</span>
                  </span>
                </CommandItem>
              ) : null}
              {shown.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => add(option.value)}
                >
                  <span className="picker-option-label">{option.label ?? option.value}</span>
                  {option.hint || (option.label && !option.label.includes(option.value)) ? (
                    <span className="picker-option-hint">{option.hint ?? option.value}</span>
                  ) : null}
                </CommandItem>
              ))}
              {atMax ? (
                <p className="picker-list-note">
                  Up to {max} {max === 1 ? "value" : "values"}. Remove one to add another.
                </p>
              ) : itemValues.length === 0 ? (
                <p className="picker-list-note">
                  {allowCustom ? "Already added." : "No matching options."}
                </p>
              ) : matches.length > shown.length ? (
                <p className="picker-list-note">
                  Showing {shown.length} of {matches.length}. Type to narrow the list.
                </p>
              ) : null}
            </CommandList>
          </PopoverContent>
        </Popover>
      </Command>
      {stale.length > 0 ? (
        <StaleNote id={noteId}>
          {stale.length === 1
            ? `“${stale[0]}” is ${NOT_AVAILABLE}. `
            : `${stale.length} values are ${NOT_AVAILABLE}. `}
          {staleMessage}
        </StaleNote>
      ) : null}
      {announcer}
    </div>
  );
}
