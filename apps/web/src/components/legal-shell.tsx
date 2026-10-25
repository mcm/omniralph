"use client";

import { BrandLockup, UiProvider } from "@omniralph/ui";
import { LegalLinks } from "@/components/auth-shell";
import { Link } from "@/components/link";

/**
 * Public frame for the terms of service and privacy policy: the brand lockup (a home link)
 * above a readable prose column (68ch) on `--or-page`.
 */
export function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <UiProvider linkComponent={Link}>
      <main className="or-root legal-main">
        <div className="legal-column">
          <BrandLockup href="/" className="auth-lockup" />
          <div className="legal-document">{children}</div>
          <LegalLinks />
        </div>
      </main>
    </UiProvider>
  );
}
