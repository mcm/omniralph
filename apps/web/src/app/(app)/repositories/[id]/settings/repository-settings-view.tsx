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
import { IconAdjustments, IconExternalLink } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  RepositorySettingsInput,
  type FieldErrors,
} from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { PageHeader } from "@/components/page-header";
import { SettingsCard, SwitchField } from "@/components/settings-card";
import {
  formatSettingValue,
  settingChanges,
  withDefault,
  withoutFieldErrors,
} from "@/lib/settings/changes";
import {
  pickKeys,
  REPOSITORY_CARDS,
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
import { ProfileFacts, type ProfileSummary } from "../../../settings/profiles/profile-facts";
import { updateRepositorySettings } from "./actions";
import { RalphSettingsSection, type RalphSettingsValues } from "./ralph-settings-section";
import { TaskPicker, type TaskChoiceOption } from "./task-picker";

interface RepositorySettingsViewProps {
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

  /** The props of the settings card saving `keys`. */
  const card = (
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

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository.fullPath },
          { label: "Settings" },
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
          description="How this repository is reviewed. Changes apply to the next review; queued and running reviews keep the settings they started with."
          actions={
            <Button asChild variant="ghost">
              <a href={repository.webUrl} target="_blank" rel="noreferrer">
                <IconExternalLink size={14} />
                Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
              </a>
            </Button>
          }
        />

        <RepositoryNav repositoryId={repository.id} current="settings" />

        {!isAdmin && <Muted>Only admins can change repository settings.</Muted>}

        <SettingsCard
          title="Review profile"
          description={
            <>
              Trade review depth against token usage. Default: {defaultProfile}.
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
          confirm={{
            consequence:
              "The next review of this repository uses the new profile's model, token cap and file limit. Queued and running reviews keep the profile they started with.",
          }}
          {...card(REPOSITORY_CARDS.profile, appliesNext)}
        >
          <RadioGroup
            value={draft.profileId}
            onValueChange={(value) => set("profileId", value)}
            disabled={disabled}
            aria-label="Review profile"
            className="settings-profile-choices"
          >
            {profiles.map((profile) => (
              <label
                key={profile.id}
                htmlFor={`profile-${profile.id}`}
                className="settings-profile-choice"
                data-selected={profile.id === draft.profileId ? "" : undefined}
              >
                <RadioGroupItem id={`profile-${profile.id}`} value={profile.id} />
                <Stack gap={2} className="settings-profile-text">
                  <span className="settings-profile-name">
                    <IconAdjustments size={14} />
                    {profile.name}
                  </span>
                  {profile.description && <Muted>{profile.description}</Muted>}
                  <ProfileFacts profile={profile} />
                </Stack>
              </label>
            ))}
          </RadioGroup>
          <InlineError message={errors.profileId} />
        </SettingsCard>

        <SettingsCard
          title="Review tasks"
          description="Which reviewers run on each pull or merge request. They run in parallel and their findings are posted as one review."
          {...card(REPOSITORY_CARDS.tasks, appliesNext)}
        >
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
          </div>
          <InlineError message={errors.reviewTaskIds} />
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
        </SettingsCard>

        <SettingsCard
          title="Triggers"
          description="When pull and merge requests are reviewed automatically."
          {...card(REPOSITORY_CARDS.triggers, appliesNext)}
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
        </SettingsCard>

        <SettingsCard
          title="Files and instructions"
          description="Skip files that don't need review, and tell the reviewer about this repository's conventions."
          {...card(REPOSITORY_CARDS.files, appliesNext)}
        >
          <Field
            label="Path excludes"
            htmlFor="path-excludes"
            description="One glob per line. A pattern without / matches at any depth; a leading / anchors it to the repository root. Lock files, build output and generated files are always skipped. Default: none."
          >
            <Textarea
              id="path-excludes"
              rows={5}
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
            description={`Added to every review prompt for this repository. ${instructionsLength.toLocaleString()} / ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString()} characters. Default: none.`}
            error={errors.customInstructions}
          >
            <Textarea
              id="custom-instructions"
              rows={6}
              disabled={disabled}
              error={Boolean(errors.customInstructions)}
              aria-invalid={Boolean(errors.customInstructions)}
              value={draft.customInstructions}
              onChange={(e) => set("customInstructions", e.target.value)}
              placeholder="e.g. We use Result types instead of exceptions; flag thrown errors in src/core."
            />
          </Field>
        </SettingsCard>

        <SettingsCard
          title="Harness pinning"
          description="Only the selected harnesses run this repository's jobs. Leave all unselected to let any harness run them. Newly pinned harnesses pre-clone the repository. Default: none selected."
          {...card(REPOSITORY_CARDS.pinning, (input) =>
            input.pinnedHarnessIds.some((id) => !settings.pinnedHarnessIds.includes(id))
              ? "Saved; newly pinned harnesses will pre-clone the repository"
              : "Saved; it applies to the next review",
          )}
        >
          {agents.length === 0 ? (
            <Muted>No harnesses are enrolled yet; any harness that enrolls can run reviews.</Muted>
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
          {draftValues.pinnedHarnessIds.length === 0 && (
            <Muted>Any harness can run this repository&apos;s jobs.</Muted>
          )}
          <InlineError
            message={
              errors.pinnedHarnessIds ??
              Object.entries(errors).find(([key]) => key.startsWith("pinnedHarnessIds."))?.[1]
            }
          />
        </SettingsCard>

        {isAdmin && ralph && (
          <RalphSettingsSection
            repositoryId={repository.id}
            settings={ralph}
            codingTasks={codingTasks}
          />
        )}
      </main>
    </>
  );
}
