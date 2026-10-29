import { useId, type ReactNode } from "react";
import { MemberReadOnlyNote } from "@/components/admins-only-note";

/**
 * One Settings page beside the section nav: its title, then its cards. The title is the
 * page's own heading under the "Settings" title; a page about one thing (a connection) adds
 * its mark before the title, badges under it and its toolbar at the top right. A page of the
 * organization's settings (`adminOnly`) tells a member once, under its title, that only
 * admins can change them.
 */
export function SettingsPage({
  title,
  mark,
  badges,
  actions,
  adminOnly,
  children,
}: {
  title: string;
  /** A decorative mark before the title (e.g. the provider's `BrandMark`). */
  mark?: ReactNode;
  /** Badges under the title (e.g. a connection's host and account). */
  badges?: ReactNode;
  /** The page's `Toolbar`, at the top right on every width. */
  actions?: ReactNode;
  /** The organization's settings: members see them read-only, with one note saying why. */
  adminOnly?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <article className="or-settings-page" aria-labelledby={id}>
      <header className="or-settings-page__head">
        <div className="or-settings-page__heading">
          <h2 id={id} className="or-settings-page__title">
            {mark ? (
              <span className="or-settings-page__mark" aria-hidden="true">
                {mark}
              </span>
            ) : null}
            {title}
          </h2>
          {badges ? <div className="or-settings-page__badges">{badges}</div> : null}
        </div>
        {actions ? <div className="or-settings-page__actions">{actions}</div> : null}
      </header>
      {adminOnly ? <MemberReadOnlyNote /> : null}
      {children}
    </article>
  );
}
