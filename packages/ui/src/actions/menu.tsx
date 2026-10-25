"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { IconCheck } from "@tabler/icons-react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { useLinkComponent } from "../provider/index.js";
import type { ButtonIcon } from "./button.js";

interface MenuItemBase {
  label: string;
  icon?: ButtonIcon;
  /**
   * Destructive items always render last, after a separator, in the coral danger style
   * (Design rule 5). Their `onSelect` should ask to confirm (e.g. open a `ConfirmDialog`).
   */
  destructive?: boolean;
  disabled?: boolean;
  /**
   * Makes the item a checkable choice (`menuitemcheckbox`) with a check after its label
   * when `true`, e.g. the current organization in a picker. Omit for a plain action.
   */
  checked?: boolean;
}

/** A menu action: runs `onSelect`, or navigates to `href` through the `UiProvider` link. */
export type MenuAction = MenuItemBase &
  ({ onSelect: () => void; href?: undefined } | { href: string; onSelect?: () => void });

export type MenuItem = MenuAction | "separator";

/**
 * Orders menu items for display: the non-destructive items in their given order, then a
 * separator and every destructive item. Leading, trailing and doubled separators are dropped.
 */
export function orderMenuItems(items: readonly MenuItem[]): MenuItem[] {
  const regular = items.filter((item) => item === "separator" || !item.destructive);
  const destructive = items.filter(
    (item): item is MenuAction => item !== "separator" && item.destructive === true,
  );
  const ordered: MenuItem[] = [...regular];
  if (destructive.length > 0) ordered.push("separator", ...destructive);
  return ordered.filter(
    (item, index) =>
      item !== "separator" ||
      (index > 0 && index < ordered.length - 1 && ordered[index - 1] !== "separator"),
  );
}

export interface MenuProps {
  items: readonly MenuItem[];
  /** The element that opens the menu (e.g. an `IconButton`); it receives the trigger props. */
  trigger: ReactElement;
  /** Which edge of the trigger the menu aligns to. Defaults to `end`. */
  align?: "start" | "center" | "end";
  /** Disables the trigger. */
  disabled?: boolean;
  /**
   * Content above the items, after which a separator follows: e.g. who is signed in and a
   * control such as `ThemeControl`. Its controls keep their own keys; Tab and Shift+Tab move
   * between them and the items.
   */
  header?: ReactNode;
}

const TABBABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]";

/**
 * Tab inside a menu with a header: Radix keeps focus on the items, so cycle between the
 * header's tab stops and the items (as one stop, the first enabled item).
 */
function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Tab") return;
  const content = event.currentTarget;
  const header = content.querySelector<HTMLElement>(".or-menu__header");
  if (!header) return;
  // Stops Radix's own Tab handling for this event too.
  event.preventDefault();
  const firstItem = content.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])');
  // Roving groups (e.g. a segmented control) keep one stop; the rest have tabindex -1.
  const stops = [...header.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0,
  );
  if (firstItem) stops.push(firstItem);
  if (stops.length === 0) return;
  const target = event.target as HTMLElement;
  const current = header.contains(target)
    ? stops.findIndex((stop) => stop.contains(target))
    : stops.length - 1;
  const step = event.shiftKey ? -1 : 1;
  const next = (current + step + stops.length) % stops.length;
  stops[next]!.focus();
}

/** Keeps keys pressed in the header from reaching the menu's typeahead (Escape still closes). */
function onHeaderKey(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
}

/** A dropdown of actions, opened from `trigger`. Destructive items always come last. */
export function Menu({ items, trigger, align = "end", disabled = false, header }: MenuProps) {
  const LinkComponent = useLinkComponent();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="or-root or-menu"
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onKeyDown={header !== undefined ? onTabKey : undefined}
        >
          {header !== undefined ? (
            <>
              <div className="or-menu__header" onKeyDown={onHeaderKey}>
                {header}
              </div>
              {items.length > 0 ? <DropdownMenu.Separator className="or-menu__separator" /> : null}
            </>
          ) : null}
          {orderMenuItems(items).map((item, index) => {
            if (item === "separator") {
              return (
                <DropdownMenu.Separator key={`separator-${index}`} className="or-menu__separator" />
              );
            }
            const {
              label,
              icon: Icon,
              destructive,
              disabled: itemDisabled,
              checked,
              href,
              onSelect,
            } = item;
            const className = destructive ? "or-menu__item or-menu__item--danger" : "or-menu__item";
            const content = (
              <>
                {Icon ? (
                  <Icon className="or-menu__icon" size={16} stroke={1.75} aria-hidden="true" />
                ) : null}
                <span className="or-menu__label">{label}</span>
                {checked !== undefined ? (
                  <DropdownMenu.ItemIndicator className="or-menu__check">
                    <IconCheck size={16} stroke={2} aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                ) : null}
              </>
            );
            const itemProps = {
              className,
              disabled: itemDisabled,
              onSelect: onSelect ? () => onSelect() : undefined,
              asChild: href !== undefined,
              children:
                href !== undefined ? <LinkComponent href={href}>{content}</LinkComponent> : content,
            };
            return checked !== undefined ? (
              <DropdownMenu.CheckboxItem
                key={`${label}-${index}`}
                checked={checked}
                {...itemProps}
              />
            ) : (
              <DropdownMenu.Item key={`${label}-${index}`} {...itemProps} />
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
