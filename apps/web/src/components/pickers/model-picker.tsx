"use client";

import * as React from "react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
  useFieldGroupControl,
} from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { NOT_AVAILABLE, StaleNote, joinIds, matchesQuery, useAnnouncer } from "./picker-parts";

/** A model some harnesses report they can run (`listReportedModels` in `@omniralph/db`). */
export interface ModelOption {
  value: string;
  displayName: string;
  /** The harnesses that report it. */
  harnessIds: readonly string[];
}

export interface ModelPickerProps {
  /** The chosen model id; `null` (or "") is none. */
  value: string | null;
  onChange: (value: string | null) => void;
  options: readonly ModelOption[];
  /** How many harnesses the options were gathered from, for "2 of 3 harnesses". */
  harnessCount: number;
  /** Offers a "None" entry, for optional fields such as a fallback model. */
  allowNone?: boolean;
  /** The "None" entry's text (e.g. "Same as the model"). */
  noneLabel?: string;
  placeholder?: string;
  /** What the warning under the field says after "… is not available". */
  staleMessage?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  error?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  "aria-required"?: React.AriaAttributes["aria-required"];
}

const NONE = "\u0000none";

/** "all harnesses" or "2 of 3 harnesses": how widely a model is reported. */
export function harnessCoverage(harnessIds: readonly string[], harnessCount: number): string {
  const count = new Set(harnessIds).size;
  if (harnessCount > 0 && count >= harnessCount) return "all harnesses";
  return `${count} of ${harnessCount} ${harnessCount === 1 ? "harness" : "harnesses"}`;
}

/**
 * Chooses one model from those the harnesses report, each with how many harnesses report it.
 * `allowNone` adds a "None" entry. A saved model no harness reports is shown with a warning and
 * kept until another is chosen; it is never offered. Works inside the library's `Field`.
 */
export function ModelPicker(props: ModelPickerProps) {
  const {
    value,
    onChange,
    options,
    harnessCount,
    allowNone = false,
    noneLabel = "None",
    placeholder = "Choose a model…",
    staleMessage = "No harness reports it. It's kept until you choose another model.",
    disabled = false,
    className,
    error,
    ...aria
  } = useFieldGroupControl(props);
  const baseId = React.useId();
  const valueId = `${baseId}-value`;
  const noteId = `${baseId}-stale`;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [announcer, announce] = useAnnouncer();

  const current = value || null;
  const selected = current === null ? undefined : options.find((o) => o.value === current);
  const stale = current !== null && selected === undefined;
  const shown = options.filter((option) => matchesQuery(query, option.displayName, option.value));
  const showNone = allowNone && matchesQuery(query, noneLabel);

  const choose = (next: string | null) => {
    setOpen(false);
    setQuery("");
    if (next === current) return;
    onChange(next);
    announce(
      next === null
        ? `${noneLabel} selected`
        : `${options.find((o) => o.value === next)?.displayName ?? next} selected`,
    );
  };

  const labelledBy = aria["aria-labelledby"];

  return (
    <div className={cn("picker", className)}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            // PopoverTrigger adds aria-controls (its content's id).
            // eslint-disable-next-line jsx-a11y/role-has-required-aria-props
            role="combobox"
            id={aria.id}
            className="picker-field picker-trigger focus-rime"
            data-invalid={error || undefined}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={aria["aria-label"]}
            aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
            aria-describedby={joinIds(aria["aria-describedby"], stale && noteId)}
            aria-invalid={aria["aria-invalid"]}
            aria-required={aria["aria-required"]}
            disabled={disabled}
          >
            <span
              id={valueId}
              className="picker-trigger-text"
              data-placeholder={(current === null && !allowNone) || undefined}
              data-stale={stale || undefined}
            >
              {stale ? <IconAlertTriangle size={14} aria-hidden="true" /> : null}
              {selected ? (
                selected.displayName
              ) : stale ? (
                <>
                  <span className="picker-option-value">{current}</span>
                  <span className="picker-chip-note">{NOT_AVAILABLE}</span>
                </>
              ) : allowNone ? (
                noneLabel
              ) : (
                placeholder
              )}
            </span>
            <IconChevronDown size={14} aria-hidden="true" className="picker-trigger-icon" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="picker-popover">
          <Command shouldFilter={false} loop label="Search models" className="picker-command">
            <CommandInput placeholder="Search models…" value={query} onValueChange={setQuery} />
            <CommandList className="picker-list" label="Models">
              {showNone ? (
                <CommandItem
                  value={NONE}
                  onSelect={() => choose(null)}
                  data-checked={current === null}
                >
                  <IconCheck size={14} aria-hidden="true" className="picker-check" />
                  <span className="picker-option-label">{noneLabel}</span>
                </CommandItem>
              ) : null}
              {shown.length > 0 ? (
                <CommandGroup aria-label="Reported models">
                  {shown.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.value}
                      onSelect={() => choose(option.value)}
                      data-checked={option.value === current}
                    >
                      <IconCheck size={14} aria-hidden="true" className="picker-check" />
                      <span className="picker-option-label">
                        {option.displayName}
                        {option.value === current ? (
                          <span className="sr-only">, selected</span>
                        ) : null}
                      </span>
                      <span className="picker-option-hint">
                        <span className="picker-option-value">{option.value}</span>
                        {" · "}
                        {harnessCoverage(option.harnessIds, harnessCount)}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {shown.length === 0 && !showNone ? (
                <p className="picker-list-note">
                  {options.length === 0
                    ? "No harness has reported any models yet."
                    : "No matching models."}
                </p>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {stale ? (
        <StaleNote id={noteId}>
          “{current}” is {NOT_AVAILABLE}. {staleMessage}
        </StaleNote>
      ) : null}
      {announcer}
    </div>
  );
}
