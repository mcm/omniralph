"use client";

import * as React from "react";
import {
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
  NativeSelect,
  Switch,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconDeviceFloppy } from "@tabler/icons-react";
import {
  fieldErrors as toFieldErrors,
  MAX_APPEND_INSTRUCTION_LENGTH,
  MAX_FIX_ROUNDS,
  MAX_SETUP_COMMAND_LENGTH,
  MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
  parseCommaList,
  parseLines,
  RalphSettingsInput,
  type FieldErrors,
  type RalphHistoryRewrite,
} from "@omniralph/shared";
import { useAction } from "@/components/use-action";
import { updateRalphSettings } from "./actions";

/** The form's values: the saved settings, with empty text and lists for none. */
export type RalphSettingsValues = RalphSettingsInput;

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const row: React.CSSProperties = { display: "flex", gap: "var(--space-4)", flexWrap: "wrap" };

const mono: React.CSSProperties = { fontFamily: "var(--font-mono)" };

/** The first error of a list field (`linearLabels` or `linearLabels.2`). */
function listError(errors: FieldErrors, field: string): string | undefined {
  return errors[field] ?? Object.entries(errors).find(([key]) => key.startsWith(`${field}.`))?.[1];
}

/** A whole number typed into a number input; NaN (rejected by the schema) when it isn't one. */
function whole(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

function Toggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)" }}>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <Label htmlFor={id}>{label}</Label>
        <Muted>{description}</Muted>
      </div>
    </div>
  );
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent style={stack}>{children}</CardContent>
    </Card>
  );
}

/**
 * Repository › Settings › Ralph (admin-only): opts the repository into
 * Linear-driven builds, says which Linear issues route to it and how its runs
 * work (cyralph's per-repository settings), grouped as Verification, Prompt
 * and model, Tools, PR follow-up and Linear.
 */
