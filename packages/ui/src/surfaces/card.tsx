"use client";

import { useId, type ReactNode } from "react";
import { InfoPopover } from "./popovers.js";

/** 1 is for a card or empty state that is the page itself (e.g. a signed-out page). */
export type HeadingLevel = 1 | 2 | 3 | 4;

export interface CardProps {
  /** The card's heading; it also names the `section`. */
  title: ReactNode;
  /** Heading level of the title. Defaults to 2. */
  headingLevel?: HeadingLevel;
  /** Provenance shown behind an ⓘ button right after the title (Design rule 11). */
  info?: ReactNode;
  /** The ⓘ button's label. Defaults to "About this card". */
  infoLabel?: string;
  /** Actions aligned to the right of the header (e.g. a `Toolbar`). */
  actions?: ReactNode;
  /** The title's id; generated when omitted. */
  titleId?: string;
  className?: string;
  children?: ReactNode;
}

/** A bordered surface: a `section` labeled by its title, with optional info and actions. */
export function Card({
  title,
  headingLevel = 2,
  info,
  infoLabel,
  actions,
  titleId,
  className,
  children,
}: CardProps) {
  const generatedId = useId();
  const id = titleId ?? generatedId;
  const Heading = `h${headingLevel}` as const;
  return (
    <section className={["or-card", className].filter(Boolean).join(" ")} aria-labelledby={id}>
      <div className="or-card__head">
        <div className="or-card__heading">
          <Heading id={id} className="or-card__title">
            {title}
          </Heading>
          {info !== undefined ? <InfoPopover label={infoLabel}>{info}</InfoPopover> : null}
        </div>
        {actions !== undefined ? <div className="or-card__actions">{actions}</div> : null}
      </div>
      {children !== undefined ? <div className="or-card__body">{children}</div> : null}
    </section>
  );
}
