import type * as React from "react";
import { Card, CardContent } from "@iamthemcmaster/ui";

/**
 * A detail page's key facts, each shown once, in one bordered strip above the
 * page's content (`.fact-strip*` in globals.css).
 */
export function FactStrip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="fact-strip-content">
        <dl className="fact-strip" aria-label={label}>
          {children}
        </dl>
      </CardContent>
    </Card>
  );
}

/** One fact of a `FactStrip`: a small label over its value. `wide` spans two columns. */
export function Fact({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "fact fact-wide" : "fact"}>
      <dt className="fact-label">{label}</dt>
      <dd className="fact-value">{children}</dd>
    </div>
  );
}
