/** Sections of the task form beyond its common fields: commands, tool settings and coding settings. */
import {
  Button,
  Checkbox,
  Cluster,
  Field,
  Input,
  Label,
  Muted,
  NativeSelect,
  Stack,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  CODING_DEFAULTS,
  DEFAULT_COMMAND_OUTPUT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_PR_DESCRIPTION_TASK_ID,
  DRAFT_PULL_REQUEST_TIMINGS,
  PUSH_TIMINGS,
  type DraftPullRequestTiming,
  type PushTiming,
  type SetupCommandInput,
  type TaskDefinition,
  type TeardownCommand,
  type ToolSettings,
} from "@omniralph/tasks";
import type { FieldErrors } from "@omniralph/shared";
import type { TaskChoice } from "@/lib/definitions";
import { withDefault } from "@/lib/settings/changes";
import { groupedNumber } from "@/lib/settings/forms";

/** A setup or teardown command being edited; numbers as typed (empty uses the default). */
export interface CommandDraft {
  name: string;
  command: string;
  timeoutSeconds: string;
  maxOutputBytes: string;
  /** Setup commands only. */
  fence: string;
  optional: boolean;
}

export function commandDraft(command: SetupCommandInput | TeardownCommand): CommandDraft {
  return {
    name: command.name,
    command: command.command,
    timeoutSeconds: command.timeoutSeconds === undefined ? "" : String(command.timeoutSeconds),
    maxOutputBytes: command.maxOutputBytes === undefined ? "" : String(command.maxOutputBytes),
    fence: "fence" in command ? (command.fence ?? "") : "",
    optional: "optional" in command ? (command.optional ?? false) : false,
  };
}

/** A typed number, or undefined (the default) when empty; anything else fails validation. */
function amount(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value.trim());
}

export function setupCommand(draft: CommandDraft): SetupCommandInput {
  return { ...teardownCommand(draft), fence: draft.fence.trim(), optional: draft.optional };
}

export function teardownCommand(
  draft: CommandDraft,
): Omit<SetupCommandInput, "fence" | "optional"> {
  return {
    name: draft.name.trim(),
    command: draft.command,
    timeoutSeconds: amount(draft.timeoutSeconds),
    maxOutputBytes: amount(draft.maxOutputBytes),
  };
}

const EMPTY_COMMAND: CommandDraft = {
  name: "",
  command: "",
  timeoutSeconds: "",
  maxOutputBytes: "",
  fence: "",
  optional: false,
};

/**
 * Editable setup or teardown commands, errors keyed
 * `<field>.<index>.<name|command|timeoutSeconds|maxOutputBytes|fence>`.
 */
