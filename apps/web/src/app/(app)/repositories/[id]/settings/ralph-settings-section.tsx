"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { Button, Field, Input, Muted, NativeSelect, Textarea } from "@iamthemcmaster/ui";
import {
  CLAUDE_CODE_TOOLS,
  DEFAULT_RALPH_SETTINGS,
  DEFAULT_BLOCKED_LABELS,
  fieldErrors as toFieldErrors,
  MAX_APPEND_INSTRUCTION_LENGTH,
  MAX_FIX_ROUNDS,
  MAX_SETUP_COMMAND_LENGTH,
  MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
  RALPH_HISTORY_REWRITE_POLICIES,
  RalphSettingsInput,
  RepositoryTaskTypesInput,
  type FieldErrors,
  type RalphHistoryRewrite,
} from "@omniralph/shared";
import {
  ModelPicker,
  NOT_AVAILABLE,
  StaleNote,
  TagInput,
  type ModelOption,
  type TagOption,
} from "@/components/pickers";
import { SwitchField, type SettingsConfirmation } from "@/components/settings-card";
import { SettingsSection, SettingsSubsection } from "@/components/settings-section";
import { useApiAction } from "@/components/use-api-action";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { api } from "@/lib/api/client";
import { mutationResultSchema } from "@/lib/api/schemas";
import type { LinearSettingsOptions } from "@/lib/linear/settings-values";
import { settingChanges, withDefault, withoutFieldErrors } from "@/lib/settings/changes";
import {
  CODING_SECTIONS,
  HISTORY_REWRITE_LABELS,
  pickKeys,
  RALPH_DEFAULT_TEXT,
  RALPH_REPOSITORY_DEFAULTS,
  ralphDraft,
  ralphSpecs,
  ralphValues,
  type RalphDraft,
} from "@/lib/settings/forms";
import { repositoryChanged } from "../repository-queries";
import { TaskPicker, type TaskChoiceOption } from "./task-picker";
import {
  saveWithTaskTypes,
  TaskTypeSelect,
  taskTypeOn,
  taskTypeSpec,
  type TaskTypeSwitch,
  type TaskTypesValues,
} from "./task-types";

/** The form's values: the saved settings, with empty text and lists for none. */
export type RalphSettingsValues = RalphSettingsInput;

/**
 * The organization's Linear workspace the Linear fields pick from: its values when connected,
 * else the fields show the saved values read-only (`disconnected`: no workspace connected,
 * `unavailable`: it couldn't be read).
 */
export type CodingLinearChoices =
  | { status: "connected"; options: LinearSettingsOptions }
  | { status: "disconnected" }
  | { status: "unavailable" };

/** Where the Coding tab's pickers get their choices. */
export interface CodingChoices {
  linear: CodingLinearChoices;
  /** The models the harnesses that may run the repository's coding jobs report. */
  models: ModelOption[];
  /** How many harnesses those are. */
  harnessCount: number;
  /** Whether they're the repository's pinned harnesses (else every harness accepting coding). */
  pinned: boolean;
  /** The organization's routing rules that target the repository: number and condition in words. */
  routingRules: ReadonlyArray<{ number: number; summary: string }>;
}

/** Built-in Claude Code tools, suggested by the tool fields (rules can still be typed). */
const TOOL_OPTIONS: readonly string[] = CLAUDE_CODE_TOOLS;

/** The Linear list fields, picked from the workspace. */
type LinearListKey = "manualLabels" | "blockedLabels";

/** The workspace's labels and any default blocked label it doesn't have (ignoring case). */
function withDefaultLabels(labels: readonly string[]): string[] {
  const have = new Set(labels.map((label) => label.toLowerCase()));
  return [...labels, ...DEFAULT_BLOCKED_LABELS.filter((label) => !have.has(label))];
}

/** Why the Linear fields are read-only, with where to fix it. */
function LinearReadOnlyNote({
  linear,
  onRetry,
}: {
  linear: CodingLinearChoices;
  /** Reads the workspace again (after it couldn't be read). */
  onRetry?: () => void;
}) {
  if (linear.status === "connected") return null;
  return (
    <Muted className="settings-note">
      {linear.status === "disconnected" ? (
        <>
          Linear isn&apos;t connected, so these show the saved values read-only. Connect it in{" "}
          <Link href="/settings/integrations">Settings › Integrations</Link> to change them.
        </>
      ) : (
        <>
          Your Linear workspace couldn&apos;t be read just now, so these show the saved values
          read-only.{" "}
          {onRetry && (
            <>
              <Button type="button" variant="link" size="sm" onClick={onRetry}>
                Try again
              </Button>
              , or check
            </>
          )}
          {!onRetry && "Check"} the connection in{" "}
          <Link href="/settings/integrations">Settings › Integrations</Link>.
        </>
      )}
    </Muted>
  );
}

