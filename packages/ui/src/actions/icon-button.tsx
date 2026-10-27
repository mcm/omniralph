"use client";

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from "react";
import { useLinkComponent } from "../provider/index.js";
import type { ButtonIcon, ButtonSize } from "./button.js";
import { Tooltip } from "./tooltip.js";

/**
 * Icon buttons are quiet by default (`ghost`); `outline` draws the control border; `solid`
 * is a group's one solid neutral action (never the accent, Design rule 6).
 */
export type IconButtonVariant = "ghost" | "outline" | "solid";

interface IconButtonOwnProps {
  /** Required: the button's accessible name and its tooltip text. */
  label: string;
  icon: ButtonIcon;
  variant?: IconButtonVariant;
  /** `md` is 36 px square, `sm` 30 px. */
  size?: ButtonSize;
  disabled?: boolean;
  /**
   * Why the button is disabled: shown as its tooltip in place of `label`. With it, a
   * disabled button stays focusable (`aria-disabled`, clicks ignored) so the reason can show
   * on hover and keyboard focus.
   */
  disabledReason?: string;
  /**
   * The tooltip, when it should say more than `label` (e.g. "Starts when SOC-398 is done"):
   * `label` still names the button.
   */
  tooltip?: string;
  /** Which side the tooltip sits on. Defaults to `top`. */
  tooltipSide?: "top" | "right" | "bottom" | "left";
  className?: string;
}

type NativeIconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  keyof IconButtonOwnProps | "children" | "aria-label"
> & { href?: undefined; ref?: Ref<HTMLButtonElement> };

type LinkIconButtonProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  keyof IconButtonOwnProps | "children" | "aria-label" | "href"
> & { href: string; ref?: Ref<HTMLAnchorElement> };

export type IconButtonProps = IconButtonOwnProps & (NativeIconButtonProps | LinkIconButtonProps);

/**
 * An icon-only action. `label` is required: it names the button for assistive tech and
 * shows as its tooltip on hover and keyboard focus.
 */
export function IconButton(props: IconButtonProps) {
  const LinkComponent = useLinkComponent();
  const {
    label,
    icon: Icon,
    variant = "ghost",
    size = "md",
    tooltipSide,
    className,
    disabledReason,
    tooltip = label,
    ...rest
  } = props;
  const classes = ["or-icon-btn", `or-icon-btn--${variant}`, `or-icon-btn--${size}`, className]
    .filter(Boolean)
    .join(" ");
  const icon = <Icon size={size === "sm" ? 16 : 18} stroke={1.75} aria-hidden="true" />;

  if (rest.href !== undefined && !rest.disabled) {
    const { disabled: _disabled, ...linkProps } = rest as LinkIconButtonProps & {
      disabled?: boolean;
    };
    return (
      <Tooltip content={tooltip} side={tooltipSide}>
        <LinkComponent {...linkProps} aria-label={label} className={classes}>
          {icon}
        </LinkComponent>
      </Tooltip>
    );
  }

  const {
    href: _href,
    type = "button",
    ...buttonProps
  } = rest as Omit<NativeIconButtonProps, "href"> & { href?: string; disabled?: boolean };
  if (buttonProps.disabled && disabledReason) {
    const { disabled: _disabled, onClick: _onClick, ...enabledProps } = buttonProps;
    return (
      <Tooltip content={disabledReason} side={tooltipSide}>
        <button
          {...enabledProps}
          type={type}
          aria-label={label}
          aria-disabled="true"
          className={classes}
          onClick={(event) => event.preventDefault()}
        >
          {icon}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={tooltip} side={tooltipSide}>
      <button {...buttonProps} type={type} aria-label={label} className={classes}>
        {icon}
      </button>
    </Tooltip>
  );
}
