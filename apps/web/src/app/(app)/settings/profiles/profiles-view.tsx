"use client";

import * as React from "react";
import { Badge, Field, Input } from "@iamthemcmaster/ui";
import {
  fieldErrors as toFieldErrors,
  MIN_PROFILE_TOKEN_CAP,
  ReviewProfileInput,
  type FieldErrors,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { SettingsCard, SwitchField } from "@/components/settings-card";
import { formatDateTime } from "@/lib/format-date";
import { formatSettingValue, settingChanges, withDefault } from "@/lib/settings/changes";
import {
  PROFILE_SPECS,
  profileDraft,
  profileValues,
  regroupTyped,
  type ProfileDraft,
} from "@/lib/settings/forms";
import { updateReviewProfile } from "./actions";
import type { ProfileSummary } from "./profile-facts";

interface ProfileRow extends ProfileSummary {
  /** ISO timestamp. */
  updatedAt: string;
  builtIn: boolean;
  /** A built-in profile's original limits; null for others. */
  defaults: ReviewProfileInput | null;
  /** The connected repositories using the profile, by path. */
  repositories: { id: string; fullPath: string }[];
}

/** Repositories listed by name in the confirmation; the rest are counted. */
const AFFECTED_LISTED = 8;

function repositoryCount(count: number): string {
  return count === 1 ? "1 repository" : `${count.toLocaleString("en-US")} repositories`;
}

/** The repositories a profile change affects, for its confirmation. */
export function AffectedRepositories({
  repositories,
}: {
  repositories: ProfileRow["repositories"];
}) {
  if (repositories.length === 0) {
    return (
      <div className="settings-affected">
        No repository uses this profile, so no review changes.
      </div>
    );
  }
  const rest = repositories.length - AFFECTED_LISTED;
  return (
    <div className="settings-affected">
      <span>Affects the next review of {repositoryCount(repositories.length)}:</span>
      <ul>
        {repositories.slice(0, AFFECTED_LISTED).map((repository) => (
          <li key={repository.id}>{repository.fullPath}</li>
        ))}
        {rest > 0 && <li>and {repositoryCount(rest)} more</li>}
      </ul>
    </div>
  );
}

function ProfileCard({ profile }: { profile: ProfileRow }) {
  const saved = React.useMemo(() => profileDraft(profile), [profile]);
  const [draft, setDraft] = React.useState(saved);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const idPrefix = `profile-${profile.id}`;
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const defaults = profile.defaults;
  const describe = (text: string, key: keyof ReviewProfileInput) =>
    defaults ? withDefault(text, formatSettingValue(defaults[key])) : text;

  const prepare = () => {
    const parsed = ReviewProfileInput.safeParse(profileValues(draft));
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return null;
    }
    return {
      action: () => updateReviewProfile(profile.id, parsed.data),
      success: `${profile.name} profile saved; it applies to the next review`,
      onSuccess: () => setErrors({}),
      onError: (result: { fieldErrors?: FieldErrors }) => setErrors(result.fieldErrors ?? {}),
    };
  };

  return (
    <SettingsCard
      title={profile.name}
      titleExtra={
        profile.builtIn && (
          <Badge variant="neutral" size="sm">
            Built-in
          </Badge>
        )
      }
      description={`${profile.description ?? "Review profile."} Used by ${repositoryCount(profile.repositories.length)}. Last changed ${formatDateTime(profile.updatedAt)}.`}
      changes={settingChanges(PROFILE_SPECS, profileValues(saved), profileValues(draft))}
      prepare={prepare}
      onDiscard={() => {
        setDraft(saved);
        setErrors({});
      }}
      confirm={{
        consequence: `The next review of every repository using ${profile.name} uses the new limits. Queued and running reviews keep the ones they started with.`,
        affected: <AffectedRepositories repositories={profile.repositories} />,
      }}
    >
      <div className="settings-row">
        <Field
          label="Model"
          htmlFor={`${idPrefix}-model`}
          description={describe("Claude model ID.", "model")}
          error={errors.model}
          required
        >
          <Input
            id={`${idPrefix}-model`}
            error={Boolean(errors.model)}
            aria-invalid={Boolean(errors.model)}
            value={draft.model}
            onChange={(e) => set("model", e.target.value)}
            className="settings-mono"
          />
        </Field>
        <Field
          label="Token cap per review"
          htmlFor={`${idPrefix}-max-tokens`}
          description={describe(
            `At least ${MIN_PROFILE_TOKEN_CAP.toLocaleString("en-US")}. Reviews stop at the cap and keep partial findings.`,
            "maxTokensPerReview",
          )}
          error={errors.maxTokensPerReview}
          required
        >
          <GroupedNumberInput
            id={`${idPrefix}-max-tokens`}
            error={Boolean(errors.maxTokensPerReview)}
            value={draft.maxTokensPerReview}
            onChange={(value) => set("maxTokensPerReview", value)}
          />
        </Field>
        <Field
          label="Max files"
          htmlFor={`${idPrefix}-max-files`}
          description={describe(
            "Files reviewed at most; the lowest-risk ones are skipped first.",
            "maxFiles",
          )}
          error={errors.maxFiles}
          required
        >
          <Input
            id={`${idPrefix}-max-files`}
            type="number"
            min={1}
            error={Boolean(errors.maxFiles)}
            aria-invalid={Boolean(errors.maxFiles)}
            value={draft.maxFiles}
            onChange={(e) => set("maxFiles", e.target.value)}
            className="text-numeric input-number"
          />
        </Field>
      </div>
      <SwitchField
        id={`${idPrefix}-exploration`}
        label="Allow repository exploration"
        description={describe(
          "Let the reviewer read files outside the diff (read-only) for context. Off reviews only the diff.",
          "allowRepoExploration",
        )}
        checked={draft.allowRepoExploration}
        disabled={false}
        onChange={(value) => set("allowRepoExploration", value)}
      />
    </SettingsCard>
  );
}

export function ProfilesView({ profiles }: { profiles: ProfileRow[] }) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Profiles" }]} />
      <main className="detail-main">
        <PageHeader
          title="Review profiles"
          description="Each repository uses one of these profiles. Changes apply to the next review of every repository using the profile. Built-in profiles can be edited but not deleted."
        />
        {profiles.map((profile) => (
          <ProfileCard key={`${profile.id}-${profile.updatedAt}`} profile={profile} />
        ))}
      </main>
    </>
  );
}

/** A large count that keeps its thousands grouping as it is typed ("150000" shows "150,000"). */
function GroupedNumberInput({
  id,
  error,
  value,
  onChange,
}: {
  id: string;
  error: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const caret = React.useRef<{ input: HTMLInputElement; position: number } | null>(null);
  // Regrouping replaces the value, which moves the caret to the end: put it back.
  React.useLayoutEffect(() => {
    if (!caret.current) return;
    const { input, position } = caret.current;
    caret.current = null;
    if (document.activeElement === input) input.setSelectionRange(position, position);
  });
  return (
    <Input
      id={id}
      inputMode="numeric"
      error={error}
      aria-invalid={error}
      value={value}
      onChange={(e) => {
        const input = e.target;
        const next = regroupTyped(input.value, input.selectionStart ?? input.value.length);
        caret.current = { input, position: next.caret };
        onChange(next.value);
      }}
      className="text-numeric input-number-wide"
    />
  );
}
