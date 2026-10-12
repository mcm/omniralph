"use client";

import { AuroraField, Card, CardContent } from "@iamthemcmaster/ui";
import { AuthBrand, LegalLinks } from "@/components/auth-shell";

/** Public frame for the terms of service and privacy policy: a readable column over `AuroraField`. */
export function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuroraField />
      <main
        style={{
          position: "relative",
          zIndex: 1,
          minHeight: "100vh",
          padding: "var(--space-16) var(--space-8)",
        }}
      >
        <div style={{ width: "100%", maxWidth: 760, margin: "0 auto" }}>
          <AuthBrand />
          <Card>
            <CardContent className="legal-document" style={{ paddingTop: "var(--space-8)" }}>
              {children}
            </CardContent>
          </Card>
          <LegalLinks style={{ marginTop: "var(--space-4)" }} />
        </div>
      </main>
    </>
  );
}
