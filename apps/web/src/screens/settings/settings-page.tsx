import { useId, type ReactNode } from "react";

/**
 * One Settings page beside the section nav: its title, then its cards. The title is the
 * page's own heading under the "Settings" title.
 */
export function SettingsPage({ title, children }: { title: string; children?: ReactNode }) {
  const id = useId();
  return (
    <article className="or-settings-page" aria-labelledby={id}>
      <h2 id={id} className="or-settings-page__title">
        {title}
      </h2>
      {children}
    </article>
  );
}
