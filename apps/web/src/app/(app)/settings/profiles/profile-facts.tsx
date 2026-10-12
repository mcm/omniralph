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

/** A profile's model, token cap and max files. */
export function ProfileFacts({ profile }: { profile: ProfileSummary }) {
  const facts = [
    { label: "Model", value: profile.model, mono: true },
    { label: "Token cap", value: profile.maxTokensPerReview.toLocaleString(), mono: false },
    { label: "Max files", value: profile.maxFiles.toLocaleString(), mono: false },
  ];
  return (
    <dl className="profiles-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="profiles-fact">
          <dt className="profiles-fact-label">{fact.label}</dt>
          <dd className={fact.mono ? "profiles-fact-value font-mono" : "profiles-fact-value"}>
            {fact.value}
          </dd>
        </div>
      ))}
      <dt className="profiles-fact-label">Exploration</dt>
      <dd className="m-0">
        <Badge variant={profile.allowRepoExploration ? "info" : "neutral"} size="sm">
          {profile.allowRepoExploration ? "Explores the repository" : "Diff only"}
        </Badge>
      </dd>
    </dl>
  );
}
