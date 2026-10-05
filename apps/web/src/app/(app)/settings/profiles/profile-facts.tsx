"use client";

import { Badge } from "@iamthemcmaster/ui";

/** A review profile as shown in the settings pages. */
export interface ProfileSummary {
  id: string;
  name: string;
  description: string | null;
  model: string;
  maxTokensPerReview: number;
  maxFiles: number;
  allowRepoExploration: boolean;
}

const factLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-tertiary)",
};

const factValue: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--text-primary)",
  fontVariantNumeric: "tabular-nums",
};

/** A profile's model, token cap and max files. */
export function ProfileFacts({ profile }: { profile: ProfileSummary }) {
  const facts = [
    { label: "Model", value: profile.model, mono: true },
    { label: "Token cap", value: profile.maxTokensPerReview.toLocaleString(), mono: false },
    { label: "Max files", value: profile.maxFiles.toLocaleString(), mono: false },
  ];
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        columnGap: "var(--space-3)",
        rowGap: "var(--space-1)",
        alignItems: "baseline",
      }}
    >
      {facts.map((fact) => (
        <div key={fact.label} style={{ display: "contents" }}>
          <dt style={factLabel}>{fact.label}</dt>
          <dd
            style={{
              ...factValue,
              margin: 0,
              fontFamily: fact.mono ? "var(--font-mono)" : undefined,
              overflowWrap: "anywhere",
            }}
          >
            {fact.value}
          </dd>
        </div>
      ))}
      <dt style={factLabel}>Exploration</dt>
      <dd style={{ margin: 0 }}>
        <Badge variant={profile.allowRepoExploration ? "info" : "neutral"} size="sm">
          {profile.allowRepoExploration ? "Explores the repository" : "Diff only"}
        </Badge>
      </dd>
    </dl>
  );
}
