"use client";

import Link from "next/link";
import { AuroraField } from "@iamthemcmaster/ui";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/auth/routes";

/**
 * Signed-out frame: a centered column over the full-strength `AuroraField` backdrop, with links
 * to the terms of service and privacy policy.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuroraField />
      <main className="auth-main">
        <div className="auth-column">
          {children}
          <LegalLinks />
        </div>
      </main>
    </>
  );
}

/** The Omniralph wordmark shown above signed-out cards. */
export function AuthBrand() {
  return (
    <div className="auth-brand">
      <div className="auth-brand-mark">
        <span className="font-mono font-semibold text-sm text-accent-fg">O</span>
      </div>
      <span className="auth-brand-name">OMNIRALPH</span>
    </div>
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
