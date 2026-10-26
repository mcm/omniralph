"use client";

import { IconChevronDown } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { ButtonIcon } from "./button.js";
import { Menu, type MenuItem } from "./menu.js";

export interface FilterOption<V extends string = string> {
  value: V;
  label: string;
  /** A Tabler icon, or a mark element (e.g. a repository's code-host `BrandMark`). */
  icon?: ButtonIcon | ReactNode;
  /** A heading the option sits under in the menu (e.g. its organization). */
  group?: string;
}

export interface FilterMenuProps<V extends string = string> {
  /** What the filter filters, e.g. "Kind": the button reads "Kind: All" or the chosen values. */
  label: string;
  options: readonly FilterOption<V>[];
  /** The chosen values; none means All. */
  selected: readonly V[];
  onChange: (selected: V[]) => void;
  /** Lets several values be chosen at once (the menu stays open while toggling them). */
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Chosen values the button spells out before it counts the rest ("Epic, Review +2"). */
const SHOWN_VALUES = 2;

/** The filter's chosen values as the button names them: "All", or their labels. */
export function filterMenuValue<V extends string>(
  options: readonly FilterOption<V>[],
  selected: readonly V[],
): string {
  const chosen = filterMenuChosen(options, selected);
  return chosen.length === 0 ? "All" : chosen.join(", ");
}

/** The labels of the chosen values, in the options' order (unknown values by themselves). */
function filterMenuChosen<V extends string>(
  options: readonly FilterOption<V>[],
  selected: readonly V[],
): string[] {
  const set = new Set<string>(selected);
  const known = options.filter((option) => set.has(option.value));
  const unknown = selected.filter((value) => !options.some((option) => option.value === value));
  return [...known.map((option) => option.label), ...unknown];
}

function isIcon(icon: FilterOption["icon"]): icon is ButtonIcon {
  return (
    typeof icon === "function" || (typeof icon === "object" && icon !== null && "render" in icon)
  );
}

/**
 * A filter button (e.g. Kind, Status or Repo above a list) that opens a `Menu` of "All"
 * and a checkable item per option, grouped when options carry a `group`, and, when
 * `multiple`, a "Clear" item. The button is named "{label}: All" or "{label}: " and the
 * chosen values.
 */
export function FilterMenu<V extends string>({
  label,
  options,
  selected,
  onChange,
  multiple = false,
  disabled = false,
  className,
}: FilterMenuProps<V>) {
  const chosen = filterMenuChosen(options, selected);
  const name = `${label}: ${filterMenuValue(options, selected)}`;
  const shown =
    chosen.length === 0
      ? "All"
      : chosen.length > SHOWN_VALUES
        ? `${chosen.slice(0, SHOWN_VALUES).join(", ")} +${chosen.length - SHOWN_VALUES}`
        : chosen.join(", ");
  const isSelected = new Set<string>(selected);

  const toggle = (value: V) => {
    if (!multiple) return onChange([value]);
    onChange(
      isSelected.has(value)
        ? selected.filter((v) => v !== value)
        : options.map((o) => o.value).filter((v) => v === value || isSelected.has(v)),
    );
  };

  const items: MenuItem[] = [
    { label: "All", checked: selected.length === 0, onSelect: () => onChange([]) },
    ...options.map((option): MenuItem => ({
      label: option.label,
      checked: isSelected.has(option.value),
      group: option.group,
      keepOpen: multiple,
      ...(isIcon(option.icon)
        ? { icon: option.icon }
        : option.icon !== undefined && { mark: option.icon }),
      onSelect: () => toggle(option.value),
    })),
  ];
  if (multiple) {
    items.push("separator", {
      label: "Clear",
      disabled: selected.length === 0,
      onSelect: () => onChange([]),
    });
  }

  return (
    <Menu
      align="start"
      items={items}
      disabled={disabled}
      trigger={
        <button
          type="button"
          className={["or-filter", chosen.length > 0 && "or-filter--active", className]
            .filter(Boolean)
            .join(" ")}
          aria-label={name}
          title={chosen.length > SHOWN_VALUES ? name : undefined}
        >
          <span className="or-filter__label">{label}:</span>
          <span className="or-filter__value">{shown}</span>
          <IconChevronDown
            className="or-filter__chevron"
            size={14}
            stroke={1.75}
            aria-hidden="true"
          />
        </button>
      }
    />
  );
}
