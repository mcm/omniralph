"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactElement } from "react";
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
}

/** A dropdown of actions, opened from `trigger`. Destructive items always come last. */
export function Menu({ items, trigger, align = "end", disabled = false }: MenuProps) {
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
        >
          {orderMenuItems(items).map((item, index) => {
            if (item === "separator") {
              return (
                <DropdownMenu.Separator key={`separator-${index}`} className="or-menu__separator" />
              );
            }
            const { label, icon: Icon, destructive, disabled: itemDisabled, href, onSelect } = item;
            const className = destructive ? "or-menu__item or-menu__item--danger" : "or-menu__item";
            const content = (
              <>
                {Icon ? (
                  <Icon className="or-menu__icon" size={16} stroke={1.75} aria-hidden="true" />
                ) : null}
                <span className="or-menu__label">{label}</span>
              </>
            );
            return (
              <DropdownMenu.Item
                key={`${label}-${index}`}
                className={className}
                disabled={itemDisabled}
                onSelect={onSelect ? () => onSelect() : undefined}
                asChild={href !== undefined}
              >
                {href !== undefined ? (
                  <LinkComponent href={href}>{content}</LinkComponent>
                ) : (
                  content
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
