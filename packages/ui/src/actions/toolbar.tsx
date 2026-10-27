"use client";

import { IconDots } from "@tabler/icons-react";
import { useRef, useState, type KeyboardEvent } from "react";
import type { ButtonIcon } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Menu, type MenuItem } from "./menu.js";

/** A primary icon action in a toolbar: an `IconButton` whose label is its tooltip. */
export type ToolbarAction = {
  label: string;
  icon: ButtonIcon;
  disabled?: boolean;
  /** Why it's disabled, as its tooltip (the button stays focusable). */
  disabledReason?: string;
  /** A tooltip that says more than `label` (e.g. "Starts when SOC-398 is done"). */
  tooltip?: string;
  /** The group's one solid action (e.g. Start epic on the Backlog). */
  solid?: boolean;
} & ({ onSelect: () => void; href?: undefined } | { href: string; onSelect?: () => void });

export interface ToolbarProps {
  /** Names the toolbar for assistive tech (e.g. "Run actions"). */
  label: string;
  /**
   * Up to three primary icon actions, drawn in one bordered group (two on most screens; the
   * Backlog's work item has Start epic or Triage now, Edit PRD and Share review link).
   */
  actions?:
    | readonly []
    | readonly [ToolbarAction]
    | readonly [ToolbarAction, ToolbarAction]
    | readonly [ToolbarAction, ToolbarAction, ToolbarAction];
  /** Everything else, behind a ⋯ "More actions" button. Destructive items go last. */
  menu?: readonly MenuItem[];
  className?: string;
}

const FOCUSABLE = "button:not(:disabled), a[href]";

/** Focusable in the toolbar: enabled, or disabled with a reason (it stays focusable). */
const focusable = (action: ToolbarAction) =>
  !action.disabled || action.disabledReason !== undefined;

/**
 * Detail actions (Design rule 5): up to three icon buttons in a bordered group plus a ⋯ menu.
 * The toolbar is one tab stop; Left/Right (and Home/End) move focus between its buttons.
 */
export function Toolbar({ label, actions = [], menu = [], className }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
  const enabledActions = actions.filter(focusable);
  const hasMenu = menu.length > 0;
  // The roving tab stop, as an index into the enabled buttons (actions, then ⋯).
  const stops = enabledActions.length + (hasMenu ? 1 : 0);
  const current = Math.min(active, Math.max(stops - 1, 0));

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const all = items();
    const index = all.indexOf(event.target as HTMLElement);
    if (index === -1 || all.length === 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % all.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + all.length) % all.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    all[next]?.focus();
  }

  function onFocus() {
    const index = items().indexOf(document.activeElement as HTMLElement);
    if (index !== -1) setActive(index);
  }

  let stop = 0;
  const tabIndexFor = (disabled: boolean | undefined) =>
    disabled ? -1 : stop++ === current ? 0 : -1;

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      className={["or-toolbar", className].filter(Boolean).join(" ")}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {actions.length > 0 ? (
        <div className="or-toolbar__group">
          {actions.map((action) => {
            const {
              label: actionLabel,
              icon,
              disabled,
              disabledReason,
              tooltip,
              href,
              onSelect,
            } = action;
            const tabIndex = tabIndexFor(!focusable(action));
            const className = action.solid
              ? "or-toolbar__button or-toolbar__button--solid"
              : "or-toolbar__button";
            const variant = action.solid ? ("solid" as const) : undefined;
            return href !== undefined ? (
              <IconButton
                key={actionLabel}
                label={actionLabel}
                icon={icon}
                href={href}
                disabled={disabled}
                disabledReason={disabledReason}
                tooltip={tooltip}
                variant={variant}
                onClick={onSelect}
                tabIndex={tabIndex}
                className={className}
              />
            ) : (
              <IconButton
                key={actionLabel}
                label={actionLabel}
                icon={icon}
                disabled={disabled}
                disabledReason={disabledReason}
                tooltip={tooltip}
                variant={variant}
                onClick={onSelect}
                tabIndex={tabIndex}
                className={className}
              />
            );
          })}
        </div>
      ) : null}
      {hasMenu ? (
        <Menu
          items={menu}
          trigger={
            <IconButton
              label="More actions"
              icon={IconDots}
              variant="outline"
              tabIndex={tabIndexFor(false)}
              className="or-toolbar__more"
            />
          }
        />
      ) : null}
    </div>
  );
}
