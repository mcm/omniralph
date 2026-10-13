"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Label,
  Muted,
  RadioGroup,
  RadioGroupItem,
  Stack,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconExternalLink } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  RepositorySettingsInput,
  type FieldErrors,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { PageHeader } from "@/components/page-header";
import { SwitchField } from "@/components/settings-card";
import { SettingsSection, SettingsSubsection } from "@/components/settings-section";
import {
  formatSettingValue,
  settingChanges,
  withDefault,
  withoutFieldErrors,
} from "@/lib/settings/changes";
import {
  pickKeys,
  REPOSITORY_SECTIONS,
  REPOSITORY_SETTING_DEFAULTS,
  repositoryDraft,
  repositoryInput,
  repositorySpecs,
  repositoryValues,
  type RepositoryDraft,
  type RepositoryValues,
} from "@/lib/settings/forms";
import { ProviderIcon } from "../../repositories-view";
import { RepositoryNav } from "../repository-nav";
import type { ProfileSummary } from "../../../settings/profiles/profile-facts";
import { updateRepositorySettings } from "./actions";
import { CodingTasksSettingsSections, type RalphSettingsValues } from "./ralph-settings-section";
import { TaskPicker, type TaskChoiceOption } from "./task-picker";

/** The repository's settings tabs. */
export type RepositorySettingsTab = "settings" | "coding-tasks" | "harnesses";

const TAB_LABELS: Record<RepositorySettingsTab, string> = {
  settings: "Review settings",
  "coding-tasks": "Coding Tasks",
  harnesses: "Harnesses",
};

interface RepositorySettingsViewProps {
  tab: RepositorySettingsTab;
  repository: {
    id: string;
    provider: "github" | "gitlab";
    fullPath: string;
    webUrl: string;
  };
  settings: {
    profileId: string;
    triggers: { onOpen: boolean; onPush: boolean; drafts: boolean };
    pathExcludes: string[];
    customInstructions: string;
    pinnedHarnessIds: string[];
    reviewTaskIds: string[];
    correlationTaskId: string;
  };
  /** The review tasks the repository can run on its PRs/MRs (built-in and the organization's). */
  reviewTasks: (TaskChoiceOption & { description: string })[];
  /** The tasks that can correlate its review runs' findings. */
  correlationTasks: TaskChoiceOption[];
  profiles: ProfileSummary[];
  /** Harnesses that can be pinned (not revoked). */
  agents: { id: string; name: string; /** ISO timestamp. */ lastHeartbeatAt: string | null }[];
  /** The Ralph section's settings; only passed to admins. */
  ralph: RalphSettingsValues | null;
  /** The Ralph section's story and request task choices. */
  codingTasks: { story: TaskChoiceOption[]; request: TaskChoiceOption[] };
}

function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="settings-inline-error">
      {message}
    </p>
  );
}

/** Errors of the path-exclude lines, as "Line n: …" (lines count blank ones too). */
function pathExcludeErrors(text: string, errors: FieldErrors): string[] {
  const lineNumbers: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim()) lineNumbers.push(index + 1);
  });
  return Object.entries(errors).flatMap(([key, message]) => {
    const match = /^pathExcludes\.(\d+)$/.exec(key);
    if (!match) return key === "pathExcludes" ? [message] : [];
    const line = lineNumbers[Number(match[1])];
    return [`Line ${line ?? Number(match[1]) + 1}: ${message}`];
  });
}

/** The repository-level key of a form setting (the trigger switches are saved as `triggers`). */
function inputKey(key: keyof RepositoryValues): string {
  return key === "onOpen" || key === "onPush" || key === "drafts" ? "triggers" : key;
}

const onOff = (value: boolean) => formatSettingValue(value);