export function CommandsEditor({
  field,
  commands,
  onChange,
  errors,
  disabled,
}: {
  field: "setupCommands" | "teardownCommands";
  commands: CommandDraft[];
  onChange: (commands: CommandDraft[]) => void;
  errors: FieldErrors;
  disabled: boolean;
}) {
  const setup = field === "setupCommands";
  const noun = setup ? "setup command" : "teardown command";
  const update = (index: number, change: Partial<CommandDraft>) =>
    onChange(commands.map((command, i) => (i === index ? { ...command, ...change } : command)));
  return (
    <Stack>
      {errors[field] && <p className="m-0 text-danger-fg">{errors[field]}</p>}
      {commands.length === 0 && <Muted>No {noun}s.</Muted>}
      {commands.map((command, index) => {
        const prefix = `${field}.${index}`;
        const id = (name: string) => `task-${prefix}-${name}`.replaceAll(".", "-");
        const error = (name: string) => errors[`${prefix}.${name}`];
        return (
          <div key={index} className="definition-document">
            <Field
              label="Name"
              htmlFor={id("name")}
              description={
                setup
                  ? `Its output is {{setup.${command.name.trim() || "<name>"}}} in the template.`
                  : "Names it in the run log."
              }
              error={error("name")}
              required
            >
              <Input
                id={id("name")}
                disabled={disabled}
                error={Boolean(error("name"))}
                aria-invalid={Boolean(error("name"))}
                value={command.name}
                onChange={(e) => update(index, { name: e.target.value })}
                className="settings-mono"
              />
            </Field>
            <Field
              label="Command"
              htmlFor={id("command")}
              description="Run with sh -c in the working directory."
              error={error("command")}
              required
            >
              <Textarea
                id={id("command")}
                rows={2}
                disabled={disabled}
                aria-invalid={Boolean(error("command"))}
                value={command.command}
                onChange={(e) => update(index, { command: e.target.value })}
                className="settings-mono"
              />
            </Field>
            <div className="definition-grid">
              <Field
                label="Timeout (seconds)"
                htmlFor={id("timeoutSeconds")}
                description={withDefault(
                  "Stops the command after this long.",
                  `${DEFAULT_COMMAND_TIMEOUT_SECONDS} seconds`,
                )}
                error={error("timeoutSeconds")}
              >
                <Input
                  id={id("timeoutSeconds")}
                  type="number"
                  className="input-number"
                  min={1}
                  disabled={disabled}
                  error={Boolean(error("timeoutSeconds"))}
                  aria-invalid={Boolean(error("timeoutSeconds"))}
                  value={command.timeoutSeconds}
                  onChange={(e) => update(index, { timeoutSeconds: e.target.value })}
                />
              </Field>
              <Field
                label="Output cap (bytes)"
                htmlFor={id("maxOutputBytes")}
                description={withDefault(
                  "Keeps at most this much of its output.",
                  `${groupedNumber(DEFAULT_COMMAND_OUTPUT_BYTES)} bytes`,
                )}
                error={error("maxOutputBytes")}
              >
                <Input
                  id={id("maxOutputBytes")}
                  type="number"
                  className="input-number-wide"
                  min={1}
                  disabled={disabled}
                  error={Boolean(error("maxOutputBytes"))}
                  aria-invalid={Boolean(error("maxOutputBytes"))}
                  value={command.maxOutputBytes}
                  onChange={(e) => update(index, { maxOutputBytes: e.target.value })}
                />
              </Field>
              {setup && (
                <Field
                  label="Fence"
                  htmlFor={id("fence")}
                  description={withDefault(
                    "Info string of the fence around the output, e.g. json.",
                    "a plain fence",
                  )}
                  error={error("fence")}
                >
                  <Input
                    id={id("fence")}
                    disabled={disabled}
                    error={Boolean(error("fence"))}
                    aria-invalid={Boolean(error("fence"))}
                    value={command.fence}
                    onChange={(e) => update(index, { fence: e.target.value })}
                    className="settings-mono"
                  />
                </Field>
              )}
            </div>
            <Cluster justify="between">
              {setup ? (
                <div className="settings-check settings-check-center">
                  <Checkbox
                    id={id("optional")}
                    checked={command.optional}
                    disabled={disabled}
                    onCheckedChange={(checked) => update(index, { optional: checked === true })}
                  />
                  <Label htmlFor={id("optional")}>
                    Optional: a failure leaves a note instead of failing the run
                  </Label>
                </div>
              ) : (
                <span />
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(commands.filter((_, i) => i !== index))}
              >
                <IconTrash size={14} />
                Remove {noun}
              </Button>
            </Cluster>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...commands, EMPTY_COMMAND])}
        >
          <IconPlus size={14} />
          Add {noun}
        </Button>
      </div>
    </Stack>
  );
}

/** The typed output schema: undefined when empty, or why it can't be one. */
export function parseOutputSchema(
  text: string,
): { schema?: Record<string, unknown> } | { error: string } {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: `This isn't valid JSON: ${error instanceof Error ? error.message : error}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "The output schema must be a JSON object." };
  }
  return { schema: value as Record<string, unknown> };
}

export const TOOL_SETTINGS: { key: keyof ToolSettings; label: string; queryOnly?: boolean }[] = [
  { key: "shell", label: "Shell (Bash)", queryOnly: true },
  { key: "linearRead", label: "Linear read access (the agent's Linear tools)" },
  { key: "network", label: "Network access beyond the control panel" },
];

/** Checkboxes narrowing the agent's tools; shell only on query tasks. */
export function ToolSettingsFields({
  value,
  onChange,
  query,
  errors,
  disabled,
}: {
  value: ToolSettings;
  onChange: (value: ToolSettings) => void;
  query: boolean;
  errors: FieldErrors;
  disabled: boolean;
}) {
  return (
    <Stack>
      {TOOL_SETTINGS.filter((setting) => query || !setting.queryOnly).map(({ key, label }) => {
        const error = errors[`toolSettings.${key}`];
        return (
          <div key={key}>
            <div className="settings-check settings-check-center">
              <Checkbox
                id={`task-tool-settings-${key}`}
                checked={value[key]}
                disabled={disabled}
                onCheckedChange={(checked) => onChange({ ...value, [key]: checked === true })}
              />
              <Label htmlFor={`task-tool-settings-${key}`}>{label}</Label>
            </div>
            {error && <p className="m-0 text-danger-fg">{error}</p>}
          </div>
        );
      })}
    </Stack>
  );
}

/** Coding settings being edited; numbers as typed (empty uses the default). */
export interface CodingDraft {
  pushTiming: PushTiming;
  /** Empty follows the repository's setting. */
  draftPullRequest: DraftPullRequestTiming | "";
  prDescriptionTaskId: string;
  maxAttemptsPerStory: string;
  maxRoundsPerStory: string;
  stallRounds: string;
  maxIterationsPerRun: string;
  maxReviewRounds: string;
  maxFixRounds: string;
}

/** The coding run's limits: key, label and what the limit does. */
export const LIMITS = [
  ["maxAttemptsPerStory", "Attempts per story", "Attempts before a story is marked exhausted."],
  ["maxRoundsPerStory", "Rounds per story", "Review loop rounds a story gets."],
  ["stallRounds", "Rounds without progress", "Rounds a story's metric may fail to improve."],
  ["maxIterationsPerRun", "Story attempts per run", "Attempts before the run stops and asks."],
  ["maxReviewRounds", "Review fix rounds", "Caps the repository's review fix rounds."],
  ["maxFixRounds", "CI fix rounds", "Caps the repository's CI fix rounds."],
] as const;

/** What an empty limit becomes. */
export const LIMIT_DEFAULTS: Record<(typeof LIMITS)[number][0], number> = {
  maxAttemptsPerStory: CODING_DEFAULTS.maxAttemptsPerStory,
  maxRoundsPerStory: CODING_DEFAULTS.maxRoundsPerStory,
  stallRounds: CODING_DEFAULTS.stallRounds,
  maxIterationsPerRun: CODING_DEFAULTS.maxIterationsPerRun,
  maxReviewRounds: CODING_DEFAULTS.maxReviewRounds,
  maxFixRounds: CODING_DEFAULTS.maxFixRounds,
};

export function codingDraft(task: TaskDefinition | null): CodingDraft {
  const text = (value: number | undefined) => (value === undefined ? "" : String(value));
  return {
    pushTiming: task?.pushTiming ?? "per-story",
    draftPullRequest: task?.draftPullRequest ?? "",
    prDescriptionTaskId: task?.prDescriptionTaskId ?? DEFAULT_PR_DESCRIPTION_TASK_ID,
    maxAttemptsPerStory: text(task?.maxAttemptsPerStory),
    maxRoundsPerStory: text(task?.maxRoundsPerStory),
    stallRounds: text(task?.stallRounds),
    maxIterationsPerRun: text(task?.maxIterationsPerRun),
    maxReviewRounds: text(task?.maxReviewRounds),
    maxFixRounds: text(task?.maxFixRounds),
  };
}

/** The coding-only fields of a coding task's definition. */
export function codingFields(draft: CodingDraft): Partial<TaskDefinition> {
  return {
    pushTiming: draft.pushTiming,
    draftPullRequest: draft.draftPullRequest || undefined,
    prDescriptionTaskId: draft.prDescriptionTaskId,
    ...Object.fromEntries(LIMITS.map(([key]) => [key, amount(draft[key])])),
  };
}

export const PUSH_TIMING_LABELS: Record<PushTiming, string> = {
  "per-story": "After each story",
  end: "Once at the end",
};
export const DRAFT_PULL_REQUEST_LABELS: Record<DraftPullRequestTiming, string> = {
  early: "Early (after the first story)",
  end: "At the end",
};

/** Push and draft PR timing, the PR description task and the run's limits. */
export function CodingFields({
  value,
  onChange,
  prDescriptionTasks,
  errors,
  disabled,
}: {
  value: CodingDraft;
  onChange: (value: CodingDraft) => void;
  /** The query tasks a coding run can invoke for its `{ title, body }` PR description. */
  prDescriptionTasks: TaskChoice[];
  errors: FieldErrors;
  disabled: boolean;
}) {
  const set = (change: Partial<CodingDraft>) => onChange({ ...value, ...change });
  // A task saved before it stopped qualifying stays visible, so its error has a field.
  const unlisted =
    value.prDescriptionTaskId !== "" &&
    !prDescriptionTasks.some((task) => task.id === value.prDescriptionTaskId);
  return (
    <Stack>
      <div className="definition-grid">
        <Field
          label="Push"
          htmlFor="task-push-timing"
          description={withDefault(
            "When the run pushes its branch.",
            PUSH_TIMING_LABELS[CODING_DEFAULTS.pushTiming].toLowerCase(),
          )}
          error={errors.pushTiming}
        >
          <NativeSelect
            id="task-push-timing"
            disabled={disabled}
            aria-invalid={Boolean(errors.pushTiming)}
            value={value.pushTiming}
            onChange={(e) => set({ pushTiming: e.target.value as PushTiming })}
          >
            {PUSH_TIMINGS.map((timing) => (
              <option key={timing} value={timing}>
                {PUSH_TIMING_LABELS[timing]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Draft PR"
          htmlFor="task-draft-pull-request"
          description={withDefault("When the run opens its draft PR.", "the repository's setting")}
          error={errors.draftPullRequest}
        >
          <NativeSelect
            id="task-draft-pull-request"
            disabled={disabled}
            aria-invalid={Boolean(errors.draftPullRequest)}
            value={value.draftPullRequest}
            onChange={(e) =>
              set({ draftPullRequest: e.target.value as DraftPullRequestTiming | "" })
            }
          >
            <option value="">The repository&apos;s setting</option>
            {DRAFT_PULL_REQUEST_TIMINGS.map((timing) => (
              <option key={timing} value={timing}>
                {DRAFT_PULL_REQUEST_LABELS[timing]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="PR description task"
          htmlFor="task-pr-description-task"
          description={withDefault(
            "A query task started by run.invoked that outputs { title, body }.",
            prDescriptionTasks.find((task) => task.id === CODING_DEFAULTS.prDescriptionTaskId)
              ?.name ?? CODING_DEFAULTS.prDescriptionTaskId,
          )}
          error={errors.prDescriptionTaskId}
          required
        >
          <NativeSelect
            id="task-pr-description-task"
            disabled={disabled}
            aria-invalid={Boolean(errors.prDescriptionTaskId)}
            value={value.prDescriptionTaskId}
            onChange={(e) => set({ prDescriptionTaskId: e.target.value })}
          >
            {unlisted && (
              <option value={value.prDescriptionTaskId}>{value.prDescriptionTaskId}</option>
            )}
            {prDescriptionTasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.builtin ? `${task.name} (built-in)` : task.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="definition-grid">
        {LIMITS.map(([key, label, effect]) => (
          <Field
            key={key}
            label={label}
            htmlFor={`task-${key}`}
            description={withDefault(
              `${effect} Leave it empty for the default.`,
              String(LIMIT_DEFAULTS[key]),
            )}
            error={errors[key]}
          >
            <Input
              id={`task-${key}`}
              type="number"
              className="input-number"
              min={key === "maxReviewRounds" || key === "maxFixRounds" ? 0 : 1}
              disabled={disabled}
              error={Boolean(errors[key])}
              aria-invalid={Boolean(errors[key])}
              value={value[key]}
              onChange={(e) => set({ [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
    </Stack>
  );
}
