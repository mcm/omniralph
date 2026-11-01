"use client";

import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  Select,
  Textarea,
  TextInput,
  TokenInput,
  useLinkComponent,
} from "@omniralph/ui";
import { CUSTOM_PLAYBOOK_ROLES, type PlaybookRole } from "@omniralph/tasks";
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { createElement, useId, useState, type FormEvent, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation } from "@/components/use-api-mutation";
import { api, ApiError } from "@/lib/api/client";
import { playbookKeys } from "@/lib/api/playbook-keys";
import {
  playbookPath,
  savedPlaybookSchema,
  type PlaybookFormOptions,
  type SavedPlaybook,
} from "@/lib/api/playbooks";
import { hasRole } from "@/lib/auth/roles";
import { SettingsPage } from "../settings-page";
import {
  DEFAULT_MODEL_LABEL,
  PLAYBOOK_ROLE_LABELS,
  PLAYBOOKS_PATH,
  playbookHref,
  trackerToolLabel,
} from "./labels";
import { epicCompletedStateLabel, PLAYBOOK_NOT_FOUND } from "./playbook-detail";
import {
  agentToolsFor,
  draftErrors,
  draftFromPlaybook,
  draftToInput,
  errorAt,
  hostToolError,
  isCodingRole,
  isReviewRole,
  newDraft,
  packageError,
  rowKey,
  unplacedErrors,
  type CommandDraft,
  type PlaybookDraft,
} from "./playbook-form";
import { usePlaybook, usePlaybookFormOptions, writeSavedPlaybook } from "./queries";
import "./playbooks.css";

/** Shown to a member who opens an editor's address. */
export const ADMINS_ONLY = "Only admins can change playbooks.";
/** Shown for a built-in's editor address. */
export const BUILTIN_READ_ONLY = "Built-in playbooks can't be changed. Clone one to make your own.";

/** The role a new playbook starts with. */
const NEW_PLAYBOOK_ROLE: PlaybookRole = "story";

function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const link = useLinkComponent();
  return createElement(link, { href, className }, children);
}

type Errors = Record<string, string>;

/** An error under a control that isn't a `Field`'s (a group of boxes, a list). */
function GroupError({ id, message }: { id?: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} className="or-field-error">
      {message}
    </p>
  );
}

/** A group of checkboxes, one per name, with the group's error. */
function ToolChoices({
  legend,
  names,
  selected,
  onChange,
  error,
  labelOf,
}: {
  legend: string;
  names: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  error: string | undefined;
  /** Each name in plain words (the name itself shows as the hover title); mono names without. */
  labelOf?: (name: string) => string;
}) {
  // Names saved before that the options no longer offer stay, so a save doesn't drop them.
  const all = [...names, ...selected.filter((name) => !names.includes(name))];
  return (
    <fieldset className="or-playbook-editor__group">
      <legend>{legend}</legend>
      <div className="or-playbook-editor__choices">
        {all.map((name) => (
          <Checkbox
            key={name}
            label={
              labelOf ? (
                <span title={name}>{labelOf(name)}</span>
              ) : (
                <span className="or-mono">{name}</span>
              )
            }
            checked={selected.includes(name)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? all.filter((option) => option === name || selected.includes(option))
                  : selected.filter((option) => option !== name),
              )
            }
          />
        ))}
      </div>
      <GroupError message={error} />
    </fieldset>
  );
}

/**
 * An ordered list editor (Design rule 19): numbered rows, each moved up or down or removed,
 * and an add button. `render` draws a row's own inputs.
 */
