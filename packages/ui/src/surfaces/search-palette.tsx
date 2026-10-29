"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { StatusDot, type StatusTone } from "../status/status.js";
import { Scrim } from "./scrim.js";

/** One result: a `ListRow`'s look (a status dot and kind line, or a mark), as a listbox option. */
export type SearchPaletteItem = {
  /** Unique within the palette. */
  id: string;
  /** The result's name; it names the option along with its badges. */
  title: ReactNode;
  /** Reference badges under the title. */
  meta?: ReactNode;
} & (
  | { kindLabel: string; tone: StatusTone; mark?: never }
  | { mark: ReactNode; kindLabel?: never; tone?: never }
);

export interface SearchPaletteGroup<T extends SearchPaletteItem = SearchPaletteItem> {
  id: string;
  /** The group's heading, e.g. "Runs"; it names the group. */
  label: string;
  items: readonly T[];
}

export interface SearchPaletteProps<T extends SearchPaletteItem = SearchPaletteItem> {
  /** Whether the palette is open (controlled). */
  open: boolean;
  /** Called with `false` on Escape, the "Close" button or a scrim click. */
  onOpenChange: (open: boolean) => void;
  /** What's typed (controlled). */
  query: string;
  onQueryChange: (query: string) => void;
  /** The results, grouped; groups without items are left out. */
  groups: readonly SearchPaletteGroup<T>[];
  /** Called with the result chosen by a click, a tap or Enter. */
  onSelect: (item: T) => void;
  /**
   * Shown in place of the results while there are none, e.g. "No matches for “x”". It is
   * announced to screen readers.
   */
  message?: ReactNode;
  /** The input's accessible name and placeholder. Defaults to "Search or jump to…". */
  label?: string;
  /** Results are loading (`aria-busy` on the list). */
  busy?: boolean;
}

/**
 * Search and jump: a centered dialog (full screen at 768 px and narrower, the input pinned
 * at the top) with one input and the results grouped under headings. The input is an ARIA
 * combobox over the results' listbox: focus stays in the input, ↑ and ↓ move the
 * highlighted result (`aria-activedescendant`, announced by screen readers), Enter or a
 * click chooses it, and Escape closes the dialog. It shows no keyboard hints.
 */
export function SearchPalette<T extends SearchPaletteItem>({
  open,
  onOpenChange,
  query,
  onQueryChange,
  groups,
  onSelect,
  message,
  label = "Search or jump to…",
  busy = false,
}: SearchPaletteProps<T>) {
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const shown = groups.filter((group) => group.items.length > 0);
  const items = shown.flatMap((group) => group.items);
  const [active, setActive] = useState(0);
  // A new list highlights its first result.
  const [itemsKey, setItemsKey] = useState("");
  const key = items.map((item) => item.id).join("\n");
  if (key !== itemsKey) {
    setItemsKey(key);
    setActive(0);
  }
  const current = items.length > 0 ? Math.min(active, items.length - 1) : -1;
  const listRef = useRef<HTMLDivElement>(null);
  // Remember who opened it: Radix has no trigger to refocus on close.
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (current < 0) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current < 0 ? 0 : current + step + items.length) % items.length);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(Math.max(0, items.length - 1));
    } else if (event.key === "Enter") {
      // While an IME composes, Enter commits the text.
      if (event.nativeEvent.isComposing) return;
      const item = items[current];
      if (!item) return;
      event.preventDefault();
      onSelect(item);
    }
  }

  let index = 0;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Scrim className="or-palette__scrim" />
        <Dialog.Content
          className="or-root or-palette"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            const focused = document.activeElement;
            opener.current = focused instanceof HTMLElement ? focused : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = opener.current;
            opener.current = null;
            if (target?.isConnected) target.focus();
          }}
        >
          <Dialog.Title className="or-sr-only">{label}</Dialog.Title>
          <div className="or-palette__head">
            <IconSearch className="or-palette__icon" size={18} stroke={1.75} aria-hidden="true" />
            <input
              className="or-palette__input"
              type="text"
              role="combobox"
              aria-label={label}
              aria-expanded={items.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current >= 0 ? optionId(current) : undefined}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder={label}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <Dialog.Close
              className="or-icon-btn or-icon-btn--ghost or-icon-btn--md or-palette__close"
              aria-label="Close"
            >
              <IconX size={18} stroke={1.75} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div
            ref={listRef}
            id={listId}
            className="or-palette__list"
            role="listbox"
            aria-label={label}
            aria-busy={busy || undefined}
          >
            {shown.map((group) => {
              const headingId = `${listId}-group-${group.id}`;
              return (
                <ul
                  key={group.id}
                  className="or-rows or-palette__group"
                  role="group"
                  aria-labelledby={headingId}
                >
                  <li id={headingId} className="or-palette__heading" role="presentation">
                    {group.label}
                  </li>
                  {group.items.map((item) => {
                    const position = index++;
                    const selected = position === current;
                    return (
                      <li
                        key={item.id}
                        id={optionId(position)}
                        data-index={position}
                        className="or-row or-palette__option"
                        role="option"
                        aria-selected={selected}
                        // Keep focus in the input: a press only chooses.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => {
                          if (!selected) setActive(position);
                        }}
                        onClick={() => onSelect(item)}
                      >
                        {item.kindLabel !== undefined ? (
                          <StatusDot
                            className="or-row__dot"
                            tone={item.tone}
                            label={item.kindLabel}
                          />
                        ) : (
                          <span className="or-row__mark">{item.mark}</span>
                        )}
                        <div className="or-row__main">
                          {item.kindLabel !== undefined ? (
                            <span className="or-row__kind" aria-hidden="true">
                              {item.kindLabel}
                            </span>
                          ) : null}
                          <span className="or-row__title">{item.title}</span>
                          {item.meta !== undefined ? (
                            <div className="or-row__meta">{item.meta}</div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              );
            })}
          </div>
          <div className="or-palette__message" role="status">
            {items.length === 0 ? message : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