/** The first error of a list field (`manualLabels` or `manualLabels.2`). */
function listError(errors: FieldErrors, field: string): string | undefined {
  return errors[field] ?? Object.entries(errors).find(([key]) => key.startsWith(`${field}.`))?.[1];
}

const onOff = RALPH_DEFAULT_TEXT.onOff;

/** Confirmation of the section that changes how runs work. */
const RUN_AFFECTING: SettingsConfirmation = {
  consequence:
    "Every run of this repository picks these up with its next job, including runs in progress.",
};

/** Confirmation of the Danger zone. */
const DESTRUCTIVE: SettingsConfirmation = {
  consequence:
    "These decide when a run may force-push and when Omniralph deletes branches. Runs in progress pick them up with their next job.",
};

/** The task-type switch the Coding section saves. */
const CODING_TASK_TYPES = ["coding"] as const satisfies readonly TaskTypeSwitch[];

/**
 * Repository › Coding (admin-only): whether coding runs here (the task-type switch beside the
 * description), the routing rules that target it (edited on Settings › Routing) and how its runs
 * work (cyralph's per-repository settings). One section with one save, in subsections (Routing,
 * Agent, Verification, Pull requests, Linear), and a separate Danger zone for the settings that
 * force-push or delete branches. Both confirm their change list.
 */