function OrderedRows<Row extends { key: string }>({
  legend,
  item,
  rows,
  onChange,
  create,
  render,
  errorOf,
  error,
}: {
  legend: string;
  /** One row in words, for the buttons ("setup command"). */
  item: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  create: () => Row;
  render: (row: Row, index: number, update: (row: Row) => void) => ReactNode;
  errorOf: (index: number) => string | undefined;
  error: string | undefined;
}) {
  const move = (from: number, to: number) => {
    const next = [...rows];
    const [row] = next.splice(from, 1);
    next.splice(to, 0, row!);
    onChange(next);
  };
  return (
    <fieldset className="or-playbook-editor__group">
      <legend>{legend}</legend>
      {rows.length === 0 ? null : (
        <ol className="or-playbook-editor__rows" aria-label={legend}>
          {rows.map((row, index) => (
            <li key={row.key} className="or-playbook-editor__row">
              <div className="or-playbook-editor__row-fields">
                {render(row, index, (next) =>
                  onChange(rows.map((other) => (other.key === row.key ? next : other))),
                )}
                <GroupError message={errorOf(index)} />
              </div>
              <div className="or-playbook-editor__row-actions">
                <IconButton
                  label={`Move ${item} ${index + 1} up`}
                  icon={IconArrowUp}
                  size="sm"
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                />
                <IconButton
                  label={`Move ${item} ${index + 1} down`}
                  icon={IconArrowDown}
                  size="sm"
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, index + 1)}
                />
                <IconButton
                  label={`Remove ${item} ${index + 1}`}
                  icon={IconTrash}
                  size="sm"
                  onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          icon={IconPlus}
          onClick={() => onChange([...rows, create()])}
        >
          {`Add ${item}`}
        </Button>
      </div>
      <GroupError message={error} />
    </fieldset>
  );
}

/** Setup or teardown commands: each a variable name and a shell command. */
function CommandRows({
  legend,
  item,
  path,
  rows,
  onChange,
  errors,
}: {
  legend: string;
  item: string;
  path: string;
  rows: CommandDraft[];
  onChange: (rows: CommandDraft[]) => void;
  errors: Errors;
}) {
  const capitalized = item.charAt(0).toUpperCase() + item.slice(1);
  return (
    <OrderedRows
      legend={legend}
      item={item}
      rows={rows}
      onChange={onChange}
      create={() => ({ key: rowKey(), name: "", command: "", rest: {} })}
      errorOf={(index) => errorAt(errors, `${path}.${index}`)}
      error={errors[path]}
      render={(row, index, update) => (
        <>
          <TextInput
            aria-label={`${capitalized} ${index + 1} name`}
            placeholder="name"
            mono
            value={row.name}
            onChange={(event) => update({ ...row, name: event.target.value })}
          />
          <TextInput
            aria-label={`${capitalized} ${index + 1}`}
            placeholder="command"
            mono
            value={row.command}
            onChange={(event) => update({ ...row, command: event.target.value })}
          />
        </>
      )}
    />
  );
}

/** "Claude Code default" and the reported models, plus a saved one no agent reports now. */
function ModelOptions({ options, value }: { options: PlaybookFormOptions; value: string | null }) {
  const offered = options.models.some((model) => model.value === value);
  return (
    <>
      <option value="">{DEFAULT_MODEL_LABEL}</option>
      {options.models.map((model) => (
        <option key={model.value} value={model.value}>
          {model.displayName}
        </option>
      ))}
      {value !== null && !offered ? <option value={value}>{value}</option> : null}
    </>
  );
}

const EPIC_STATES = [null, "started", "completed"] as const;

/** A story or request playbook's coding settings. */
function CodingCard({
  draft,
  update,
  options,
  errors,
}: {
  draft: PlaybookDraft;
  update: (change: Partial<PlaybookDraft["coding"]>) => void;
  options: PlaybookFormOptions;
  errors: Errors;
}) {
  const { coding } = draft;
  const prPlaybooks = options.prDescriptionPlaybooks.some(
    (playbook) => playbook.id === coding.prDescriptionPlaybookId,
  )
    ? options.prDescriptionPlaybooks
    : [
        ...options.prDescriptionPlaybooks,
        { id: coding.prDescriptionPlaybookId, name: coding.prDescriptionPlaybookId },
      ];
  const states: (string | null)[] = EPIC_STATES.includes(
    coding.epicCompletedState as (typeof EPIC_STATES)[number],
  )
    ? [...EPIC_STATES]
    : [...EPIC_STATES, coding.epicCompletedState];
  return (
    <Card title="Coding" headingLevel={3}>
      <OrderedRows
        legend="Verify commands"
        item="verify command"
        rows={coding.verifyCommands}
        onChange={(verifyCommands) => update({ verifyCommands })}
        create={() => ({ key: rowKey(), command: "" })}
        errorOf={(index) => errorAt(errors, `coding.verifyCommands.${index}`)}
        error={errors["coding.verifyCommands"]}
        render={(row, index, set) => (
          <TextInput
            aria-label={`Verify command ${index + 1}`}
            mono
            value={row.command}
            onChange={(event) => set({ ...row, command: event.target.value })}
          />
        )}
      />
      <Field label="Worktree setup">
        <TextInput
          mono
          value={coding.worktreeSetupCommand}
          onChange={(event) => update({ worktreeSetupCommand: event.target.value })}
          errorMessage={errorAt(errors, "coding.worktreeSetupCommand")}
        />
      </Field>
      <Field label="Pull request description playbook">
        <Select
          value={coding.prDescriptionPlaybookId}
          onChange={(event) => update({ prDescriptionPlaybookId: event.target.value })}
          errorMessage={errorAt(errors, "coding.prDescriptionPlaybookId")}
        >
          {prPlaybooks.map((playbook) => (
            <option key={playbook.id} value={playbook.id}>
              {playbook.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Epic completed state">
        <Select
          value={coding.epicCompletedState ?? ""}
          onChange={(event) => update({ epicCompletedState: event.target.value || null })}
          errorMessage={errorAt(errors, "coding.epicCompletedState")}
        >
          {states.map((state) => (
            <option key={state ?? ""} value={state ?? ""}>
              {epicCompletedStateLabel(state)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Unmerged branch timeout (minutes)">
        <TextInput
          inputMode="numeric"
          value={coding.unmergedBranchTimeoutMinutes}
          onChange={(event) => update({ unmergedBranchTimeoutMinutes: event.target.value })}
          errorMessage={errorAt(errors, "coding.unmergedBranchTimeoutMinutes")}
        />
      </Field>
      <div className="or-playbook-editor__choices">
        <Checkbox
          label="Run the PRD's quality gates after the verify commands"
          checked={coding.runPrdQualityGates}
          onCheckedChange={(runPrdQualityGates) => update({ runPrdQualityGates })}
        />
        <Checkbox
          label="Offer to run a manual story's preparation commands"
          checked={coding.allowPreparation}
          onCheckedChange={(allowPreparation) => update({ allowPreparation })}
        />
        <Checkbox
          label="Remove the worktree and branch after the pull request merges"
          checked={coding.cleanupMergedWorktrees}
          onCheckedChange={(cleanupMergedWorktrees) => update({ cleanupMergedWorktrees })}
        />
      </div>
      <GroupError
        message={
          errorAt(errors, "coding.runPrdQualityGates") ??
          errorAt(errors, "coding.allowPreparation") ??
          errorAt(errors, "coding.cleanupMergedWorktrees")
        }
      />
    </Card>
  );
}

/**
 * The editor's form: every field of a custom playbook, saved with one request (create or
 * replace). Its answer is written into the cached list and detail before the page moves to
 * the playbook; the server's field errors show next to their fields.
 */
function PlaybookForm({
  initial,
  playbookId,
  title,
  options,
}: {
  /** The draft it starts from (read once: a live refetch doesn't reset what's typed). */
  initial: () => PlaybookDraft;
  /** The playbook being edited; undefined for a new one. */
  playbookId?: string;
  title: string;
  options: PlaybookFormOptions;
}) {
  const router = useRouter();
  const formId = useId();
  const hostToolListId = useId();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const editing = playbookId !== undefined;

  const save = useApiMutation<SavedPlaybook, Record<string, unknown>>({
    mutationFn: (body, { organizationId }) =>
      editing
        ? api.put(playbookPath(playbookId), savedPlaybookSchema, { organizationId, body })
        : api.post("/api/ui/playbooks", savedPlaybookSchema, { organizationId, body }),
    applyResult: (saved, cache) => writeSavedPlaybook(cache, saved),
    invalidate: (keys) => [playbookKeys(keys).all],
    success: (saved) => (editing ? `Saved ${saved.summary.name}` : `Created ${saved.summary.name}`),
    onSuccess: (saved) => router.push(playbookHref(saved.id)),
    onError: (error) => {
      setErrors(error.fieldErrors ?? {});
      setFormError(error.fieldErrors ? null : error.message);
    },
  });

  const set = (change: Partial<PlaybookDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const setTools = (change: Partial<PlaybookDraft["tools"]>) =>
    setDraft((current) => ({ ...current, tools: { ...current.tools, ...change } }));
  const setToolSettings = (change: Partial<PlaybookDraft["toolSettings"]>) =>
    setDraft((current) => ({ ...current, toolSettings: { ...current.toolSettings, ...change } }));
  const setRequires = (change: Partial<PlaybookDraft["requires"]>) =>
    setDraft((current) => ({ ...current, requires: { ...current.requires, ...change } }));
  const setCoding = (change: Partial<PlaybookDraft["coding"]>) =>
    setDraft((current) => ({ ...current, coding: { ...current.coding, ...change } }));

  function changeRole(role: PlaybookRole) {
    const allowed = agentToolsFor(role);
    setDraft((current) => ({
      ...current,
      role,
      // Agent tools the new role's runs can't use go.
      tools: {
        ...current.tools,
        agent: current.tools.agent.filter((tool) => allowed.includes(tool)),
      },
    }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const local = draftErrors(draft);
    setFormError(null);
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    save.mutate(draftToInput(draft));
  }

  const review = isReviewRole(draft.role);
  const roles = editing ? [draft.role] : options.roles;
  const unplaced = unplacedErrors(errors, draft.role);
  const alert = [...(formError ? [formError] : []), ...unplaced];
  const cancelHref = editing ? playbookHref(playbookId) : PLAYBOOKS_PATH;

  return (
    <SettingsPage title={title}>
      <AppLink href={cancelHref} className="or-playbook__back">
        {editing ? "‹ Playbook" : "‹ Playbooks"}
      </AppLink>
      <form id={formId} className="or-playbook-editor" onSubmit={onSubmit} noValidate>
        {alert.length > 0 ? (
          <div role="alert" className="or-playbook-editor__alert">
            {alert.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}
        <Card title="General" headingLevel={3}>
          <Field label="Name">
            <TextInput
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              errorMessage={errorAt(errors, "name")}
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={2}
              value={draft.description}
              onChange={(event) => set({ description: event.target.value })}
              errorMessage={errorAt(errors, "description")}
            />
          </Field>
          <Field
            label="Role"
            description={editing ? "A playbook's role is set when it's created." : undefined}
          >
            <Select
              value={draft.role}
              disabled={editing}
              onChange={(event) => changeRole(event.target.value as PlaybookRole)}
              errorMessage={errorAt(errors, "role")}
            >
              {roles.map((role) => (
                <option key={role} value={role}>
                  {PLAYBOOK_ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>
        </Card>

        <Card title="Prompts" headingLevel={3}>
          <Field label="System prompt mode">
            <Select
              value={draft.systemPromptMode}
              onChange={(event) =>
                set({ systemPromptMode: event.target.value as PlaybookDraft["systemPromptMode"] })
              }
              errorMessage={errorAt(errors, "systemPromptMode")}
            >
              <option value="append">Added to Claude Code&apos;s</option>
              <option value="replace">Replaces Claude Code&apos;s</option>
            </Select>
          </Field>
          <Field label="System prompt" stacked>
            <Textarea
              mono
              rows={6}
              value={draft.systemPrompt}
              onChange={(event) => set({ systemPrompt: event.target.value })}
              errorMessage={errorAt(errors, "systemPrompt")}
            />
          </Field>
          <Field label="Prompt template" stacked>
            <Textarea
              mono
              rows={8}
              value={draft.promptTemplate}
              onChange={(event) => set({ promptTemplate: event.target.value })}
              errorMessage={errorAt(errors, "promptTemplate")}
            />
          </Field>
          <OrderedRows
            legend="Reference docs"
            item="reference doc"
            rows={draft.referenceDocs}
            onChange={(referenceDocs) => set({ referenceDocs })}
            create={() => ({ key: rowKey(), name: "", content: "" })}
            errorOf={(index) => errorAt(errors, `referenceDocs.${index}`)}
            error={errors.referenceDocs}
            render={(row, index, update) => (
              <>
                <TextInput
                  aria-label={`Reference doc ${index + 1} name`}
                  placeholder="name"
                  value={row.name}
                  onChange={(event) => update({ ...row, name: event.target.value })}
                />
                <Textarea
                  aria-label={`Reference doc ${index + 1}`}
                  mono
                  rows={4}
                  value={row.content}
                  onChange={(event) => update({ ...row, content: event.target.value })}
                />
              </>
            )}
          />
        </Card>

        <Card title="Model" headingLevel={3}>
          <Field label="Model">
            <Select
              mono
              value={draft.model ?? ""}
              onChange={(event) => set({ model: event.target.value || null })}
              errorMessage={errorAt(errors, "model")}
            >
              <ModelOptions options={options} value={draft.model} />
            </Select>
          </Field>
          <Field label="Fallback model">
            <Select
              mono
              value={draft.fallbackModel ?? ""}
              onChange={(event) => set({ fallbackModel: event.target.value || null })}
              errorMessage={errorAt(errors, "fallbackModel")}
            >
              <ModelOptions options={options} value={draft.fallbackModel} />
            </Select>
          </Field>
          {review ? null : (
            <>
              <Field label="Token budget">
                <Select
                  value={draft.tokenLimit.limited ? "limited" : "none"}
                  onChange={(event) =>
                    set({
                      tokenLimit: {
                        ...draft.tokenLimit,
                        limited: event.target.value === "limited",
                      },
                    })
                  }
                  errorMessage={
                    draft.tokenLimit.limited ? undefined : errorAt(errors, "tokenBudget")
                  }
                >
                  <option value="none">No limit</option>
                  <option value="limited">A number of tokens</option>
                </Select>
              </Field>
              {draft.tokenLimit.limited ? (
                <Field label="Tokens">
                  <TextInput
                    inputMode="numeric"
                    mono
                    value={draft.tokenLimit.tokens}
                    onChange={(event) =>
                      set({ tokenLimit: { limited: true, tokens: event.target.value } })
                    }
                    errorMessage={errorAt(errors, "tokenBudget")}
                  />
                </Field>
              ) : null}
            </>
          )}
        </Card>

        <Card title="Tools" headingLevel={3}>
          <ToolChoices
            legend="Built-in tools"
            names={options.tools.builtin}
            selected={draft.tools.builtin}
            onChange={(builtin) => setTools({ builtin })}
            error={errorAt(errors, "tools.builtin")}
          />
          <ToolChoices
            legend="Agent tools"
            names={options.tools.agent.filter((tool) => agentToolsFor(draft.role).includes(tool))}
            selected={draft.tools.agent}
            onChange={(agent) => setTools({ agent })}
            error={errorAt(errors, "tools.agent")}
          />
          <ToolChoices
            legend="Tracker tools"
            names={options.tools.tracker}
            selected={draft.tools.tracker}
            onChange={(tracker) => setTools({ tracker })}
            error={errorAt(errors, "tools.tracker")}
            labelOf={trackerToolLabel}
          />
          <Field label="MCP servers">
            <TokenInput
              values={draft.tools.mcpServers}
              onChange={(mcpServers) => setTools({ mcpServers })}
              validate={(value) =>
                options.mcpServers.includes(value)
                  ? null
                  : options.mcpServers.length === 0
                    ? "No agent reports an installable with an MCP server."
                    : `Choose one of ${options.mcpServers.join(", ")}.`
              }
            />
            <GroupError message={errorAt(errors, "tools.mcpServers")} />
          </Field>
          <fieldset className="or-playbook-editor__group">
            <legend>Access</legend>
            <div className="or-playbook-editor__choices">
              <Checkbox
                label="Shell"
                checked={draft.toolSettings.shell}
                onCheckedChange={(shell) => setToolSettings({ shell })}
              />
              <Checkbox
                label="Read the tracker"
                checked={draft.toolSettings.trackerRead}
                onCheckedChange={(trackerRead) => setToolSettings({ trackerRead })}
              />
              <Checkbox
                label="Network"
                checked={draft.toolSettings.network}
                onCheckedChange={(network) => setToolSettings({ network })}
              />
            </div>
            <GroupError message={errorAt(errors, "toolSettings")} />
          </fieldset>
        </Card>

        <Card title="Requirements" headingLevel={3}>
          <Field label="Packages">
            <TokenInput
              values={draft.requires.installables}
              onChange={(installables) => setRequires({ installables })}
              validate={packageError}
            />
            <GroupError message={errorAt(errors, "requires.installables")} />
          </Field>
          <Field label="Host tools">
            <TokenInput
              values={draft.requires.hostTools}
              onChange={(hostTools) => setRequires({ hostTools })}
              validate={hostToolError}
              list={hostToolListId}
            />
            {/* The names its agents report and its playbooks require; any valid name still goes. */}
            <datalist id={hostToolListId}>
              {options.hostTools
                .filter((name) => !draft.requires.hostTools.includes(name))
                .map((name) => (
                  <option key={name} value={name} />
                ))}
            </datalist>
            <GroupError message={errorAt(errors, "requires.hostTools")} />
          </Field>
        </Card>

        <Card title="Commands" headingLevel={3}>
          <CommandRows
            legend="Setup commands"
            item="setup command"
            path="setupCommands"
            rows={draft.setupCommands}
            onChange={(setupCommands) => set({ setupCommands })}
            errors={errors}
          />
          <CommandRows
            legend="Teardown commands"
            item="teardown command"
            path="teardownCommands"
            rows={draft.teardownCommands}
            onChange={(teardownCommands) => set({ teardownCommands })}
            errors={errors}
          />
        </Card>

        {isCodingRole(draft.role) ? (
          <CodingCard draft={draft} update={setCoding} options={options} errors={errors} />
        ) : null}

        <div className="or-playbook-editor__actions">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {editing ? "Save" : "Create playbook"}
          </Button>
          <Button variant="outline" onClick={() => router.push(cancelHref)}>
            Cancel
          </Button>
        </div>
      </form>
    </SettingsPage>
  );
}

function LoadError({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <EmptyState
      headingLevel={2}
      title="Couldn't load the playbook editor"
      description={error.message}
      action={
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      }
    />
  );
}

/** Why the user can't edit here (a member, a built-in), with the way back. */
function Refused({ title, href }: { title: string; href: string }) {
  return (
    <div className="or-settings-page">
      <AppLink href={href} className="or-playbook__back">
        ‹ Playbooks
      </AppLink>
      <EmptyState headingLevel={2} title={title} />
    </div>
  );
}

/** Advanced › Playbooks › New playbook (admins). */
export function NewPlaybookEditor() {
  const user = useCurrentUser();
  if (!hasRole(user, "admin")) return <Refused title={ADMINS_ONLY} href={PLAYBOOKS_PATH} />;
  return <NewPlaybookForm />;
}

function NewPlaybookForm() {
  const options = usePlaybookFormOptions();
  if (options.isPending) return <p aria-busy="true">Loading…</p>;
  if (options.isError) {
    return <LoadError error={options.error} retry={() => void options.refetch()} />;
  }
  const role = options.data.roles.includes(NEW_PLAYBOOK_ROLE)
    ? NEW_PLAYBOOK_ROLE
    : (options.data.roles[0] ?? CUSTOM_PLAYBOOK_ROLES[0]!);
  return (
    <PlaybookForm initial={() => newDraft(role)} title="New playbook" options={options.data} />
  );
}

/** Advanced › Playbooks › one custom playbook's editor (admins). */
export function EditPlaybookEditor({ id }: { id: string }) {
  const user = useCurrentUser();
  if (!hasRole(user, "admin")) return <Refused title={ADMINS_ONLY} href={playbookHref(id)} />;
  return <EditPlaybookForm id={id} />;
}

function EditPlaybookForm({ id }: { id: string }) {
  const detail = usePlaybook(id);
  const options = usePlaybookFormOptions();
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <Refused title={PLAYBOOK_NOT_FOUND} href={PLAYBOOKS_PATH} />;
    }
    return <LoadError error={detail.error} retry={() => void detail.refetch()} />;
  }
  if (options.isError) {
    return <LoadError error={options.error} retry={() => void options.refetch()} />;
  }
  if (detail.isPending || options.isPending) return <p aria-busy="true">Loading…</p>;
  if (detail.data.builtin) return <Refused title={BUILTIN_READ_ONLY} href={playbookHref(id)} />;
  const { playbook } = detail.data;
  return (
    <PlaybookForm
      initial={() => draftFromPlaybook(playbook)}
      playbookId={id}
      title={`Edit ${detail.data.playbook.name}`}
      options={options.data}
    />
  );
}
