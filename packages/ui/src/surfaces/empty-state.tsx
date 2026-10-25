import type { ReactNode } from "react";
import type { ButtonIcon } from "../actions/button.js";
import type { HeadingLevel } from "./card.js";

export interface EmptyStateProps {
  /** What is empty, e.g. "Nothing needs you". */
  title: ReactNode;
  headingLevel?: HeadingLevel;
  /** One sentence on what the empty state means. */
  description?: ReactNode;
  /** One action, e.g. a `Button`. */
  action?: ReactNode;
  /** An optional decorative Tabler icon above the heading. */
  icon?: ButtonIcon;
  className?: string;
}

/** What a list or screen shows when it has nothing in it. */
export function EmptyState({
  title,
  headingLevel = 2,
  description,
  action,
  icon: Icon,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={["or-empty", className].filter(Boolean).join(" ")}>
      {Icon ? <Icon className="or-empty__icon" size={28} stroke={1.5} aria-hidden="true" /> : null}
      <Heading className="or-empty__title">{title}</Heading>
      {description !== undefined ? <p className="or-empty__description">{description}</p> : null}
      {action !== undefined ? <div className="or-empty__action">{action}</div> : null}
    </div>
  );
}
