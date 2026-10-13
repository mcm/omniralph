"use client";

import * as React from "react";
import { Field, Input, Muted, NativeSelect, Switch, Textarea } from "@iamthemcmaster/ui";
import {
  DEFAULT_RALPH_SETTINGS,
  fieldErrors as toFieldErrors,
  MAX_APPEND_INSTRUCTION_LENGTH,
  MAX_FIX_ROUNDS,
  MAX_SETUP_COMMAND_LENGTH,
  MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
  RALPH_CODING_PATHS,
  RALPH_HISTORY_REWRITE_POLICIES,
  RalphSettingsInput,
  type FieldErrors,
  type RalphCodingPath,
  type RalphHistoryRewrite,
} from "@omniralph/shared";
import { SwitchField, type SettingsConfirmation } from "@/components/settings-card";
import { SettingsSection, SettingsSubsection } from "@/components/settings-section";
import { settingChanges, withDefault, withoutFieldErrors } from "@/lib/settings/changes";
import {
  CODING_PATH_LABELS,
  HISTORY_REWRITE_LABELS,
  pickKeys,
  CODING_TASKS_SECTIONS,
  RALPH_DEFAULT_TEXT,
  RALPH_REPOSITORY_DEFAULTS,
  ralphDraft,
  ralphSpecs,
  ralphValues,
  type RalphDraft,
} from "@/lib/settings/forms";
import { updateRalphSettings } from "./actions";
import { TaskPicker, type TaskChoiceOption } from "./task-picker";

/** The form's values: the saved settings, with empty text and lists for none. */
export type RalphSettingsValues = RalphSettingsInput;

/** The first error of a list field (`linearLabels` or `linearLabels.2`). */
function listError(errors: FieldErrors, field: string): string | undefined {
  return errors[field] ?? Object.entries(errors).find(([key]) => key.startsWith(`${field}.`))?.[1];
}

const onOff = RALPH_DEFAULT_TEXT.onOff;

/** Confirmation of a section that changes how runs work. */
const RUN_AFFECTING: SettingsConfirmation = {
  consequence:
    "Every Coding Tasks run in this repository picks these up with its next job, including runs in progress.",
};

/** Confirmation of the Danger zone. */
const DESTRUCTIVE: SettingsConfirmation = {
  consequence:
    "These decide when Coding Tasks may force-push and when it deletes branches. Runs in progress pick them up with their next job.",
};

/**
 * Repository › Settings › Coding Tasks (admin-only): opts the repository into Linear-driven
 * builds, says which Linear issues route to it and how its runs work. One section with one save,
 * in subsections (Routing, Agent, Verification, Pull requests, Linear), and a separate Danger
 * zone for the settings that force-push or delete branches. Both confirm their change list.
 */
