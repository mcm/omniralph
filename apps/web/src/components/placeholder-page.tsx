"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "@iamthemcmaster/ui";
import { AppHeader } from "@/components/app-header";

interface PlaceholderPageProps {
  title: string;
  description: string;
}

/** Page frame for sections that later stories of the epic will fill in. */
export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: title }]} />
      <main style={{ flex: 1, overflowY: "auto", padding: "var(--space-6)" }}>
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    </>
  );
}
