"use client";

import * as React from "react";
import { Field, Input, NativeSelect, Textarea } from "@iamthemcmaster/ui";
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
import { SettingsCard, SwitchField, type SettingsConfirmation } from "@/components/settings-card";
import { settingChanges, withDefault, withoutFieldErrors } from "@/lib/settings/changes";
import {
  CODING_PATH_LABELS,
  HISTORY_REWRITE_LABELS,
  pickKeys,
  RALPH_CARDS,
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

/** Confirmation of a card that changes how runs work. */
const RUN_AFFECTING: SettingsConfirmation = {
  consequence:
    "Every run of this repository picks these up with its next job, including runs in progress.",
};

/**
 * Repository › Settings › Ralph (admin-only): says which Linear issues route
 * to the repository (coding itself is switched under Task types) and how its runs
 * work (cyralph's per-repository settings), grouped as Verification, Prompt
 * and model, Tools, PR follow-up and Linear. Each card saves on its own; the
 * ones that change what runs do (coding path, verification, model,
 * tools) confirm their change list first.
 */
export function RalphSettingsSection({
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

  /** The props of the settings card saving `keys`. */
  const card = (keys: readonly (keyof RalphSettingsInput)[]) => ({
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
        success: "Ralph settings saved; they apply to the next job of every run",
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
  ) => (
    <Field label={label} htmlFor={id} description={hint} error={errors[key]}>
      <Input
        id={id}
        type="number"
        className="input-number"
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
      | "runPrdQualityGates"
      | "openPullRequestEarly"
      | "respondToReviews"
      | "respondToCiFailures"
      | "cleanupMergedWorktrees"
      | "allowPreparation",
    id: string,
    label: string,
    hint: string,
    defaultValue: boolean | string,
  ) => (
    <SwitchField
      id={id}
      label={label}
      description={withDefault(
        hint,
        typeof defaultValue === "string" ? defaultValue : onOff(defaultValue),
      )}
      checked={draft[key]}
      disabled={false}
      onChange={(value) => set(key, value)}
    />
  );

  return (
    <>
      <SettingsCard
        title="Ralph"
        description={
          <>
            How Linear issues delegated to the Omniralph app are built here, story by story, once
            coding is on under Task types. A delegation goes to the first repository with coding on
            that matches its <code>[repo=&lt;path&gt;]</code> tag, then its labels, project and
            team.
          </>
        }
        confirm={RUN_AFFECTING}
        {...card(RALPH_CARDS.ralph)}
      >
        <Field
          label="Coding path"
          htmlFor="ralph-coding-path"
          description={withDefault(
            "How runs work stories and requests: the legacy Ralph jobs, or coding runs of the story and request tasks below.",
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
        <div className="settings-row">
          <TaskPicker
            id="ralph-story-task"
            label="Story task"
            hint={withDefault(
              "The coding task that works delegated stories on the coding-tasks path.",
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
              "The coding task that handles requests (mentions, chat, review findings, CI failures, fix commands) on the coding-tasks path.",
              taskName(RALPH_REPOSITORY_DEFAULTS.requestTaskId),
            )}
            value={draft.requestTaskId}
            choices={codingTasks.request}
            disabled={false}
            error={errors.requestTaskId}
            onChange={(value) => set("requestTaskId", value)}
          />
        </div>
        {textInput(
          "linearLabels",
          "ralph-labels",
          "Linear labels",
          withDefault("Comma-separated. Issues with any of these labels route here."),
          { placeholder: "e.g. backend, api" },
        )}
        {textInput(
          "linearProjectNames",
          "ralph-projects",
          "Linear projects",
          withDefault("Comma-separated project names."),
          { placeholder: "e.g. Omniralph" },
        )}
        {textInput(
          "linearTeamKeys",
          "ralph-teams",
          "Linear team keys",
          withDefault("Comma-separated team keys."),
          { placeholder: "e.g. ENG, OPS" },
        )}
      </SettingsCard>

      <SettingsCard
        title="Ralph › Verification"
        description="The quality gates the job runs after a story's session reports it complete; a failing gate sends its output back for the next attempt."
        confirm={RUN_AFFECTING}
        {...card(RALPH_CARDS.verification)}
      >
        {linesInput(
          "verifyCommands",
          "ralph-verify-commands",
          "Verify commands",
          withDefault(
            "One per line. Run as quality gates for every story and request in this repository, before the PRD's.",
          ),
          "e.g. pnpm typecheck\npnpm test",
        )}
        {switchInput(
          "runPrdQualityGates",
          "ralph-run-prd-gates",
          "Run the PRD's quality gates",
          "Also run the commands under the PRD's ## Quality Gates heading. A single issue only runs the verify commands.",
          DEFAULT_RALPH_SETTINGS.runPrdQualityGates,
        )}
        {textInput(
          "setupCommand",
          "ralph-setup-command",
          "Setup command",
          withDefault(
            `Runs once in a new branch worktree, e.g. to install dependencies. At most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString()} characters.`,
          ),
          { placeholder: "e.g. pnpm install --frozen-lockfile", mono: true },
        )}
      </SettingsCard>

      <SettingsCard
        title="Ralph › Prompt and model"
        description="What the Claude sessions are told and which model runs them."
        confirm={RUN_AFFECTING}
        {...card(RALPH_CARDS.prompt)}
      >
        <Field
          label="Appended instruction"
          htmlFor="ralph-append-instruction"
          description={withDefault(
            `Appended to every story and request prompt. At most ${MAX_APPEND_INSTRUCTION_LENGTH.toLocaleString()} characters.`,
          )}
          error={errors.appendInstruction}
        >
          <Textarea
            id="ralph-append-instruction"
            rows={4}
            aria-invalid={Boolean(errors.appendInstruction)}
            value={draft.appendInstruction}
            onChange={(e) => set("appendInstruction", e.target.value)}
          />
        </Field>
        <div className="settings-row">
          {textInput(
            "model",
            "ralph-model",
            "Model",
            withDefault("Claude model alias or ID the sessions use.", RALPH_DEFAULT_TEXT.model),
            { mono: true, required: true },
          )}
          {textInput(
            "fallbackModel",
            "ralph-fallback-model",
            "Fallback model",
            withDefault("Used when the model is overloaded. Leave it empty for no fallback."),
            { mono: true, placeholder: "e.g. sonnet" },
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Ralph › Tools"
        description="Agent SDK tools or permission rules, one per line. They can only narrow Ralph's tool policy, never widen it."
        confirm={RUN_AFFECTING}
        {...card(RALPH_CARDS.tools)}
      >
        {linesInput(
          "allowedTools",
          "ralph-allowed-tools",
          "Allowed tools",
          withDefault(
            "Leave it empty for Ralph's whole policy. Otherwise only these tools are available, and only calls matching these rules run.",
          ),
          "e.g. Read\nEdit\nBash(pnpm test:*)",
        )}
        {linesInput(
          "disallowedTools",
          "ralph-disallowed-tools",
          "Disallowed tools",
          withDefault("Always denied, on top of Ralph's policy."),
          "e.g. WebFetch",
        )}
      </SettingsCard>

      <SettingsCard
        title="Ralph › PR follow-up"
        description="The run's pull or merge request: when it opens, and how Ralph looks after it (reviews, CI and cleanup after the merge)."
        {...card(RALPH_CARDS.followUp)}
      >
        {switchInput(
          "openPullRequestEarly",
          "ralph-open-pr-early",
          "Open the pull request early",
          "Open a draft pull or merge request after the first story is pushed, and mark it ready when the run finishes.",
          DEFAULT_RALPH_SETTINGS.openPullRequestEarly,
        )}
        <Field
          label="History rewrites"
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
        {switchInput(
          "respondToReviews",
          "ralph-respond-to-reviews",
          "Fix review findings",
          "Omniralph's review findings and @bot requests on the run's pull or merge request become requests Ralph works on.",
          DEFAULT_RALPH_SETTINGS.respondToReviews,
        )}
        {numberInput(
          "maxReviewRounds",
          "ralph-max-review-rounds",
          "Max review rounds",
          withDefault(
            `Reviews acted on per pull or merge request before Ralph leaves it to a person (0–${MAX_FIX_ROUNDS}).`,
            RALPH_DEFAULT_TEXT.maxReviewRounds,
          ),
          MAX_FIX_ROUNDS,
        )}
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
          withDefault(
            `Failed CI runs acted on per pull or merge request (0–${MAX_FIX_ROUNDS}).`,
            RALPH_DEFAULT_TEXT.maxFixRounds,
          ),
          MAX_FIX_ROUNDS,
        )}
        {switchInput(
          "cleanupMergedWorktrees",
          "ralph-cleanup",
          "Clean up after the merge",
          "Remove the worktree and local branch once the pull or merge request merges. Leftover stashes and unmerged commits are offered to a person first. A request closed without merging, or a stopped run, only has its worktree removed: the branch stays.",
          DEFAULT_RALPH_SETTINGS.cleanupMergedWorktrees,
        )}
        {numberInput(
          "unmergedBranchTimeoutMinutes",
          "ralph-unmerged-timeout",
          "Unmerged branch timeout (minutes)",
          withDefault(
            "A branch with unmerged commits is deleted after this long without an answer.",
            RALPH_DEFAULT_TEXT.unmergedBranchTimeoutMinutes,
          ),
          MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
          1,
        )}
      </SettingsCard>

      <SettingsCard
        title="Ralph › Linear"
        description="How Ralph reads and updates the Linear epic."
        {...card(RALPH_CARDS.linear)}
      >
        {textInput(
          "manualLabels",
          "ralph-manual-labels",
          "Manual labels",
          withDefault(
            "Comma-separated. Stories with any of these labels are steps for a person: Ralph skips them and waits until they're done. The first one labels the manual stories and follow-ups Ralph files.",
            RALPH_DEFAULT_TEXT.manualLabels,
          ),
          { placeholder: "e.g. manual" },
        )}
        {switchInput(
          "allowPreparation",
          "ralph-allow-preparation",
          "Offer to run preparation",
          "Ask whether to run a manual story's cyralph-prepare commands (“Run it”). Off, those blocks are plain text.",
          DEFAULT_RALPH_SETTINGS.allowPreparation,
        )}
        {textInput(
          "epicCompletedState",
          "ralph-epic-completed-state",
          "Epic completed state",
          withDefault(
            "When every story of an epic is complete, move the epic to this state: a state name, or started / completed for the first state of that type. Not set leaves the epic alone.",
          ),
          { placeholder: "e.g. In Review" },
        )}
      </SettingsCard>
    </>
  );
}
