"use client";

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from "react";
import { useLinkComponent } from "../provider/index.js";
import type { ButtonIcon, ButtonSize } from "./button.js";
import { Tooltip } from "./tooltip.js";

/** Icon buttons are quiet by default (`ghost`); `outline` draws the control border. */
export type IconButtonVariant = "ghost" | "outline";

interface IconButtonOwnProps {
  /** Required: the button's accessible name and its tooltip text. */
  label: string;
  icon: ButtonIcon;
  variant?: IconButtonVariant;
  /** `md` is 36 px square, `sm` 30 px. */
  size?: ButtonSize;
  disabled?: boolean;
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
      <Tooltip content={label} side={tooltipSide}>
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
  } = rest as Omit<NativeIconButtonProps, "href"> & { href?: string };
  return (
    <Tooltip content={label} side={tooltipSide}>
      <button {...buttonProps} type={type} aria-label={label} className={classes}>
        {icon}
      </button>
    </Tooltip>
  );
}
