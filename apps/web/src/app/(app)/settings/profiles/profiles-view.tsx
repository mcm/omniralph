"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  Muted,
  Switch,
} from "@iamthemcmaster/ui";
import { IconDeviceFloppy } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MIN_PROFILE_TOKEN_CAP,
  ReviewProfileInput,
  type FieldErrors,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import { updateReviewProfile } from "./actions";
import type { ProfileSummary } from "./profile-facts";

interface ProfileRow extends ProfileSummary {
  /** ISO timestamp. */
  updatedAt: string;
}

/** A number input's value as a number (NaN when it isn't one, so validation reports it). */
function toNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function ProfileCard({ profile }: { profile: ProfileRow }) {
  const { pending, run } = useAction();
  const [model, setModel] = React.useState(profile.model);
  const [maxTokens, setMaxTokens] = React.useState(String(profile.maxTokensPerReview));
  const [maxFiles, setMaxFiles] = React.useState(String(profile.maxFiles));
  const [exploration, setExploration] = React.useState(profile.allowRepoExploration);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const idPrefix = `profile-${profile.id}`;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ReviewProfileInput.safeParse({
      model,
      maxTokensPerReview: toNumber(maxTokens),
      maxFiles: toNumber(maxFiles),
      allowRepoExploration: exploration,
    });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    run(
      () => updateReviewProfile(profile.id, parsed.data),
      `${profile.name} profile saved; it applies to the next review`,
      () => setErrors({}),
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {profile.name}
          <Badge variant="outline" size="sm">
            Built-in
          </Badge>
        </CardTitle>
        <CardDescription>
          {profile.description ?? "Review profile."} Last changed{" "}
          {formatDateTime(profile.updatedAt)}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={save}
          noValidate
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <Field
              label="Model"
              htmlFor={`${idPrefix}-model`}
              hint="Claude model ID."
              error={errors.model}
              required
            >
              <Input
                id={`${idPrefix}-model`}
                disabled={pending}
                error={Boolean(errors.model)}
                aria-invalid={Boolean(errors.model)}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </Field>
            <Field
              label="Token cap per review"
              htmlFor={`${idPrefix}-max-tokens`}
              hint={`At least ${MIN_PROFILE_TOKEN_CAP.toLocaleString()}. Reviews stop at the cap and keep partial findings.`}
              error={errors.maxTokensPerReview}
              required
            >
              <Input
                id={`${idPrefix}-max-tokens`}
                type="number"
                min={MIN_PROFILE_TOKEN_CAP}
                step={1000}
                disabled={pending}
                error={Boolean(errors.maxTokensPerReview)}
                aria-invalid={Boolean(errors.maxTokensPerReview)}
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </Field>
            <Field
              label="Max files"
              htmlFor={`${idPrefix}-max-files`}
              hint="Files reviewed at most; the lowest-risk ones are skipped first."
              error={errors.maxFiles}
              required
            >
              <Input
                id={`${idPrefix}-max-files`}
                type="number"
                min={1}
                disabled={pending}
                error={Boolean(errors.maxFiles)}
                aria-invalid={Boolean(errors.maxFiles)}
                value={maxFiles}
                onChange={(e) => setMaxFiles(e.target.value)}
              />
            </Field>
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
            <Switch
              id={`${idPrefix}-exploration`}
              checked={exploration}
              disabled={pending}
              onCheckedChange={setExploration}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <Label htmlFor={`${idPrefix}-exploration`}>Allow repository exploration</Label>
              <Muted>
                Let the reviewer read files outside the diff (read-only) for context. Off reviews
                only the diff.
              </Muted>
            </div>
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={pending}>
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : `Save ${profile.name}`}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function ProfilesView({ profiles }: { profiles: ProfileRow[] }) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Settings" }, { label: "Profiles" }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: "var(--font-weight-semibold)" }}>
            Review profiles
          </h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Each repository uses one of these profiles. Changes apply to the next review of every
            repository using the profile. Built-in profiles can be edited but not deleted.
          </Muted>
        </div>
        {profiles.map((profile) => (
          <ProfileCard key={`${profile.id}-${profile.updatedAt}`} profile={profile} />
        ))}
      </main>
    </>
  );
}