export function CodingSettingsSections({
  repositoryId,
  settings,
  choices,
  codingTasks,
  taskTypes,
  onRetryLinear,
}: {
  repositoryId: string;
  settings: RalphSettingsValues;
  /** The Linear values and models the pickers offer. */
  choices: CodingChoices;
  /** The coding tasks its story and request runs can use (built-in and the organization's). */
  codingTasks: { story: readonly TaskChoiceOption[]; request: readonly TaskChoiceOption[] };
  /** The repository's task-type switches; this tab saves Coding's. */
  taskTypes: TaskTypesValues;
  /** Reads the Linear workspace again, when it couldn't be read. */
  onRetryLinear?: () => void;
}) {
  const apiAction = useApiAction();
  const saved = React.useMemo(() => ralphDraft(settings), [settings]);
  // Seeded from the (polled) settings; a refetch re-seeds them only while they aren't edited.
  const [draft, setDraft] = useSeededDraft(saved);
  const [coding, setCoding] = useSeededDraft(taskTypes.overrides.coding);
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

  /** The props of the section saving `keys` and the task-type switches `types`. */
  const section = (
    keys: readonly (keyof RalphSettingsInput)[],
    types: readonly TaskTypeSwitch[] = [],
  ) => {
    const typesDraft = { ...taskTypes.overrides, coding };
    const errorKeys = [...keys, ...types];
    const settingsChanges = settingChanges(
      keys.map((key) => specs[key]),
      savedValues,
      draftValues,
    );
    return {
      changes: [
        ...settingChanges(
          types.map((key) => taskTypeSpec(taskTypes, key)),
          taskTypes.overrides,
          typesDraft,
        ),
        ...settingsChanges,
      ],
      onDiscard: () => {
        setDraft((d) => ({ ...d, ...pickKeys(saved, keys) }));
        if (types.length > 0) setCoding(taskTypes.overrides.coding);
        setErrors((e) => withoutFieldErrors(e, errorKeys));
      },
      prepare: () => {
        // The saved settings with this section's changes only.
        const parsed = RalphSettingsInput.safeParse({
          ...savedValues,
          ...pickKeys(draftValues, keys),
        });
        const parsedTypes = RepositoryTaskTypesInput.safeParse(typesDraft);
        if (!parsed.success || !parsedTypes.success) {
          setErrors((e) => ({
            ...withoutFieldErrors(e, errorKeys),
            ...(parsed.success ? {} : toFieldErrors(parsed.error)),
            ...(parsedTypes.success ? {} : toFieldErrors(parsedTypes.error)),
          }));
          return null;
        }
        return {
          // The switches, then the settings; the page refetches once, after both.
          action: () =>
            apiAction(
              saveWithTaskTypes(
                repositoryId,
                taskTypes.overrides,
                parsedTypes.data,
                types,
                settingsChanges.length > 0
                  ? ({ organizationId }) =>
                      api.put(`/api/ui/repositories/${repositoryId}/coding`, mutationResultSchema, {
                        body: parsed.data,
                        organizationId,
                      })
                  : null,
              ),
              repositoryChanged,
            ),
          success: "Coding settings saved; they apply to the next job of every run",
          onSuccess: () => setErrors((e) => withoutFieldErrors(e, errorKeys)),
          onError: (result: { fieldErrors?: FieldErrors }) =>
            setErrors((e) => ({ ...e, ...result.fieldErrors })),
        };
      },
    };
  };

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

  const linear = choices.linear;
  const linearOptions = linear.status === "connected" ? linear.options : null;
  const linearListOptions: Record<LinearListKey, readonly (string | TagOption)[]> = {
    manualLabels: linearOptions?.labels ?? [],
    // The defaults are always offered (and accepted), so they aren't drawn as stale.
    blockedLabels: linearOptions ? withDefaultLabels(linearOptions.labels) : [],
  };

  /** A Linear list as chips from the workspace, or its saved values read-only without one. */
  const linearTags = (
    key: LinearListKey,
    id: string,
    label: string,
    hint: string,
    placeholder: string,
  ) => {
    const error = listError(errors, key);
    const readOnly = !linearOptions;
    return (
      <Field label={label} htmlFor={id} description={hint} error={error}>
        <TagInput
          id={id}
          value={draft[key]}
          onChange={(value) => set(key, value)}
          // Read-only, the saved values are its options so none is drawn as stale.
          options={readOnly ? draft[key] : linearListOptions[key]}
          disabled={readOnly}
          placeholder={readOnly ? "None" : placeholder}
          staleMessage="It's no longer in your Linear workspace (renamed or deleted). It's kept until you remove it."
        />
      </Field>
    );
  };

  /** A tool list: suggestions from Claude Code's tools, and any rule typed in. */
  const toolTags = (
    key: "allowedTools" | "disallowedTools",
    id: string,
    label: string,
    hint: string,
    placeholder: string,
  ) => {
    const error = listError(errors, key);
    return (
      <Field label={label} htmlFor={id} description={hint} error={error}>
        <TagInput
          id={id}
          value={draft[key]}
          onChange={(value) => set(key, value)}
          options={TOOL_OPTIONS}
          allowCustom
          placeholder={placeholder}
          className="settings-mono"
        />
      </Field>
    );
  };

  const linesInput = (
    key: "verifyCommands",
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

  const codingOn = taskTypeOn(taskTypes, "coding", coding);
  const modelSource = choices.pinned
    ? "the repository's pinned harnesses"
    : "the harnesses that accept coding";

  return (
    <>
      <SettingsSection
        id="coding"
        title="Coding"
        showTitle={false}
        description={
          <>
            Build Linear issues delegated to the Omniralph app in this repository, story by story.
            The organization&apos;s routing rules decide which issues build here.
          </>
        }
        headerControl={
          <TaskTypeSelect
            compact
            name="coding"
            values={taskTypes}
            value={coding}
            disabled={false}
            error={errors.coding}
            onChange={setCoding}
          />
        }
        confirm={RUN_AFFECTING}
        {...section(CODING_SECTIONS.coding, CODING_TASK_TYPES)}
      >
        {!codingOn && (
          <Muted className="settings-section-off">
            Coding is off: delegated Linear issues don&apos;t build here. Issues the routing rules
            send here are treated as manual until it&apos;s on. The settings below are kept while
            it&apos;s off.
          </Muted>
        )}
        <div hidden={!codingOn}>
          <SettingsSubsection
            id="coding-routing"
            title="Routing"
            description={
              <>
                The organization&apos;s rules that route issues here. The first rule an issue
                matches wins; edit them in <Link href="/settings/routing">Settings › Routing</Link>.
              </>
            }
          >
            {choices.routingRules.length > 0 ? (
              <ol className="settings-routing-rules" aria-label="Routing rules for this repository">
                {choices.routingRules.map((rule) => (
                  <li key={rule.number}>
                    <span className="settings-routing-rule-number">Rule {rule.number}</span>{" "}
                    {rule.summary}
                  </li>
                ))}
              </ol>
            ) : (
              <Muted className="settings-note">
                No routing rule targets this repository. Issues still build here when you choose it
                for them, or as sub-issues and follow-ups of issues built here.
              </Muted>
            )}
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-agent"
            title="Agent"
            description="How stories and requests are worked: which tasks, which model, what the sessions are told and which tools they may use."
          >
            <div className="settings-row">
              <TaskPicker
                id="ralph-story-task"
                label="Story task"
                hint={withDefault(
                  "The coding task that works delegated stories.",
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
                  "The coding task that handles requests (mentions, chat, review findings, CI failures, fix commands).",
                  taskName(RALPH_REPOSITORY_DEFAULTS.requestTaskId),
                )}
                value={draft.requestTaskId}
                choices={codingTasks.request}
                disabled={false}
                error={errors.requestTaskId}
                onChange={(value) => set("requestTaskId", value)}
              />
            </div>
            {choices.harnessCount === 0 && (
              <Muted className="settings-note">
                No active harness accepts coding jobs, so there are no models to choose from. Let a
                harness accept Coding in its settings, or pin one under Harnesses.
              </Muted>
            )}
            <div className="settings-row">
              <Field
                label="Model"
                description={withDefault(
                  `The model the sessions use, from those ${modelSource} report.`,
                  RALPH_DEFAULT_TEXT.model,
                )}
                error={errors.model}
                required
              >
                <ModelPicker
                  id="ralph-model"
                  value={draft.model}
                  onChange={(value) => set("model", value ?? "")}
                  options={choices.models}
                  harnessCount={choices.harnessCount}
                />
              </Field>
              <Field
                label="Fallback model"
                description={withDefault(
                  "Used when the model is overloaded. None runs without a fallback.",
                )}
                error={errors.fallbackModel}
              >
                <ModelPicker
                  id="ralph-fallback-model"
                  value={draft.fallbackModel}
                  onChange={(value) => set("fallbackModel", value ?? "")}
                  options={choices.models}
                  harnessCount={choices.harnessCount}
                  allowNone
                  noneLabel="None"
                />
              </Field>
            </div>
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
                rows={3}
                aria-invalid={Boolean(errors.appendInstruction)}
                value={draft.appendInstruction}
                onChange={(e) => set("appendInstruction", e.target.value)}
              />
            </Field>
            <div className="settings-row">
              {toolTags(
                "allowedTools",
                "ralph-allowed-tools",
                "Allowed tools",
                withDefault(
                  "Claude Code tools or permission rules such as Bash(pnpm test:*); they can only narrow Omniralph's coding tool policy. None allows the whole policy.",
                ),
                "Add a tool or rule…",
              )}
              {toolTags(
                "disallowedTools",
                "ralph-disallowed-tools",
                "Disallowed tools",
                withDefault("Always denied, on top of Omniralph's coding policy."),
                "Add a tool or rule…",
              )}
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-verification"
            title="Verification"
            description="The quality gates run after a story's session reports it complete. A failing gate sends its output back for the next attempt."
          >
            {textInput(
              "setupCommand",
              "ralph-setup-command",
              "Setup command",
              withDefault(
                `Runs once in a new branch worktree, e.g. to install dependencies. At most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString()} characters.`,
              ),
              { placeholder: "e.g. pnpm install --frozen-lockfile", mono: true },
            )}
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
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-pull-requests"
            title="Pull requests"
            description="When the run's pull or merge request opens, and what Omniralph fixes on it before leaving it to a person."
          >
            {switchInput(
              "openPullRequestEarly",
              "ralph-open-pr-early",
              "Open the pull request early",
              "Open a draft pull or merge request after the first story is pushed, and mark it ready when the run finishes.",
              DEFAULT_RALPH_SETTINGS.openPullRequestEarly,
            )}
            <div className="settings-pair">
              {switchInput(
                "respondToReviews",
                "ralph-respond-to-reviews",
                "Fix review findings",
                "Omniralph's review findings and @bot requests on the run's pull or merge request become requests the run works on.",
                DEFAULT_RALPH_SETTINGS.respondToReviews,
              )}
              {numberInput(
                "maxReviewRounds",
                "ralph-max-review-rounds",
                "Max review rounds",
                withDefault(
                  `Reviews acted on per pull or merge request before Omniralph leaves it to a person (0–${MAX_FIX_ROUNDS}).`,
                  RALPH_DEFAULT_TEXT.maxReviewRounds,
                ),
                MAX_FIX_ROUNDS,
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
                withDefault(
                  `Failed CI runs acted on per pull or merge request (0–${MAX_FIX_ROUNDS}).`,
                  RALPH_DEFAULT_TEXT.maxFixRounds,
                ),
                MAX_FIX_ROUNDS,
              )}
            </div>
          </SettingsSubsection>

          <SettingsSubsection
            id="coding-linear"
            title="Linear"
            description="How Omniralph reads and updates the Linear epic."
          >
            <LinearReadOnlyNote linear={linear} onRetry={onRetryLinear} />
            {linearTags(
              "manualLabels",
              "ralph-manual-labels",
              "Manual labels",
              withDefault(
                `Stories with any of these labels are steps for a person: Omniralph skips them and waits until they're done. ${
                  draft.manualLabels[0]
                    ? `The first, “${draft.manualLabels[0]}”, is the label Coding adds`
                    : "The first is the label Coding adds"
                } to the manual stories and follow-ups it files.`,
                RALPH_DEFAULT_TEXT.manualLabels,
              ),
              "Choose labels…",
            )}
            {linearTags(
              "blockedLabels",
              "ralph-blocked-labels",
              "Blocked labels",
              withDefault(
                "Omniralph won't work an issue with any of these labels (on the issue or its epic): a delegation or mention of one is refused. Empty for none.",
                RALPH_DEFAULT_TEXT.blockedLabels,
              ),
              "Choose labels…",
            )}
            {switchInput(
              "allowPreparation",
              "ralph-allow-preparation",
              "Offer to run preparation",
              "Ask whether to run a manual story's cyralph-prepare commands (“Run it”). Off, those blocks are plain text.",
              DEFAULT_RALPH_SETTINGS.allowPreparation,
            )}
            <EpicStateSelect
              value={draft.epicCompletedState}
              states={linearOptions?.states ?? null}
              error={errors.epicCompletedState}
              onChange={(value) => set("epicCompletedState", value)}
            />
          </SettingsSubsection>
        </div>
      </SettingsSection>

      <SettingsSection
        id="danger-zone"
        title="Danger zone"
        tone="danger"
        description="Settings that rewrite history or delete branches. Saving them always asks first."
        confirm={DESTRUCTIVE}
        {...section(CODING_SECTIONS.danger)}
      >
        <SettingsSubsection
          id="danger-history"
          title="History rewrites"
          description="Force-pushing the run's branch."
        >
          <Field
            label="History rewrites"
            htmlFor="ralph-history-rewrite"
            description={withDefault(
              "Whether a request may rebase and push with --force-with-lease: only when someone asks for it, always (it rebases onto the base branch instead of ever merging it), or never.",
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
          description="Deleting worktrees and branches once a pull or merge request is done."
        >
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

/** The epic state choices that aren't workspace state names. */
const EPIC_STATE_TYPES = [
  { value: "started", label: "started: the team's first started state" },
  { value: "completed", label: "completed: the team's first completed state" },
] as const;

/**
 * Epic completed state: leave the epic alone, the team's first started or completed state, or
 * one of the workspace's state names. A saved state the workspace no longer has stays chosen
 * with a warning; without a workspace (`states` null) the saved value is shown read-only.
 */
function EpicStateSelect({
  value,
  states,
  error,
  onChange,
}: {
  value: string;
  states: readonly string[] | null;
  error?: string;
  onChange: (value: string) => void;
}) {
  const id = "ralph-epic-completed-state";
  const noteId = `${id}-stale`;
  const current = value.trim();
  const known = (list: readonly string[]) =>
    list.some((state) => state.toLowerCase() === current.toLowerCase());
  const isType = EPIC_STATE_TYPES.some((t) => t.value === current);
  const stale = states !== null && current !== "" && !isType && !known(states);
  const readOnly = states === null;
  return (
    <Field
      label="Epic completed state"
      htmlFor={id}
      description={withDefault(
        "When every story of an epic is complete, move the epic to this state.",
        "Leave the epic alone",
      )}
      error={error}
    >
      <NativeSelect
        id={id}
        value={current}
        disabled={readOnly}
        aria-invalid={Boolean(error)}
        aria-describedby={stale ? noteId : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Leave the epic alone</option>
        {EPIC_STATE_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
        {readOnly && current !== "" && !isType && <option value={current}>{current}</option>}
        {stale && (
          <option value={current}>
            {current} ({NOT_AVAILABLE})
          </option>
        )}
        {states && states.length > 0 && (
          <optgroup label="Workflow states">
            {states.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </optgroup>
        )}
      </NativeSelect>
      {stale && (
        <StaleNote id={noteId}>
          “{current}” is {NOT_AVAILABLE}: no team in your Linear workspace has that state any more.
          It&apos;s kept until you choose another.
        </StaleNote>
      )}
    </Field>
  );
}
