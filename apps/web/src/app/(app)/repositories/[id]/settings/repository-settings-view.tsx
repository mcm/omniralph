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
  RepositoryTaskTypesInput,
  type FieldErrors,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { MonoPath, MonoValue } from "@/components/mono-value";
import { MultiSelect } from "@/components/pickers";
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
import {
  CodingSettingsSections,
  type CodingChoices,
  type RalphSettingsValues,
} from "./ralph-settings-section";
import { TaskPicker, type TaskChoiceOption } from "./task-picker";
import {
  saveWithTaskTypes,
  TaskTypeSelect,
  taskTypeOn,
  taskTypeSpec,
  type TaskTypeSwitch,
  type TaskTypesValues,
} from "./task-types";

/** The repository's settings tabs, by route segment. */
export type RepositorySettingsTab = "settings" | "coding" | "harnesses";

const TAB_LABELS: Record<RepositorySettingsTab, string> = {
  settings: "Review settings",
  coding: "Coding",
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
  /** The Coding tab's settings; only passed to admins. */
  ralph: RalphSettingsValues | null;
  /** The Coding tab's picker choices; only passed to admins on that tab. */
  codingChoices: CodingChoices | null;
  /** The Coding tab's story and request task choices. */
  codingTasks: { story: TaskChoiceOption[]; request: TaskChoiceOption[] };
  /** Query, Reviews and Coding: the repository's own values and the organization's defaults. */
  taskTypes: TaskTypesValues;
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

/** The task-type switches a tab's section saves. */
const REVIEW_TASK_TYPES = ["review", "query"] as const satisfies readonly TaskTypeSwitch[];

/**
 * Repository › Review settings, Coding or Harnesses: each tab is one section with one save (the
 * Coding tab adds the Danger zone). Coding is for admins only; others see the rest read-only.
 */
export function RepositorySettingsView({
  tab,
  repository,
  settings,
  reviewTasks,
  correlationTasks,
  profiles,
  agents,
  ralph,
  codingChoices,
  codingTasks,
  taskTypes,
}: RepositorySettingsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const disabled = !isAdmin;

  const context = React.useMemo(
    () => ({ reviewTaskIds: reviewTasks.map((t) => t.id), harnessIds: agents.map((a) => a.id) }),
    [reviewTasks, agents],
  );
  const saved = React.useMemo(() => repositoryDraft(settings), [settings]);
  const [draft, setDraft] = React.useState(saved);
  const [typesDraft, setTypesDraft] = React.useState(taskTypes.overrides);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const set = <K extends keyof RepositoryDraft>(key: K, value: RepositoryDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setType = (key: TaskTypeSwitch, value: boolean | null) =>
    setTypesDraft((d) => ({ ...d, [key]: value }));

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

  /** The props of the section saving `keys` and the task-type switches `types`. */
  const section = (
    keys: readonly (keyof RepositoryValues)[],
    types: readonly TaskTypeSwitch[],
    success: (input: RepositorySettingsInput) => string,
  ) => {
    const errorKeys = [...keys.map(inputKey), ...types];
    const changes = [
      ...settingChanges(
        types.map((key) => taskTypeSpec(taskTypes, key)),
        taskTypes.overrides,
        typesDraft,
      ),
      ...settingChanges(
        keys.map((key) => specs[key]),
        savedValues,
        draftValues,
      ),
    ];
    return {
      readOnly: !isAdmin,
      changes,
      onDiscard: () => {
        setDraft((d) => ({ ...d, ...pickKeys(saved, keys as (keyof RepositoryDraft)[]) }));
        setTypesDraft((d) => ({ ...d, ...pickKeys(taskTypes.overrides, types) }));
        setErrors((e) => withoutFieldErrors(e, errorKeys));
      },
      prepare: () => {
        // The saved settings with this section's changes only.
        const parsed = RepositorySettingsInput.safeParse(
          repositoryInput({ ...savedValues, ...pickKeys(draftValues, keys) }),
        );
        const parsedTypes = RepositoryTaskTypesInput.safeParse(typesDraft);
        if (!parsed.success || !parsedTypes.success) {
          setErrors((e) => ({
            ...withoutFieldErrors(e, errorKeys),
            ...(parsed.success ? {} : toFieldErrors(parsed.error)),
            ...(parsedTypes.success ? {} : toFieldErrors(parsedTypes.error)),
          }));
          return null;
        }
        const settingsChanged = changes.some((change) =>
          (keys as readonly string[]).includes(change.key),
        );
        return {
          action: saveWithTaskTypes(
            repository.id,
            taskTypes.overrides,
            parsedTypes.data,
            types,
            settingsChanged ? () => updateRepositorySettings(repository.id, parsed.data) : null,
          ),
          success: success(parsed.data),
          onSuccess: () => setErrors((e) => withoutFieldErrors(e, errorKeys)),
          onError: (result: { fieldErrors?: FieldErrors }) =>
            setErrors((e) => ({ ...e, ...result.fieldErrors })),
        };
      },
    };
  };
  const appliesNext = () => "Saved; it applies to the next review";

  const excludeErrors = pathExcludeErrors(draft.pathExcludes, errors);
  const instructionsLength = draft.customInstructions.length;
  const defaultProfile =
    profiles.find((p) => p.id === REPOSITORY_SETTING_DEFAULTS.profileId)?.name ?? "Standard";
  const reviewsOn = taskTypeOn(taskTypes, "review", typesDraft.review);

  const reviewSection = (
    <SettingsSection
      id="review-settings"
      title="Review settings"
      showTitle={false}
      description="How pull and merge requests in this repository are reviewed, and whether Omniralph answers questions about it. Changes apply to the next review; queued and running reviews keep the settings they started with."
      headerControl={
        <TaskTypeSelect
          compact
          name="review"
          values={taskTypes}
          value={typesDraft.review}
          disabled={disabled}
          error={errors.review}
          onChange={(value) => setType("review", value)}
        />
      }
      confirm={{
        consequence:
          "New reviews, mentions and chat questions of this repository use these settings. Queued and running reviews keep the settings they started with.",
      }}
      {...section(REPOSITORY_SECTIONS.review, REVIEW_TASK_TYPES, appliesNext)}
    >
      {!reviewsOn && (
        <Muted className="settings-section-off">
          Reviews are off: pull and merge requests here aren&apos;t reviewed. The settings below are
          kept and apply once reviews are on.
        </Muted>
      )}
      <SettingsSubsection
        id="review-when"
        title="When"
        description="Which pull and merge request events start a review."
      >
        <SwitchField
          id="trigger-on-open"
          label="Review when opened"
          description={withDefault(
            "Review a pull or merge request when it's opened or marked ready for review.",
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
            "Review the new commits when it's pushed to.",
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
            "Also review draft pull requests and merge requests.",
            onOff(REPOSITORY_SETTING_DEFAULTS.triggers.drafts),
          )}
          checked={draft.drafts}
          disabled={disabled}
          onChange={(value) => set("drafts", value)}
        />
      </SettingsSubsection>

      <SettingsSubsection
        id="review-who"
        title="Who reviews"
        description={
          <>
            The profile trades review depth against token usage; the reviewers run in parallel and
            their findings are posted as one review.
            {isAdmin && (
              <>
                {" "}
                Edit the profiles themselves in{" "}
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
            aria-invalid={Boolean(errors.profileId)}
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
                    data-disabled={disabled ? "" : undefined}
                    // The radio in the row is the keyboard control; the row is a bigger target.
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
                    <td className="settings-profile-model">
                      <MonoValue value={profile.model} />
                    </td>
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
          <Muted>Default: {taskName(REPOSITORY_SETTING_DEFAULTS.reviewTaskIds[0])} only.</Muted>
          {reviewTasks.map((task) => (
            <div key={task.id} className="settings-check">
              <Checkbox
                id={`review-task-${task.id}`}
                checked={draft.reviewTaskIds.includes(task.id)}
                disabled={disabled}
                aria-invalid={Boolean(errors.reviewTaskIds)}
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
            "Merges the review tasks' findings that describe the same issue and writes the combined summary.",
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
        id="review-scope"
        title="Scope"
        description="What the reviewers skip, and what they should know about this repository."
      >
        <Field
          label="Path excludes"
          htmlFor="path-excludes"
          description="One glob per line. A pattern without / matches at any depth; a leading / anchors it to the repository root. Lock files, build output and generated files are always skipped. Default: not set."
        >
          <Textarea
            id="path-excludes"
            rows={4}
            disabled={disabled}
            error={excludeErrors.length > 0}
            aria-invalid={excludeErrors.length > 0}
            value={draft.pathExcludes}
            onChange={(e) => set("pathExcludes", e.target.value)}
            placeholder={"e.g. *.snap\n/docs/**\nsrc/**/*.generated.ts"}
            className="settings-mono"
          />
        </Field>
        {excludeErrors.map((message) => (
          <InlineError key={message} message={message} />
        ))}
        <Field
          label="Custom instructions"
          htmlFor="custom-instructions"
          description={`Added to every review prompt for this repository. ${instructionsLength.toLocaleString()} / ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString()} characters. Default: not set.`}
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

      <SettingsSubsection
        id="review-questions"
        title="Questions"
        description="Whether Omniralph answers questions about this repository."
      >
        <TaskTypeSelect
          name="query"
          values={taskTypes}
          value={typesDraft.query}
          disabled={disabled}
          error={errors.query}
          onChange={(value) => setType("query", value)}
        />
        {isAdmin && (
          <Muted>
            Change the organization&apos;s defaults in{" "}
            <Link href="/settings/harnesses" className="settings-link">
              Settings › Harnesses
            </Link>
            .
          </Muted>
        )}
      </SettingsSubsection>
    </SettingsSection>
  );

  const harnessOptions = React.useMemo(
    () =>
      agents.map((agent) => ({
        value: agent.id,
        label: agent.name,
        hint: agent.lastHeartbeatAt ? undefined : "Never seen",
      })),
    [agents],
  );
  const pinError =
    errors.pinnedHarnessIds ??
    Object.entries(errors).find(([key]) => key.startsWith("pinnedHarnessIds."))?.[1];

  const harnessesSection = (
    <SettingsSection
      id="harnesses"
      title="Harnesses"
      showTitle={false}
      description="Which harnesses run this repository's jobs: reviews, questions and coding. Newly pinned harnesses pre-clone the repository."
      {...section(REPOSITORY_SECTIONS.harnesses, [], (input) =>
        input.pinnedHarnessIds.some((id) => !settings.pinnedHarnessIds.includes(id))
          ? "Saved; newly pinned harnesses will pre-clone the repository"
          : "Saved; it applies to the next job",
      )}
    >
      <SettingsSubsection
        id="harnesses-pinning"
        title="Pinning"
        description="Only the pinned harnesses run this repository's jobs. Leave all unpinned to let any harness run them. Default: not set (any harness)."
      >
        {agents.length === 0 && draft.pinnedHarnessIds.length === 0 ? (
          <Muted>No harnesses are enrolled yet; any harness that enrolls can run jobs.</Muted>
        ) : (
          <Field
            label="Pinned harnesses"
            htmlFor="pinned-harnesses"
            description={
              draftValues.pinnedHarnessIds.length === 0
                ? "Any harness can run this repository's jobs."
                : draftValues.pinnedHarnessIds.length === 1
                  ? "Only the pinned harness runs this repository's jobs."
                  : `Only the ${draftValues.pinnedHarnessIds.length} pinned harnesses run this repository's jobs.`
            }
            error={pinError}
          >
            <MultiSelect
              id="pinned-harnesses"
              value={draft.pinnedHarnessIds}
              onChange={(value) => set("pinnedHarnessIds", value)}
              options={harnessOptions}
              disabled={disabled}
              placeholder="Any harness"
              searchPlaceholder="Search harnesses…"
              searchLabel="Search harnesses"
              staleMessage="It was revoked or deleted. It's kept until you remove it."
            />
          </Field>
        )}
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
              <MonoPath value={repository.fullPath} />
            </>
          }
          description="How this repository is reviewed and built."
          actions={
            <Button asChild variant="ghost" className="page-header-ghost">
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
          {tab === "settings" && reviewSection}
          {tab === "coding" && isAdmin && ralph && codingChoices && (
            <CodingSettingsSections
              repositoryId={repository.id}
              settings={ralph}
              choices={codingChoices}
              codingTasks={codingTasks}
              taskTypes={taskTypes}
            />
          )}
          {tab === "harnesses" && harnessesSection}
        </div>
      </main>
    </>
  );
}
