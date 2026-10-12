"use client";

import { AuroraField, Card, CardContent } from "@iamthemcmaster/ui";
import { AuthBrand, LegalLinks } from "@/components/auth-shell";

/** Public frame for the terms of service and privacy policy: a readable column over `AuroraField`. */
export function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AuroraField />
      <main className="legal-main">
        <div className="legal-column">
          <AuthBrand />
          <Card>
            <CardContent className="legal-document pt-8">{children}</CardContent>
          </Card>
          <LegalLinks />
        </div>
      </main>
    </>
  );
}