export function CodingTasksSettingsSections({
  repositoryId,
  settings,
  codingTasks,
}: {
  repositoryId: string;
  settings: RalphSettingsValues;
  /** The coding tasks its story and request runs can use (built-in and the organization's). */
  codingTasks: { story: readonly TaskChoiceOption[]; request: readonly TaskChoiceOption[] };
}) {
  const saved = React.useMemo(() => ralphDraft(settings), [settings]);
  const [draft, setDraft] = React.useState(saved);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const set = <K extends keyof RalphDraft>(key: K, value: RalphDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const savedValues = ralphValues(saved);
  const draftValues = ralphValues(draft);
  const tasks = [...codingTasks.story, ...codingTasks.request];
  const specs = React.useMemo(
    () =>
      ralphSpecs(
        new Map([...codingTasks.story, ...codingTasks.request].map((t) => [t.id, t.name])),
      ),
    [codingTasks],
  );
  const taskName = (id: string) => tasks.find((t) => t.id === id)?.name ?? id;

  /** The props of the settings section saving `keys`. */
  const section = (keys: readonly (keyof RalphSettingsInput)[]) => ({
    changes: settingChanges(
      keys.map((key) => specs[key]),
      savedValues,
      draftValues,
    ),
    onDiscard: () => {
      setDraft((d) => ({ ...d, ...pickKeys(saved, keys) }));
      setErrors((e) => withoutFieldErrors(e, keys));
    },
    prepare: () => {
      // The saved settings with this card's changes only.
      const parsed = RalphSettingsInput.safeParse({
        ...savedValues,
        ...pickKeys(draftValues, keys),
      });
      if (!parsed.success) {
        setErrors((e) => ({ ...withoutFieldErrors(e, keys), ...toFieldErrors(parsed.error) }));
        return null;
      }
      return {
        action: () => updateRalphSettings(repositoryId, parsed.data),
        success: "Saved; it applies to the next job of every Coding Tasks run",
        onSuccess: () => setErrors((e) => withoutFieldErrors(e, keys)),
        onError: (result: { fieldErrors?: FieldErrors }) =>
          setErrors((e) => ({ ...e, ...result.fieldErrors })),
      };
    },
  });

  const textInput = (
    key: keyof RalphDraft & keyof RalphSettingsInput,
    id: string,
    label: string,
    hint: string,
    options: { placeholder?: string; mono?: boolean; required?: boolean } = {},
  ) => {
    const error = listError(errors, key);
    return (
      <Field
        label={label}
        htmlFor={id}
        description={hint}
        error={error}
        required={options.required}
      >
        <Input
          id={id}
          error={Boolean(error)}
          aria-invalid={Boolean(error)}
          value={String(draft[key])}
          onChange={(e) => set(key, e.target.value as never)}
          placeholder={options.placeholder}
          className={options.mono ? "settings-mono" : undefined}
        />
      </Field>
    );
  };

  const linesInput = (
    key: "verifyCommands" | "allowedTools" | "disallowedTools",
    id: string,
    label: string,
    hint: string,
    placeholder: string,
  ) => {
    const error = listError(errors, key);
    return (
      <Field label={label} htmlFor={id} description={hint} error={error}>
        <Textarea
          id={id}
          rows={3}
          aria-invalid={Boolean(error)}
          value={draft[key]}
          onChange={(e) => set(key, e.target.value)}
          placeholder={placeholder}
          className="settings-mono"
        />
      </Field>
    );
  };

  const numberInput = (
    key: "maxReviewRounds" | "maxFixRounds" | "unmergedBranchTimeoutMinutes",
    id: string,
    label: string,
    hint: string,
    max: number,
    min = 0,
    disabled = false,
  ) => (
    <Field label={label} htmlFor={id} description={hint} error={errors[key]}>
      <Input
        id={id}
        type="number"
        disabled={disabled}
        min={min}
        max={max}
        error={Boolean(errors[key])}
        aria-invalid={Boolean(errors[key])}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
      />
    </Field>
  );

  const switchInput = (
    key:
      | "ralphEnabled"
      | "runPrdQualityGates"
      | "openPullRequestEarly"
      | "respondToReviews"
      | "respondToCiFailures"
      | "cleanupMergedWorktrees"
      | "allowPreparation",
    id: string,
    label: string,
    hint: string,
    defaultValue: boolean,
  ) => (
    <SwitchField
      id={id}
      label={label}
      description={withDefault(hint, onOff(defaultValue))}
      checked={draft[key]}
      disabled={false}
      onChange={(value) => set(key, value)}
    />
  );

  const enabled = draft.ralphEnabled;

  return (
    <>
      <SettingsSection
        id="coding-tasks"
        title="Coding Tasks"
        showTitle={false}
        description={
          <>
            Build Linear issues delegated to the Omniralph app in this repository, story by story.
            A delegation goes to the first enabled repository that matches its{" "}
            <code>[repo=&lt;path&gt;]</code> tag, then its labels, project and team.
          </>
        }
        headerControl={
          <label className="settings-section-toggle" htmlFor="coding-tasks-enabled">
            <span>{enabled ? "On" : "Off"}</span>
            <Switch
              id="coding-tasks-enabled"
              checked={enabled}
              onCheckedChange={(value) => set("ralphEnabled", value)}
              aria-describedby="coding-tasks-enabled-hint"
            />
            <span id="coding-tasks-enabled-hint" className="sr-only">
              {withDefault(
                "Delegated Linear issues may build in this repository and push branches to it.",
                onOff(RALPH_REPOSITORY_DEFAULTS.ralphEnabled),
              )}
            </span>
          </label>
        }
        confirm={RUN_AFFECTING}
        {...section(CODING_TASKS_SECTIONS.codingTasks)}
      >
        {!enabled && (
          <Muted className="settings-section-off">
            Off: delegated Linear issues don&apos;t build here. Turn Coding Tasks on to choose
            which issues route to this repository and how they&apos;re built. The settings below
            are kept while it&apos;s off.
          </Muted>
        )}
        <div className="settings-section-subs" hidden={!enabled}>
          <SettingsSubsection
            id="coding-tasks-routing"
            title="Routing"
            description="Which delegated Linear issues build here. Any match routes the issue."
          >
            <div className="settings-row">
              {textInput(
                "linearLabels",
                "ralph-labels",
                "Linear labels",
                "Comma-separated. Default: none.",
                { placeholder: "e.g. backend, api" },
              )}
              {textInput(
                "linearProjectNames",
                "ralph-projects",
                "Linear projects",
                "Comma-separated project names. Default: none.",
                { placeholder: "e.g. Omniralph" },
              )}
              {textInput(
                "linearTeamKeys",
                "ralph-teams",
                "Linear team keys",
                "Comma-separated. Default: none.",
                { placeholder: "e.g. ENG, OPS" },
              )}
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-tasks-agent"
            title="Agent"
            description="How stories and requests are worked: which tasks, which model, what it's told and which tools it may use."
          >
            <Field
              label="Runs with"
              htmlFor="ralph-coding-path"
              description={withDefault(
                "Story and request tasks run the coding tasks below; legacy jobs run the original job pipeline.",
                RALPH_DEFAULT_TEXT.codingPath,
              )}
              error={errors.codingPath}
            >
              <NativeSelect
                id="ralph-coding-path"
                value={draft.codingPath}
                onChange={(e) => set("codingPath", e.target.value as RalphCodingPath)}
              >
                {RALPH_CODING_PATHS.map((path) => (
                  <option key={path} value={path}>
                    {CODING_PATH_LABELS[path]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {draft.codingPath === "tasks" && (
              <div className="settings-row">
                <TaskPicker
                  id="ralph-story-task"
                  label="Story task"
                  hint={withDefault(
                    "Works each delegated story.",
                    taskName(RALPH_REPOSITORY_DEFAULTS.storyTaskId),
                  )}
                  value={draft.storyTaskId}
                  choices={codingTasks.story}
                  disabled={false}
                  error={errors.storyTaskId}
                  onChange={(value) => set("storyTaskId", value)}
                />
                <TaskPicker
                  id="ralph-request-task"
                  label="Request task"
                  hint={withDefault(
                    "Handles mentions, chat, review findings, CI failures and fix commands.",
                    taskName(RALPH_REPOSITORY_DEFAULTS.requestTaskId),
                  )}
                  value={draft.requestTaskId}
                  choices={codingTasks.request}
                  disabled={false}
                  error={errors.requestTaskId}
                  onChange={(value) => set("requestTaskId", value)}
                />
              </div>
            )}
            <div className="settings-row">
              {textInput(
                "model",
                "ralph-model",
                "Model",
                withDefault("Claude model alias or ID.", RALPH_DEFAULT_TEXT.model),
                { mono: true, required: true },
              )}
              {textInput(
                "fallbackModel",
                "ralph-fallback-model",
                "Fallback model",
                "Used when the model is overloaded. Default: none.",
                { mono: true, placeholder: "e.g. sonnet" },
              )}
            </div>
            <Field
              label="Appended instruction"
              htmlFor="ralph-append-instruction"
              description={`Appended to every story and request prompt. At most ${MAX_APPEND_INSTRUCTION_LENGTH.toLocaleString()} characters. Default: none.`}
              error={errors.appendInstruction}
            >
              <Textarea
                id="ralph-append-instruction"
                rows={3}
                aria-invalid={Boolean(errors.appendInstruction)}
                value={draft.appendInstruction}
                onChange={(e) => set("appendInstruction", e.target.value)}
              />
            </Field>
            <div className="settings-row">
              {linesInput(
                "allowedTools",
                "ralph-allowed-tools",
                "Allowed tools",
                "One per line; can only narrow the policy. Empty for the whole policy. Default: empty.",
                "Read\nEdit\nBash(pnpm test:*)",
              )}
              {linesInput(
                "disallowedTools",
                "ralph-disallowed-tools",
                "Disallowed tools",
                "One per line; always denied. Default: none.",
                "WebFetch",
              )}
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-tasks-verification"
            title="Verification"
            description="The quality gates run after a session reports a story complete. A failing gate sends its output back for the next attempt."
          >
            {textInput(
              "setupCommand",
              "ralph-setup-command",
              "Setup command",
              `Runs once in each new branch worktree. At most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString()} characters. Default: none.`,
              { placeholder: "pnpm install --frozen-lockfile", mono: true },
            )}
            {linesInput(
              "verifyCommands",
              "ralph-verify-commands",
              "Verify commands",
              "One per line. Run for every story and request, before the PRD's gates. Default: none.",
              "pnpm typecheck\npnpm test",
            )}
            {switchInput(
              "runPrdQualityGates",
              "ralph-run-prd-gates",
              "Run the PRD's quality gates",
              "Also run the commands under the PRD's ## Quality Gates heading.",
              DEFAULT_RALPH_SETTINGS.runPrdQualityGates,
            )}
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-tasks-pull-requests"
            title="Pull requests"
            description="When the run's pull or merge request opens, and what Coding Tasks fixes on it before leaving it to a person."
          >
            {switchInput(
              "openPullRequestEarly",
              "ralph-open-pr-early",
              "Open the pull request early",
              "Open a draft after the first story is pushed; mark it ready when the run finishes.",
              DEFAULT_RALPH_SETTINGS.openPullRequestEarly,
            )}
            <div className="settings-pair">
              {switchInput(
                "respondToReviews",
                "ralph-respond-to-reviews",
                "Fix review findings",
                "Review findings and @bot requests on the pull request become requests.",
                DEFAULT_RALPH_SETTINGS.respondToReviews,
              )}
              {numberInput(
                "maxReviewRounds",
                "ralph-max-review-rounds",
                "Max review rounds",
                withDefault(`0–${MAX_FIX_ROUNDS}.`, RALPH_DEFAULT_TEXT.maxReviewRounds),
                MAX_FIX_ROUNDS,
                0,
                !draft.respondToReviews,
              )}
            </div>
            <div className="settings-pair">
              {switchInput(
                "respondToCiFailures",
                "ralph-respond-to-ci",
                "Fix failed CI",
                "A failed CI run on the head commit becomes a request with the failed jobs' logs.",
                DEFAULT_RALPH_SETTINGS.respondToCiFailures,
              )}
              {numberInput(
                "maxFixRounds",
                "ralph-max-fix-rounds",
                "Max CI fix rounds",
                withDefault(`0–${MAX_FIX_ROUNDS}.`, RALPH_DEFAULT_TEXT.maxFixRounds),
                MAX_FIX_ROUNDS,
                0,
                !draft.respondToCiFailures,
              )}
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-tasks-linear"
            title="Linear"
            description="How Coding Tasks reads and updates the epic."
          >
            {textInput(
              "manualLabels",
              "ralph-manual-labels",
              "Manual labels",
              withDefault(
                "Comma-separated. Stories with these labels are steps for a person; Coding Tasks waits for them.",
                RALPH_DEFAULT_TEXT.manualLabels,
              ),
              { placeholder: "e.g. manual" },
            )}
            {switchInput(
              "allowPreparation",
              "ralph-allow-preparation",
              "Offer to run preparation",
              "Ask whether to run a manual story's cyralph-prepare commands. Off, they're plain text.",
              DEFAULT_RALPH_SETTINGS.allowPreparation,
            )}
            {textInput(
              "epicCompletedState",
              "ralph-epic-completed-state",
              "Epic completed state",
              "Move the epic here when every story is complete: a state name, or started / completed. Empty leaves it alone. Default: empty.",
              { placeholder: "e.g. In Review" },
            )}
          </SettingsSubsection>
        </div>
      </SettingsSection>

      <SettingsSection
        id="danger-zone"
        title="Danger zone"
        tone="danger"
        description="Settings that rewrite history or delete branches. Saving them always asks first."
        confirm={DESTRUCTIVE}
        {...section(CODING_TASKS_SECTIONS.danger)}
      >
        <SettingsSubsection
          id="danger-history"
          title="History rewrites"
          description="Force-pushing the run's branch."
        >
          <Field
            label="Allow rebase and force-push"
            htmlFor="ralph-history-rewrite"
            description={withDefault(
              "Whether a request may rebase and push with --force-with-lease when someone asks for it.",
              RALPH_DEFAULT_TEXT.historyRewrite,
            )}
            error={errors.historyRewrite}
          >
            <NativeSelect
              id="ralph-history-rewrite"
              value={draft.historyRewrite}
              onChange={(e) => set("historyRewrite", e.target.value as RalphHistoryRewrite)}
            >
              {RALPH_HISTORY_REWRITE_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {HISTORY_REWRITE_LABELS[policy]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </SettingsSubsection>
        <SettingsSubsection
          id="danger-cleanup"
          title="Branch cleanup"
          description="Deleting worktrees and branches once a pull request is done."
        >
          {switchInput(
            "cleanupMergedWorktrees",
            "ralph-cleanup",
            "Clean up after the merge",
            "Remove the worktree and local branch once the pull request merges. Leftover stashes and unmerged commits are offered to a person first; a request closed without merging only loses its worktree.",
            DEFAULT_RALPH_SETTINGS.cleanupMergedWorktrees,
          )}
          {numberInput(
            "unmergedBranchTimeoutMinutes",
            "ralph-unmerged-timeout",
            "Delete unanswered unmerged branches after (minutes)",
            withDefault(
              `A branch with unmerged commits is deleted after this long without an answer (1–${MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES.toLocaleString()}).`,
              RALPH_DEFAULT_TEXT.unmergedBranchTimeoutMinutes,
            ),
            MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
            1,
          )}
        </SettingsSubsection>
      </SettingsSection>
    </>
  );
}
