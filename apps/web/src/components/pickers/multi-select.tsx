"use client";

import * as React from "react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  cn,
  useFieldGroupControl,
} from "@iamthemcmaster/ui";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import {
  NOT_AVAILABLE,
  PickerChip,
  StaleNote,
  joinIds,
  matchesQuery,
  useAnnouncer,
} from "./picker-parts";

export interface MultiSelectOption {
  value: string;
  label: string;
  hint?: string;
}

export interface MultiSelectProps {
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** Every option, filtered here as the user types. Give this or `onSearch`. */
  options?: readonly MultiSelectOption[];
  /** Loads the options matching a query (e.g. server-side search). Give this or `options`. */
  onSearch?: (query: string) => Promise<readonly MultiSelectOption[]>;
  /**
   * With `onSearch`, the options for the saved values, so they show by name before any search.
   * A saved value missing here (and from search results) is shown as not available.
   */
  selectedOptions?: readonly MultiSelectOption[];
  /** Past this many selected values the chips collapse to "N selected". */
  maxChips?: number;
  placeholder?: string;
  searchPlaceholder?: string;
  /** The search box's accessible name. */
  searchLabel?: string;
  /** What the warning under the field says about values that aren't options. */
  staleMessage?: string;
  /** Names for values that aren't options (e.g. a revoked agent), shown instead of the value. */
  staleLabels?: ReadonlyMap<string, string>;
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

/** At most this many unselected options are rendered at once; searching narrows the rest. */
export const MULTI_SELECT_RENDER_LIMIT = 100;
/** How long `onSearch` waits after the last keystroke. */
export const MULTI_SELECT_SEARCH_DELAY_MS = 250;

/**
 * Chooses several values from a searchable list, which shows the selected options first. The
 * selection shows as removable chips, or as "N selected" past `maxChips`. Options come from
 * `options` or, for long server-side lists, from `onSearch`. A saved value that isn't an option
 * is kept as a warning chip until removed and is never offered. Works inside the library's
 * `Field`.
 */
export function MultiSelect(props: MultiSelectProps) {
  const {
    value,
    onChange,
    options,
    onSearch,
    selectedOptions,
    maxChips = 3,
    placeholder = "Choose…",
    searchPlaceholder = "Search…",
    searchLabel = "Search options",
    staleMessage = "They're kept until you remove them.",
    staleLabels,
    disabled = false,
    className,
    error,
    ...aria
  } = useFieldGroupControl(props);
  const baseId = React.useId();
  const summaryId = `${baseId}-summary`;
  const noteId = `${baseId}-stale`;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [announcer, announce] = useAnnouncer();
  const search = useSearch(onSearch, open, query);

  const known = React.useMemo(() => {
    const map = new Map<string, MultiSelectOption>(onSearch ? search.seen : []);
    for (const option of options ?? []) map.set(option.value, option);
    for (const option of selectedOptions ?? []) map.set(option.value, option);
    return map;
  }, [options, selectedOptions, search.seen, onSearch]);

  const selected = React.useMemo(() => new Set(value), [value]);
  const stale = value.filter((item) => !known.has(item));
  const chosen = value.flatMap((item) => known.get(item) ?? []);
  const collapsed = chosen.length > maxChips;

  const deferredQuery = React.useDeferredValue(query);
  const unselected = React.useMemo(
    () =>
      (onSearch ? search.results : (options ?? [])).filter(
        (option) =>
          !selected.has(option.value) &&
          (onSearch !== undefined || matchesQuery(deferredQuery, option.label, option.hint)),
      ),
    [onSearch, search.results, options, selected, deferredQuery],
  );
  const shown = unselected.slice(0, MULTI_SELECT_RENDER_LIMIT);
  const selectedMatches = chosen.filter((option) =>
    matchesQuery(deferredQuery, option.label, option.hint),
  );

  const toggle = (option: MultiSelectOption) => {
    if (selected.has(option.value)) {
      onChange(value.filter((item) => item !== option.value));
      announce(`Removed ${option.label}`);
    } else {
      onChange([...value, option.value]);
      announce(`Added ${option.label}`);
    }
  };
  const staleLabel = (item: string) => staleLabels?.get(item) ?? item;
  const remove = (item: string) => {
    onChange(value.filter((other) => other !== item));
    announce(`Removed ${known.get(item)?.label ?? staleLabel(item)}`);
  };

  const summary =
    chosen.length === 0 ? placeholder : collapsed ? `${chosen.length} selected` : "Add…";
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
        <PopoverAnchor asChild>
          <div
            className="picker-field"
            data-invalid={error || undefined}
            data-disabled={disabled || undefined}
          >
            {!collapsed && chosen.length > 0 ? (
              <ul className="picker-chips" aria-label="Selected">
                {chosen.map((option) => (
                  <li key={option.value}>
                    <PickerChip
                      label={option.label}
                      disabled={disabled}
                      onRemove={() => remove(option.value)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {stale.length > 0 ? (
              <ul className="picker-chips" aria-label={`Selected, ${NOT_AVAILABLE}`}>
                {stale.map((item) => (
                  <li key={item}>
                    <PickerChip
                      label={staleLabel(item)}
                      stale
                      disabled={disabled}
                      onRemove={() => remove(item)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <PopoverTrigger asChild>
              <button
                type="button"
                // PopoverTrigger adds aria-controls (its content's id).
                // eslint-disable-next-line jsx-a11y/role-has-required-aria-props
                role="combobox"
                id={aria.id}
                className="picker-trigger focus-rime"
                aria-expanded={open}
                aria-haspopup="listbox"
                aria-label={aria["aria-label"]}
                aria-labelledby={labelledBy ? `${labelledBy} ${summaryId}` : undefined}
                aria-describedby={joinIds(aria["aria-describedby"], stale.length > 0 && noteId)}
                aria-invalid={aria["aria-invalid"]}
                aria-required={aria["aria-required"]}
                disabled={disabled}
              >
                <span
                  id={summaryId}
                  className="picker-trigger-text"
                  data-placeholder={!collapsed || undefined}
                >
                  {summary}
                </span>
                <IconChevronDown size={14} aria-hidden="true" className="picker-trigger-icon" />
              </button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>
        <PopoverContent align="start" className="picker-popover">
          <Command shouldFilter={false} loop label={searchLabel} className="picker-command">
            <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
            <CommandList className="picker-list" label="Options">
              {selectedMatches.length > 0 ? (
                <CommandGroup heading="Selected">
                  {selectedMatches.map((option) => (
                    <MultiSelectItem key={option.value} option={option} checked onToggle={toggle} />
                  ))}
                </CommandGroup>
              ) : null}
              {shown.length > 0 ? (
                <CommandGroup heading={selectedMatches.length > 0 ? "Other options" : "Options"}>
                  {shown.map((option) => (
                    <MultiSelectItem
                      key={option.value}
                      option={option}
                      checked={false}
                      onToggle={toggle}
                    />
                  ))}
                </CommandGroup>
              ) : null}
              {search.loading ? (
                <p className="picker-list-note">
                  <Spinner size="sm" variant="neutral" label="Searching…" />
                  <span aria-hidden="true">Searching…</span>
                </p>
              ) : search.failed ? (
                <p className="picker-list-note" role="alert">
                  Couldn&apos;t load options. Try again.
                </p>
              ) : selectedMatches.length === 0 && shown.length === 0 ? (
                <p className="picker-list-note">No matching options.</p>
              ) : unselected.length > shown.length ? (
                <p className="picker-list-note">
                  Showing {shown.length} of {unselected.length}. Search to narrow the list.
                </p>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {stale.length > 0 ? (
        <StaleNote id={noteId}>
          {stale.length === 1
            ? `“${staleLabel(stale[0] ?? "")}” is ${NOT_AVAILABLE}. `
            : `${stale.length} saved values are ${NOT_AVAILABLE}. `}
          {staleMessage}
        </StaleNote>
      ) : null}
      {announcer}
    </div>
  );
}

function MultiSelectItem({
  option,
  checked,
  onToggle,
}: {
  option: MultiSelectOption;
  checked: boolean;
  onToggle: (option: MultiSelectOption) => void;
}) {
  return (
    <CommandItem value={option.value} onSelect={() => onToggle(option)} data-checked={checked}>
      <IconCheck size={14} aria-hidden="true" className="picker-check" />
      <span className="picker-option-label">
        {option.label}
        {checked ? <span className="sr-only">, selected</span> : null}
      </span>
      {option.hint ? <span className="picker-option-hint">{option.hint}</span> : null}
    </CommandItem>
  );
}

interface SearchState {
  /** The latest query's results. */
  results: readonly MultiSelectOption[];
  /** Every option any search returned, so selected values keep their labels. */
  seen: ReadonlyMap<string, MultiSelectOption>;
  loading: boolean;
  failed: boolean;
}

const NO_SEARCH: SearchState = { results: [], seen: new Map(), loading: false, failed: false };

/** Runs `onSearch` (debounced) while the list is open; the latest query's results win. */
function useSearch(
  onSearch: MultiSelectProps["onSearch"],
  open: boolean,
  query: string,
): SearchState {
  const [state, setState] = React.useState<SearchState>(NO_SEARCH);
  // The query whose results `state` holds; a different one means a search is pending.
  const [settled, setSettled] = React.useState<string | null>(null);
  const request = React.useRef(0);

  React.useEffect(() => {
    if (!onSearch || !open) return;
    const id = ++request.current;
    const timer = setTimeout(() => {
      const done = (update: (current: SearchState) => SearchState) => {
        if (id !== request.current) return;
        setState(update);
        setSettled(query);
      };
      onSearch(query).then(
        (results) =>
          done((current) => {
            const seen = new Map(current.seen);
            for (const option of results) seen.set(option.value, option);
            return { results, seen, loading: false, failed: false };
          }),
        () => done((current) => ({ ...current, results: [], failed: true })),
      );
    }, MULTI_SELECT_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [onSearch, open, query]);

  const loading = onSearch !== undefined && open && settled !== query;
  return { ...state, loading, failed: !loading && state.failed };
}
