"use client";

import type { TablerIcon } from "@tabler/icons-react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { useLinkComponent } from "../provider/index.js";

/** A Tabler icon component (e.g. `IconPlus` from `@tabler/icons-react`). */
export type ButtonIcon = TablerIcon;

export type ButtonVariant =
  /** The default: a bordered neutral button for Save, Add and most actions. */
  | "outline"
  /** A filled neutral button for the main decision on a surface that has no needs-you item. */
  | "solid"
  /**
   * Lavender with the accent glow. Only for the one action that clears a needs-you item
   * (Design rule 6); Save, Add and every other action use `outline` or `solid`.
   */
  | "primary"
  /** No border or fill until hovered: quiet secondary actions. */
  | "ghost"
  /** Coral: a destructive decision, normally the confirm of a `ConfirmDialog`. */
  | "danger";

/** `md` is 36 px tall, `sm` 30 px. */
export type ButtonSize = "md" | "sm";

interface ButtonOwnProps {
  /** Defaults to `outline`. `primary` is only for the action that clears a needs-you item. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** An optional leading icon. */
  icon?: ButtonIcon;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonOwnProps> & {
  href?: undefined;
  ref?: Ref<HTMLButtonElement>;
};

type LinkButtonProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  keyof ButtonOwnProps | "href"
> & {
  /** Renders the button as a link through the `UiProvider` link component. */
  href: string;
  ref?: Ref<HTMLAnchorElement>;
};

export type ButtonProps = ButtonOwnProps & (NativeButtonProps | LinkButtonProps);

/** The `or-btn` class list for a variant and size. */
export function buttonClassName(
  variant: ButtonVariant = "outline",
  size: ButtonSize = "md",
  ...extra: (string | false | undefined)[]
): string {
  return ["or-btn", `or-btn--${variant}`, `or-btn--${size}`, ...extra].filter(Boolean).join(" ");
}

/**
 * A labeled button for decisions. Renders a native `<button type="button">`, or a link
 * through the `UiProvider` link component when `href` is given (a disabled link renders
 * as a disabled button, since links can't be disabled).
 */
export function Button(props: ButtonProps) {
  const LinkComponent = useLinkComponent();
  const { variant, size, icon: Icon, className, children, ...rest } = props;
  const classes = buttonClassName(variant, size, Icon && "or-btn--with-icon", className);
  const content = (
    <>
      {Icon ? <Icon className="or-btn__icon" size={16} stroke={1.75} aria-hidden="true" /> : null}
      {children}
    </>
  );

  if (rest.href !== undefined && !rest.disabled) {
    const { disabled: _disabled, ...linkProps } = rest as LinkButtonProps & { disabled?: boolean };
    return (
      <LinkComponent {...linkProps} className={classes}>
        {content}
      </LinkComponent>
    );
  }

  const {
    href: _href,
    type = "button",
    ...buttonProps
  } = rest as Omit<NativeButtonProps, "href"> & { href?: string };
  return (
    <button {...buttonProps} type={type} className={classes}>
      {content}
    </button>
  );
}
