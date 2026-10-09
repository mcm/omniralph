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
      <main
        style={{
          position: "relative",
          zIndex: 1,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-6)",
        }}
      >
        <div style={{ width: "100%", maxWidth: 420 }}>
          {children}
          <LegalLinks style={{ marginTop: "var(--space-4)" }} />
        </div>
      </main>
    </>
  );
}

/** The Omniralph wordmark shown above signed-out cards. */
export function AuthBrand() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-2)",
        marginBottom: "var(--space-5)",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "var(--radius-sm)",
          background: "linear-gradient(135deg, var(--glacier-500), var(--glacier-700))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--bg-page)",
            fontWeight: 600,
          }}
        >
          O
        </span>
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--glacier-300)",
          letterSpacing: ".12em",
        }}
      >
        OMNIRALPH
      </span>
    </div>
  );
}

/** Links to the terms of service and privacy policy, for signed-out pages. */
export function LegalLinks({ style }: { style?: React.CSSProperties }) {
  const linkStyle: React.CSSProperties = { color: "var(--text-tertiary)", textDecoration: "none" };
  return (
    <nav
      aria-label="Legal"
      style={{
        display: "flex",
        justifyContent: "center",
        gap: "var(--space-4)",
        fontSize: "var(--text-xs)",
        ...style,
      }}
    >
      <Link href={TERMS_PATH} style={linkStyle}>
        Terms of service
      </Link>
      <Link href={PRIVACY_PATH} style={linkStyle}>
        Privacy policy
      </Link>
    </nav>
  );
}