export function RepositorySettingsView({
  tab,
  repository,
  settings,
  reviewTasks,
  correlationTasks,
  profiles,
  agents,
  ralph,
  codingTasks,
}: RepositorySettingsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const disabled = !isAdmin;

  const context = React.useMemo(
    () => ({ reviewTaskIds: reviewTasks.map((t) => t.id), harnessIds: agents.map((a) => a.id) }),
    [reviewTasks, agents],
  );
  const saved = React.useMemo(() => repositoryDraft(settings), [settings]);
  const [draft, setDraft] = React.useState(saved);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const set = <K extends keyof RepositoryDraft>(key: K, value: RepositoryDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const savedValues = repositoryValues(saved, context);
  const draftValues = repositoryValues(draft, context);
  const specs = React.useMemo(
    () =>
      repositorySpecs({
        profiles: new Map(profiles.map((p) => [p.id, p.name])),
        tasks: new Map([...reviewTasks, ...correlationTasks].map((t) => [t.id, t.name])),
        harnesses: new Map(agents.map((a) => [a.id, a.name])),
      }),
    [profiles, reviewTasks, correlationTasks, agents],
  );
  const taskName = (id: string) =>
    [...reviewTasks, ...correlationTasks].find((t) => t.id === id)?.name ?? id;

  /** The props of the settings section saving `keys`. */
  const section = (
    keys: readonly (keyof RepositoryValues)[],
    success: (input: RepositorySettingsInput) => string,
  ) => ({
    readOnly: !isAdmin,
    changes: settingChanges(
      keys.map((key) => specs[key]),
      savedValues,
      draftValues,
    ),
    onDiscard: () => {
      setDraft((d) => ({ ...d, ...pickKeys(saved, keys as (keyof RepositoryDraft)[]) }));
      setErrors((e) => withoutFieldErrors(e, keys.map(inputKey)));
    },
    prepare: () => {
      // The saved settings with this card's changes only.
      const parsed = RepositorySettingsInput.safeParse(
        repositoryInput({ ...savedValues, ...pickKeys(draftValues, keys) }),
      );
      if (!parsed.success) {
        setErrors((e) => ({
          ...withoutFieldErrors(e, keys.map(inputKey)),
          ...toFieldErrors(parsed.error),
        }));
        return null;
      }
      return {
        action: () => updateRepositorySettings(repository.id, parsed.data),
        success: success(parsed.data),
        onSuccess: () => setErrors((e) => withoutFieldErrors(e, keys.map(inputKey))),
        onError: (result: { fieldErrors?: FieldErrors }) =>
          setErrors((e) => ({ ...e, ...result.fieldErrors })),
      };
    },
  });
  const appliesNext = () => "Saved; it applies to the next review";

  const excludeErrors = pathExcludeErrors(draft.pathExcludes, errors);
  const instructionsLength = draft.customInstructions.length;
  const defaultProfile =
    profiles.find((p) => p.id === REPOSITORY_SETTING_DEFAULTS.profileId)?.name ?? "Standard";

  const harnessesSection = (
    <SettingsSection
      id="harnesses"
      title="Harnesses"
      showTitle={false}
      description="Which harnesses run this repository's review and Coding Tasks jobs. Newly pinned harnesses pre-clone the repository."
      {...section(REPOSITORY_SECTIONS.harnesses, (input) =>
        input.pinnedHarnessIds.some((id) => !settings.pinnedHarnessIds.includes(id))
          ? "Saved; newly pinned harnesses will pre-clone the repository"
          : "Saved; it applies to the next job",
      )}
    >
      <SettingsSubsection
        id="harnesses-pinning"
        title="Pinning"
        description="Leave all unpinned to let any harness run them. Default: none pinned."
      >
        {agents.length === 0 ? (
          <Muted>No harnesses are enrolled yet; any harness that enrolls can run jobs.</Muted>
        ) : (
          <Stack gap={3} role="group" aria-label="Pinned harnesses">
            {agents.map((agent) => (
              <div key={agent.id} className="settings-check settings-check-center">
                <Checkbox
                  id={`pin-${agent.id}`}
                  checked={draft.pinnedHarnessIds.includes(agent.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    set(
                      "pinnedHarnessIds",
                      checked === true
                        ? [...draft.pinnedHarnessIds, agent.id]
                        : draft.pinnedHarnessIds.filter((id) => id !== agent.id),
                    )
                  }
                />
                <Label htmlFor={`pin-${agent.id}`}>{agent.name}</Label>
                {!agent.lastHeartbeatAt && <Badge variant="neutral">Never seen</Badge>}
              </div>
            ))}
          </Stack>
        )}
        <Muted>
          {draftValues.pinnedHarnessIds.length === 0
            ? "Any harness can run this repository's jobs."
            : `Only the ${draftValues.pinnedHarnessIds.length === 1 ? "pinned harness runs" : `${draftValues.pinnedHarnessIds.length} pinned harnesses run`} this repository's jobs.`}
        </Muted>
        <InlineError
          message={
            errors.pinnedHarnessIds ??
            Object.entries(errors).find(([key]) => key.startsWith("pinnedHarnessIds."))?.[1]
          }
        />
      </SettingsSubsection>
    </SettingsSection>
  );

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository.fullPath },
          { label: TAB_LABELS[tab] },
        ]}
      />
      <main className="detail-main">
        <PageHeader
          title={
            <>
              <ProviderIcon provider={repository.provider} size={20} />
              <span className="text-numeric">{repository.fullPath}</span>
            </>
          }
          description="How this repository is reviewed and built."
          actions={
            <Button asChild variant="ghost">
              <a href={repository.webUrl} target="_blank" rel="noreferrer">
                <IconExternalLink size={14} />
                Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
              </a>
            </Button>
          }
        />

        <RepositoryNav repositoryId={repository.id} current={tab} />

        {!isAdmin && (
          <Muted>Only admins can change repository settings; they&apos;re shown read-only.</Muted>
        )}

        <div className="settings-sections">
          {tab === "settings" && (
            <SettingsSection
              id="code-review"
              title="Review settings"
              showTitle={false}
              description="How pull and merge requests in this repository are reviewed. Changes apply to the next review; queued and running reviews keep the settings they started with."
              confirm={{
                consequence:
                  "The next review of this repository uses these settings. Queued and running reviews keep the settings they started with.",
              }}
              {...section(REPOSITORY_SECTIONS.review, appliesNext)}
            >
              <SettingsSubsection
                id="code-review-when"
                title="When"
                description="Which pull and merge request events start a review."
              >
                <SwitchField
                  id="trigger-on-open"
                  label="Review when opened"
                  description={withDefault(
                    "When it's opened or marked ready for review.",
                    onOff(REPOSITORY_SETTING_DEFAULTS.triggers.onOpen),
                  )}
                  checked={draft.onOpen}
                  disabled={disabled}
                  onChange={(value) => set("onOpen", value)}
                />
                <SwitchField
                  id="trigger-on-push"
                  label="Review when pushed to"
                  description={withDefault(
                    "Review the new commits.",
                    onOff(REPOSITORY_SETTING_DEFAULTS.triggers.onPush),
                  )}
                  checked={draft.onPush}
                  disabled={disabled}
                  onChange={(value) => set("onPush", value)}
                />
                <SwitchField
                  id="trigger-drafts"
                  label="Include drafts"
                  description={withDefault(
                    "Also review draft pull and merge requests.",
                    onOff(REPOSITORY_SETTING_DEFAULTS.triggers.drafts),
                  )}
                  checked={draft.drafts}
                  disabled={disabled}
                  onChange={(value) => set("drafts", value)}
                />
              </SettingsSubsection>

              <SettingsSubsection
                id="code-review-reviewers"
                title="Who reviews"
                description={
                  <>
                    The profile sets depth against token usage; the reviewers run in parallel and
                    post one combined review.
                    {isAdmin && (
                      <>
                        {" "}
                        Edit profiles in{" "}
                        <Link href="/settings/profiles" className="settings-link">
                          Settings › Profiles
                        </Link>
                        .
                      </>
                    )}
                  </>
                }
              >
                <div className="settings-group" role="group" aria-labelledby="profile-label">
                  <span id="profile-label" className="settings-group-label">
                    Profile
                  </span>
                  <Muted>Default: {defaultProfile}.</Muted>
                  <RadioGroup
                    value={draft.profileId}
                    onValueChange={(value) => set("profileId", value)}
                    disabled={disabled}
                    aria-labelledby="profile-label"
                    className="settings-profile-table-wrap"
                  >
                    <table className="settings-profile-table">
                      <thead>
                        <tr>
                          <th scope="col">
                            <span className="sr-only">Selected</span>
                          </th>
                          <th scope="col">Profile</th>
                          <th scope="col">Model</th>
                          <th scope="col" className="numeric settings-profile-wide">
                            Token cap
                          </th>
                          <th scope="col" className="numeric settings-profile-wide">
                            Max files
                          </th>
                          <th scope="col" className="settings-profile-wide">
                            Exploration
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {profiles.map((profile) => (
                          <tr
                            key={profile.id}
                            data-selected={profile.id === draft.profileId ? "" : undefined}
                            onClick={() => !disabled && set("profileId", profile.id)}
                          >
                            <td>
                              <RadioGroupItem
                                id={`profile-${profile.id}`}
                                value={profile.id}
                                aria-describedby={
                                  profile.description ? `profile-${profile.id}-desc` : undefined
                                }
                              />
                            </td>
                            <td>
                              <Label htmlFor={`profile-${profile.id}`} className="settings-profile-name">
                                {profile.name}
                              </Label>
                              {profile.description && (
                                <Muted id={`profile-${profile.id}-desc`} className="settings-profile-desc">
                                  {profile.description}
                                </Muted>
                              )}
                            </td>
                            <td className="text-numeric settings-profile-model">{profile.model}</td>
                            <td className="numeric text-numeric settings-profile-wide">
                              {profile.maxTokensPerReview.toLocaleString()}
                            </td>
                            <td className="numeric text-numeric settings-profile-wide">
                              {profile.maxFiles.toLocaleString()}
                            </td>
                            <td className="settings-profile-wide">
                              {profile.allowRepoExploration ? "Explores the repository" : "Diff only"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </RadioGroup>
                  <InlineError message={errors.profileId} />
                </div>
                <div className="settings-group" role="group" aria-labelledby="review-tasks-label">
                  <span id="review-tasks-label" className="settings-group-label">
                    Reviewers
                  </span>
                  <Muted>
                    Default: {taskName(REPOSITORY_SETTING_DEFAULTS.reviewTaskIds[0])} only.
                  </Muted>
                  {reviewTasks.map((task) => (
                    <div key={task.id} className="settings-check">
                      <Checkbox
                        id={`review-task-${task.id}`}
                        checked={draft.reviewTaskIds.includes(task.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          set(
                            "reviewTaskIds",
                            checked === true
                              ? [...draft.reviewTaskIds, task.id]
                              : draft.reviewTaskIds.filter((id) => id !== task.id),
                          )
                        }
                      />
                      <Stack gap={1}>
                        <Label htmlFor={`review-task-${task.id}`}>
                          {task.name} {task.builtin && <Badge variant="neutral">Built-in</Badge>}
                        </Label>
                        {task.description && <Muted>{task.description}</Muted>}
                      </Stack>
                    </div>
                  ))}
                  <InlineError message={errors.reviewTaskIds} />
                </div>
                <TaskPicker
                  id="correlation-task"
                  label="Correlation task"
                  hint={withDefault(
                    "Merges findings that describe the same issue and writes the combined summary.",
                    taskName(REPOSITORY_SETTING_DEFAULTS.correlationTaskId),
                  )}
                  value={draft.correlationTaskId}
                  choices={correlationTasks}
                  disabled={disabled}
                  error={errors.correlationTaskId}
                  onChange={(value) => set("correlationTaskId", value)}
                />
              </SettingsSubsection>

              <SettingsSubsection
                id="code-review-scope"
                title="Scope"
                description="What the reviewers skip, and what they should know about this repository."
              >
                <Field
                  label="Path excludes"
                  htmlFor="path-excludes"
                  description="One glob per line. Without / it matches at any depth; a leading / anchors it to the root. Lock files, build output and generated files are always skipped. Default: none."
                >
                  <Textarea
                    id="path-excludes"
                    rows={4}
                    disabled={disabled}
                    error={excludeErrors.length > 0}
                    aria-invalid={excludeErrors.length > 0}
                    value={draft.pathExcludes}
                    onChange={(e) => set("pathExcludes", e.target.value)}
                    placeholder={"*.snap\n/docs/**\nsrc/**/*.generated.ts"}
                    className="settings-mono"
                  />
                </Field>
                {excludeErrors.map((message) => (
                  <InlineError key={message} message={message} />
                ))}
                <Field
                  label="Custom instructions"
                  htmlFor="custom-instructions"
                  description={`Added to every review prompt. ${instructionsLength.toLocaleString()} / ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString()} characters. Default: none.`}
                  error={errors.customInstructions}
                >
                  <Textarea
                    id="custom-instructions"
                    rows={4}
                    disabled={disabled}
                    error={Boolean(errors.customInstructions)}
                    aria-invalid={Boolean(errors.customInstructions)}
                    value={draft.customInstructions}
                    onChange={(e) => set("customInstructions", e.target.value)}
                    placeholder="e.g. We use Result types instead of exceptions; flag thrown errors in src/core."
                  />
                </Field>
              </SettingsSubsection>
            </SettingsSection>

          )}
          {tab === "coding-tasks" && ralph && (
            <CodingTasksSettingsSections
              repositoryId={repository.id}
              settings={ralph}
              codingTasks={codingTasks}
            />
          )}
          {tab === "harnesses" && harnessesSection}
        </div>
      </main>
    </>
  );
}