export function RalphSettingsSection({
  repositoryId,
  settings,
}: {
  repositoryId: string;
  settings: RalphSettingsValues;
}) {
  const { pending, run } = useAction();
  const [ralphEnabled, setRalphEnabled] = React.useState(settings.ralphEnabled);
  const [teamKeys, setTeamKeys] = React.useState(settings.linearTeamKeys.join(", "));
  const [projectNames, setProjectNames] = React.useState(settings.linearProjectNames.join(", "));
  const [labels, setLabels] = React.useState(settings.linearLabels.join(", "));
  // Verification
  const [verifyCommands, setVerifyCommands] = React.useState(settings.verifyCommands.join("\n"));
  const [runPrdQualityGates, setRunPrdQualityGates] = React.useState(settings.runPrdQualityGates);
  const [setupCommand, setSetupCommand] = React.useState(settings.setupCommand);
  // Prompt and model
  const [appendInstruction, setAppendInstruction] = React.useState(settings.appendInstruction);
  const [model, setModel] = React.useState(settings.model);
  const [fallbackModel, setFallbackModel] = React.useState(settings.fallbackModel);
  // Tools
  const [allowedTools, setAllowedTools] = React.useState(settings.allowedTools.join("\n"));
  const [disallowedTools, setDisallowedTools] = React.useState(settings.disallowedTools.join("\n"));
  // PR follow-up
  const [openPullRequestEarly, setOpenPullRequestEarly] = React.useState(
    settings.openPullRequestEarly,
  );
  const [historyRewrite, setHistoryRewrite] = React.useState<RalphHistoryRewrite>(
    settings.historyRewrite,
  );
  const [respondToReviews, setRespondToReviews] = React.useState(settings.respondToReviews);
  const [maxReviewRounds, setMaxReviewRounds] = React.useState(String(settings.maxReviewRounds));
  const [respondToCiFailures, setRespondToCiFailures] = React.useState(
    settings.respondToCiFailures,
  );
  const [maxFixRounds, setMaxFixRounds] = React.useState(String(settings.maxFixRounds));
  const [cleanupMergedWorktrees, setCleanupMergedWorktrees] = React.useState(
    settings.cleanupMergedWorktrees,
  );
  const [unmergedTimeout, setUnmergedTimeout] = React.useState(
    String(settings.unmergedBranchTimeoutMinutes),
  );
  // Linear
  const [manualLabels, setManualLabels] = React.useState(settings.manualLabels.join(", "));
  const [allowPreparation, setAllowPreparation] = React.useState(settings.allowPreparation);
  const [epicCompletedState, setEpicCompletedState] = React.useState(settings.epicCompletedState);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = RalphSettingsInput.safeParse({
      ralphEnabled,
      linearTeamKeys: parseCommaList(teamKeys),
      linearProjectNames: parseCommaList(projectNames),
      linearLabels: parseCommaList(labels),
      verifyCommands: parseLines(verifyCommands),
      runPrdQualityGates,
      setupCommand,
      appendInstruction,
      model,
      fallbackModel,
      allowedTools: parseLines(allowedTools),
      disallowedTools: parseLines(disallowedTools),
      openPullRequestEarly,
      historyRewrite,
      respondToReviews,
      maxReviewRounds: whole(maxReviewRounds),
      respondToCiFailures,
      maxFixRounds: whole(maxFixRounds),
      cleanupMergedWorktrees,
      unmergedBranchTimeoutMinutes: whole(unmergedTimeout),
      manualLabels: parseCommaList(manualLabels),
      allowPreparation,
      epicCompletedState,
    } satisfies RalphSettingsInput);
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    run(
      () => updateRalphSettings(repositoryId, parsed.data),
      "Ralph settings saved; they apply to new runs",
      () => setErrors({}),
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  const textInput = (
    id: string,
    label: string,
    hint: string,
    field: keyof RalphSettingsValues,
    value: string,
    onChange: (value: string) => void,
    options: { placeholder?: string; mono?: boolean; required?: boolean } = {},
  ) => {
    const error = listError(errors, field);
    return (
      <Field label={label} htmlFor={id} hint={hint} error={error} required={options.required}>
        <Input
          id={id}
          disabled={pending}
          error={Boolean(error)}
          aria-invalid={Boolean(error)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={options.placeholder}
          style={options.mono ? mono : undefined}
        />
      </Field>
    );
  };

  const linesInput = (
    id: string,
    label: string,
    hint: string,
    field: keyof RalphSettingsValues,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
  ) => {
    const error = listError(errors, field);
    return (
      <Field label={label} htmlFor={id} hint={hint} error={error}>
        <Textarea
          id={id}
          rows={3}
          disabled={pending}
          aria-invalid={Boolean(error)}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={mono}
        />
      </Field>
    );
  };

  const numberInput = (
    id: string,
    label: string,
    hint: string,
    field: keyof RalphSettingsValues,
    value: string,
    onChange: (value: string) => void,
    max: number,
    min = 0,
  ) => (
    <Field label={label} htmlFor={id} hint={hint} error={errors[field]}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        disabled={pending}
        error={Boolean(errors[field])}
        aria-invalid={Boolean(errors[field])}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );

  return (
    <form onSubmit={save} noValidate style={{ display: "contents" }}>
      <Card>
        <CardHeader>
          <CardTitle>Ralph</CardTitle>
          <CardDescription>
            Let Linear issues delegated to the Omniralph app be built here, story by story. A
            delegation goes to the first enabled repository that matches its{" "}
            <code>[repo=&lt;path&gt;]</code> tag, then its labels, project and team.
          </CardDescription>
        </CardHeader>
        <CardContent style={stack}>
          <Toggle
            id="ralph-enabled"
            label="Enable ralph"
            description="Delegated Linear issues may build in this repository and push branches to it."
            checked={ralphEnabled}
            disabled={pending}
            onChange={setRalphEnabled}
          />
          {textInput(
            "ralph-labels",
            "Linear labels",
            "Comma-separated. Issues with any of these labels route here.",
            "linearLabels",
            labels,
            setLabels,
            { placeholder: "backend, api" },
          )}
          {textInput(
            "ralph-projects",
            "Linear projects",
            "Comma-separated project names.",
            "linearProjectNames",
            projectNames,
            setProjectNames,
            { placeholder: "Omniralph" },
          )}
          {textInput(
            "ralph-teams",
            "Linear team keys",
            "Comma-separated, e.g. ENG.",
            "linearTeamKeys",
            teamKeys,
            setTeamKeys,
            { placeholder: "ENG, OPS" },
          )}
        </CardContent>
      </Card>

      <Group
        title="Ralph › Verification"
        description="The quality gates the job runs after a story's session reports it complete; a failing gate sends its output back for the next attempt."
      >
        {linesInput(
          "ralph-verify-commands",
          "Verify commands (verifyCommands)",
          "One per line. Run as quality gates for every story and request in this repository, before the PRD's.",
          "verifyCommands",
          verifyCommands,
          setVerifyCommands,
          "pnpm typecheck\npnpm test",
        )}
        <Toggle
          id="ralph-run-prd-gates"
          label="Run the PRD's quality gates (runPrdQualityGates)"
          description="Also run the commands under the PRD's ## Quality Gates heading. A single issue only runs the verify commands."
          checked={runPrdQualityGates}
          disabled={pending}
          onChange={setRunPrdQualityGates}
        />
        {textInput(
          "ralph-setup-command",
          "Setup command",
          `Runs once in a new branch worktree, e.g. to install dependencies. At most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString()} characters.`,
          "setupCommand",
          setupCommand,
          setSetupCommand,
          { placeholder: "pnpm install --frozen-lockfile", mono: true },
        )}
      </Group>

      <Group
        title="Ralph › Prompt and model"
        description="What the Claude sessions are told and which model runs them."
      >
        <Field
          label="Appended instruction (appendInstruction)"
          htmlFor="ralph-append-instruction"
          hint={`Appended to every story and request prompt. At most ${MAX_APPEND_INSTRUCTION_LENGTH.toLocaleString()} characters.`}
          error={errors.appendInstruction}
        >
          <Textarea
            id="ralph-append-instruction"
            rows={4}
            disabled={pending}
            aria-invalid={Boolean(errors.appendInstruction)}
            value={appendInstruction}
            onChange={(e) => setAppendInstruction(e.target.value)}
          />
        </Field>
        <div style={row}>
          {textInput(
            "ralph-model",
            "Model",
            "Claude model alias or ID the sessions use.",
            "model",
            model,
            setModel,
            { mono: true, required: true },
          )}
          {textInput(
            "ralph-fallback-model",
            "Fallback model (fallbackModel)",
            "Used when the model is overloaded. Empty for none.",
            "fallbackModel",
            fallbackModel,
            setFallbackModel,
            { mono: true, placeholder: "sonnet" },
          )}
        </div>
      </Group>

      <Group
        title="Ralph › Tools"
        description="Agent SDK tools or permission rules, one per line. They can only narrow ralph's tool policy, never widen it."
      >
        {linesInput(
          "ralph-allowed-tools",
          "Allowed tools (allowedTools)",
          "Empty for ralph's whole policy. Otherwise only these tools are available, and only calls matching these rules run, e.g. Bash(pnpm test:*).",
          "allowedTools",
          allowedTools,
          setAllowedTools,
          "Read\nEdit\nBash(pnpm test:*)",
        )}
        {linesInput(
          "ralph-disallowed-tools",
          "Disallowed tools (disallowedTools)",
          "Always denied, on top of ralph's policy.",
          "disallowedTools",
          disallowedTools,
          setDisallowedTools,
          "WebFetch",
        )}
      </Group>

      <Group
        title="Ralph › PR follow-up"
        description="The run's pull or merge request: when it opens, and how ralph looks after it (reviews, CI and cleanup after the merge)."
      >
        <Toggle
          id="ralph-open-pr-early"
          label="Open the pull request early (openPullRequestEarly)"
          description="Open a draft pull or merge request after the first story is pushed, and mark it ready when the run finishes."
          checked={openPullRequestEarly}
          disabled={pending}
          onChange={setOpenPullRequestEarly}
        />
        <Field
          label="History rewrites (historyRewrite)"
          htmlFor="ralph-history-rewrite"
          hint="Whether a request may rebase and push with --force-with-lease when someone asks for it."
          error={errors.historyRewrite}
        >
          <NativeSelect
            id="ralph-history-rewrite"
            disabled={pending}
            value={historyRewrite}
            onChange={(e) => setHistoryRewrite(e.target.value as RalphHistoryRewrite)}
          >
            <option value="when-asked">When asked</option>
            <option value="never">Never</option>
          </NativeSelect>
        </Field>
        <Toggle
          id="ralph-respond-to-reviews"
          label="Fix review findings (respondToReviews)"
          description="Omniralph's review findings and @bot requests on the run's pull or merge request become requests ralph works on."
          checked={respondToReviews}
          disabled={pending}
          onChange={setRespondToReviews}
        />
        {numberInput(
          "ralph-max-review-rounds",
          "Max review rounds (maxReviewRounds)",
          `Reviews acted on per pull or merge request before ralph leaves it to a person (0–${MAX_FIX_ROUNDS}).`,
          "maxReviewRounds",
          maxReviewRounds,
          setMaxReviewRounds,
          MAX_FIX_ROUNDS,
        )}
        <Toggle
          id="ralph-respond-to-ci"
          label="Fix failed CI (respondToCiFailures)"
          description="A failed CI run on the head commit becomes a request with the failed jobs' logs."
          checked={respondToCiFailures}
          disabled={pending}
          onChange={setRespondToCiFailures}
        />
        {numberInput(
          "ralph-max-fix-rounds",
          "Max CI fix rounds (maxFixRounds)",
          `Failed CI runs acted on per pull or merge request (0–${MAX_FIX_ROUNDS}).`,
          "maxFixRounds",
          maxFixRounds,
          setMaxFixRounds,
          MAX_FIX_ROUNDS,
        )}
        <Toggle
          id="ralph-cleanup"
          label="Clean up after the merge (cleanupMergedWorktrees)"
          description="Remove the worktree and local branch once the pull or merge request merges. Leftover stashes and unmerged commits are offered to a person first."
          checked={cleanupMergedWorktrees}
          disabled={pending}
          onChange={setCleanupMergedWorktrees}
        />
        {numberInput(
          "ralph-unmerged-timeout",
          "Unmerged branch timeout, minutes (unmergedBranchTimeoutMinutes)",
          "A branch with unmerged commits is deleted after this long without an answer.",
          "unmergedBranchTimeoutMinutes",
          unmergedTimeout,
          setUnmergedTimeout,
          MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
          1,
        )}
      </Group>

      <Group title="Ralph › Linear" description="How ralph reads and updates the Linear epic.">
        {textInput(
          "ralph-manual-labels",
          "Manual labels",
          "Comma-separated. Stories with any of these labels are steps for a person: ralph skips them and waits until they're done. The first one labels the manual stories and follow-ups ralph files.",
          "manualLabels",
          manualLabels,
          setManualLabels,
          { placeholder: "manual" },
        )}
        <Toggle
          id="ralph-allow-preparation"
          label="Offer to run preparation (allowPreparation)"
          description="Ask whether to run a manual story's cyralph-prepare commands (“Run it”). Off, those blocks are plain text."
          checked={allowPreparation}
          disabled={pending}
          onChange={setAllowPreparation}
        />
        {textInput(
          "ralph-epic-completed-state",
          "Epic completed state (epicCompletedState)",
          "When every story of an epic is complete, move the epic to this state: a state name, or started / completed for the first state of that type. Empty leaves it alone.",
          "epicCompletedState",
          epicCompletedState,
          setEpicCompletedState,
          { placeholder: "In Review" },
        )}
        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            <IconDeviceFloppy size={14} />
            {pending ? "Saving…" : "Save Ralph settings"}
          </Button>
        </div>
      </Group>
    </form>
  );
}
