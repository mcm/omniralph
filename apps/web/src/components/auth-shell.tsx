"use client";

import { BrandLockup, UiProvider } from "@omniralph/ui";
import { Link } from "@/components/link";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/auth/routes";

/**
 * Signed-out frame: the brand lockup (a home link) above a centered column on `--or-page`,
 * with links to the terms of service and privacy policy. Pages put one `Card` in it.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <UiProvider linkComponent={Link}>
      <main className="or-root auth-main">
        <div className="auth-column">
          <BrandLockup href="/" className="auth-lockup" />
          {children}
          <LegalLinks />
        </div>
      </main>
    </UiProvider>
  );
}

/** Links to the terms of service and privacy policy, for signed-out pages. */
export function LegalLinks() {
  return (
    <nav aria-label="Legal" className="auth-legal-links">
      <Link href={TERMS_PATH}>Terms of service</Link>
      <Link href={PRIVACY_PATH}>Privacy policy</Link>
    </nav>
  );
}

/**
 * Why something on a signed-out page failed or isn't allowed: a coral-dotted panel announced
 * as an alert, with an optional bold title.
 */
export function AuthAlert({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div role="alert" className="auth-alert">
      <span className="or-dot or-dot--fail" aria-hidden="true" />
      <div className="auth-alert-body">
        {title ? <p className="auth-alert-title">{title}</p> : null}
        <p className="auth-alert-text">{children}</p>
      </div>
    </div>
  );
}
