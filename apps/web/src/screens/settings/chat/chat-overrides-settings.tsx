"use client";

import {
  BRAND_NAMES,
  BrandMark,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  SaveBar,
  Select,
  Sheet,
  TextInput,
  useLinkComponent,
  type DataTableColumn,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { createElement, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation } from "@/components/use-api-mutation";
import { api, type ApiError } from "@/lib/api/client";
import {
  savedChannelPlaybooksSchema,
  type ChannelPlaybooks,
  type ChatPlaybooksSettings,
} from "@/lib/api/integrations";
import { chatPlaybooksKey } from "@/lib/api/keys";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { useChatPlaybooks } from "../queries";
import { SETTINGS_PATHS } from "../settings-nav";
import "./chat.css";

/** The two playbooks chat runs. */
export type ChatSlot = "ask" | "startWork";
const SLOTS: readonly ChatSlot[] = ["ask", "startWork"];

/** Each slot's select, in the organization's card, the overrides table and the sheet. */
export const SLOT_LABELS: Record<ChatSlot, string> = {
  ask: "Answer questions with",
  startWork: "Start work with",
};

/** What each slot's playbook does. */
const SLOT_DESCRIPTIONS: Record<ChatSlot, string> = {
  ask: "When someone asks Om a question in a channel.",
  startWork: "When someone asks Om to change code or open a work item.",
};

export const ORGANIZATION_DEFAULT = "Organization default";
export const NO_CHAT_CONNECTION = "Connect Slack or Discord to override a channel.";
export const NO_OVERRIDES = "No channel overrides: every channel uses the organization default.";
export const CHANNEL_REQUIRED = "Enter a channel ID or name.";
export const PLAYBOOK_REQUIRED = "Choose a playbook for the channel to run.";

type Connection = ChatPlaybooksSettings["connections"][number];

/** One override as the table lists it: the channel and its connection. */
export interface OverrideRow {
  connection: Connection;
  override: ChannelPlaybooks;
}

/** A playbook's name among the slot's choices; a playbook it doesn't offer shows its ID. */
export function playbookName(settings: ChatPlaybooksSettings, slot: ChatSlot, id: string): string {
  return settings.choices[slot].find((choice) => choice.id === id)?.name ?? id;
}

/** Every override of every chat connection, by connection then channel. */
export function overrideRows(settings: ChatPlaybooksSettings): OverrideRow[] {
  return settings.connections.flatMap((connection) =>
    connection.channels.map((override) => ({ connection, override })),
  );
}

/** A connection as the sheet's select names it: "Slack · Acme". */
export function connectionLabel(connection: Pick<Connection, "platform" | "name">): string {
  return `${BRAND_NAMES[connection.platform]} · ${connection.name}`;
}

/** `settings` with `override` saved on `connectionId` (replacing the channel's, else added). */
export function withOverride(
  settings: ChatPlaybooksSettings,
  connectionId: string,
  override: ChannelPlaybooks,
): ChatPlaybooksSettings {
  return {
    ...settings,
    connections: settings.connections.map((connection) => {
      if (connection.id !== connectionId) return connection;
      const others = connection.channels.filter((c) => c.channelId !== override.channelId);
      return {
        ...connection,
        channels: [...others, override].sort((a, b) => a.channelId.localeCompare(b.channelId)),
      };
    }),
  };
}

/** `settings` without the override of `channelId` on `connectionId`. */
export function withoutOverride(
  settings: ChatPlaybooksSettings,
  connectionId: string,
  channelId: string,
): ChatPlaybooksSettings {
  return {
    ...settings,
    connections: settings.connections.map((connection) =>
      connection.id === connectionId
        ? { ...connection, channels: connection.channels.filter((c) => c.channelId !== channelId) }
        : connection,
    ),
  };
}

function AppLink({ href, children }: { href: string; children: ReactNode }) {
  const link = useLinkComponent();
  return createElement(link, { href, className: "or-link" }, children);
}

/** A slot's options: its playbooks (built-ins marked), plus a saved one it no longer offers. */
function PlaybookOptions({
  settings,
  slot,
  current,
}: {
  settings: ChatPlaybooksSettings;
  slot: ChatSlot;
  current: string | null;
}) {
  const choices = settings.choices[slot];
  return (
    <>
      {current !== null && current !== "" && !choices.some((choice) => choice.id === current) ? (
        <option value={current}>{current}</option>
      ) : null}
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.builtin ? `${choice.name} (built-in)` : choice.name}
        </option>
      ))}
    </>
  );
}

// ── Organization default ─────────────────────────────────────────────────────

type DefaultsDraft = Record<ChatSlot, string>;

/** The save bar's items: each slot whose playbook changed. */
export function defaultsChanges(
  settings: ChatPlaybooksSettings,
): (saved: DefaultsDraft, draft: DefaultsDraft) => StagedChange[] {
  return (saved, draft) =>
    SLOTS.filter((slot) => saved[slot] !== draft[slot]).map((slot) => ({
      id: slot,
      label: SLOT_LABELS[slot],
      from: playbookName(settings, slot, saved[slot]),
      to: playbookName(settings, slot, draft[slot]),
      effect:
        slot === "ask"
          ? "Channels without their own choice answer questions with it."
          : "Channels without their own choice start work with it.",
    }));
}

/**
 * The organization's two chat playbooks, staged in a `SaveBar` and saved with one
 * `PUT /api/ui/integrations/chat-tasks`; the saved choice is written into the cache at once.
 * A playbook of the wrong role (or gone) shows the server's message under its select.
 */
function DefaultsCard({
  settings,
  isAdmin,
}: {
  settings: ChatPlaybooksSettings;
  isAdmin: boolean;
}) {
  const saved = useMemo<DefaultsDraft>(
    () => ({ ask: settings.defaults.ask, startWork: settings.defaults.startWork }),
    [settings.defaults.ask, settings.defaults.startWork],
  );
  const toChanges = useMemo(() => defaultsChanges(settings), [settings]);
  const card = useStagedCard<DefaultsDraft, MutationResult>({
    label: "Organization default",
    saved,
    toChanges,
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.put("/api/ui/integrations/chat-tasks", mutationResultSchema, {
          body: { ask: draft.ask, startWork: draft.startWork },
          organizationId,
        }),
      applyResult: (_result, cache, draft) =>
        cache.set<ChatPlaybooksSettings>(
          chatPlaybooksKey(cache.keys),
          (previous) => previous && { ...previous, defaults: { ...draft } },
          { exact: true },
        ),
      success: "Saved the chat playbooks",
    }),
    onDirtyChange: useUnsavedCard("Organization default"),
  });

  return (
    <Card title="Organization default" titleId="chat-defaults">
      {SLOTS.map((slot) => (
        <Field
          key={slot}
          label={SLOT_LABELS[slot]}
          description={SLOT_DESCRIPTIONS[slot]}
          htmlFor={`chat-default-${slot}`}
        >
          <Select
            id={`chat-default-${slot}`}
            value={card.draft[slot]}
            disabled={!isAdmin || card.saving}
            errorMessage={card.fieldErrors[slot]}
            onChange={(event) => card.set(slot, event.target.value)}
          >
            <PlaybookOptions settings={settings} slot={slot} current={card.draft[slot]} />
          </Select>
        </Field>
      ))}
      {isAdmin ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
        />
      ) : null}
    </Card>
  );
}

// ── Channel overrides ────────────────────────────────────────────────────────

/** An override's playbook for a slot, or "Organization default" when it keeps that. */
function playbookCell(settings: ChatPlaybooksSettings, slot: ChatSlot, id: string | null) {
  return id === null ? (
    <span className="or-chat__default">{ORGANIZATION_DEFAULT}</span>
  ) : (
    playbookName(settings, slot, id)
  );
}

function overrideColumns(
  settings: ChatPlaybooksSettings,
  isAdmin: boolean,
  onEdit: (row: OverrideRow) => void,
  onRemove: (row: OverrideRow) => void,
): DataTableColumn<OverrideRow>[] {
  const playbook = (slot: ChatSlot) => (row: OverrideRow) =>
    playbookCell(settings, slot, row.override[slot]);
  const columns: DataTableColumn<OverrideRow>[] = [
    {
      id: "channel",
      header: "Channel",
      card: "title",
      mono: true,
      cell: (row) => row.override.channel,
    },
    {
      id: "workspace",
      header: "Workspace",
      cell: (row) => (
        <span className="or-chat__workspace">
          <BrandMark brand={row.connection.platform} />
          <span>{row.connection.name}</span>
        </span>
      ),
    },
    { id: "ask", header: SLOT_LABELS.ask, cell: playbook("ask") },
    { id: "startWork", header: SLOT_LABELS.startWork, cell: playbook("startWork") },
  ];
  if (!isAdmin) return columns;
  return [
    ...columns,
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      card: "status",
      align: "end",
      cell: (row) => (
        <span className="or-chat__actions">
          <IconButton
            label={`Edit override for ${row.override.channel}`}
            icon={IconPencil}
            variant="ghost"
            onClick={() => onEdit(row)}
          />
          <IconButton
            label={`Remove override for ${row.override.channel}`}
            icon={IconTrash}
            variant="ghost"
            onClick={() => onRemove(row)}
          />
        </span>
      ),
    },
  ];
}

/** What the sheet edits: a new override, or one of the table's. */
type Editing = { row: OverrideRow | null; session: number } | null;

interface OverrideInput {
  connectionId: string;
  channel: string;
  ask: string | null;
  startWork: string | null;
}

/**
 * Adding or editing a channel override: the connection, the channel (its ID, or its name,
 * which the server looks up) and each slot's playbook or "Organization default". Saved with
 * `PUT /api/ui/integrations/chat-connections/{id}/channels`, whose answer (the stored
 * override) is written into the cache before the sheet closes.
 */
function OverrideSheet({
  settings,
  row,
  onClose,
}: {
  settings: ChatPlaybooksSettings;
  row: OverrideRow | null;
  onClose: () => void;
}) {
  const [connectionId, setConnectionId] = useState(
    row?.connection.id ?? settings.connections[0]?.id ?? "",
  );
  const [channel, setChannel] = useState(row?.override.channel ?? "");
  const [choice, setChoice] = useState<Record<ChatSlot, string>>({
    ask: row?.override.ask ?? "",
    startWork: row?.override.startWork ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useApiMutation({
    mutationFn: (input: OverrideInput, { organizationId }) =>
      api.put(
        `/api/ui/integrations/chat-connections/${encodeURIComponent(input.connectionId)}/channels`,
        savedChannelPlaybooksSchema,
        {
          body: { channel: input.channel, ask: input.ask, startWork: input.startWork },
          organizationId,
        },
      ),
    applyResult: (result, cache, input) =>
      cache.set<ChatPlaybooksSettings>(
        chatPlaybooksKey(cache.keys),
        (previous) => previous && withOverride(previous, input.connectionId, result.channel),
        { exact: true },
      ),
    invalidate: (keys) => [chatPlaybooksKey(keys)],
    success: (result) =>
      row ? `Saved the override for ${result.channel.channel}` : `Added ${result.channel.channel}`,
    onSuccess: onClose,
    onError: (failure: ApiError) => {
      const fieldErrors = failure.fieldErrors ?? {};
      setErrors(fieldErrors);
      setFormError(Object.keys(fieldErrors).length > 0 ? null : failure.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const ask = choice.ask || null;
    const startWork = choice.startWork || null;
    if (!channel.trim()) {
      setErrors({ channel: CHANNEL_REQUIRED });
      setFormError(null);
      return;
    }
    if (ask === null && startWork === null) {
      setErrors({});
      setFormError(PLAYBOOK_REQUIRED);
      return;
    }
    setErrors({});
    setFormError(null);
    save.mutate({ connectionId, channel: channel.trim(), ask, startWork });
  };

  const defaultName = (slot: ChatSlot) =>
    `${ORGANIZATION_DEFAULT} (${playbookName(settings, slot, settings.defaults[slot])})`;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={row ? `Edit override for ${row.override.channel}` : "Add override"}
      description="The channel runs these playbooks instead of the organization's."
    >
      <form className="or-chat-sheet" onSubmit={submit} noValidate>
        <Field label="Connection" htmlFor="chat-override-connection" stacked>
          <Select
            id="chat-override-connection"
            value={connectionId}
            disabled={row !== null}
            onChange={(event) => setConnectionId(event.target.value)}
          >
            {settings.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connectionLabel(connection)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Channel"
          description="The channel's ID (C0123ABCD in Slack) or its name (#general)."
          htmlFor="chat-override-channel"
          stacked
        >
          <TextInput
            id="chat-override-channel"
            mono
            value={channel}
            readOnly={row !== null}
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            errorMessage={errors.channel}
            onChange={(event) => {
              setChannel(event.target.value);
              setErrors(({ channel: _, ...rest }) => rest);
            }}
          />
        </Field>
        {SLOTS.map((slot) => (
          <Field key={slot} label={SLOT_LABELS[slot]} htmlFor={`chat-override-${slot}`} stacked>
            <Select
              id={`chat-override-${slot}`}
              value={choice[slot]}
              errorMessage={errors[slot]}
              onChange={(event) => {
                const value = event.target.value;
                setChoice((current) => ({ ...current, [slot]: value }));
                setErrors(({ [slot]: _, ...rest }) => rest);
                setFormError(null);
              }}
            >
              <option value="">{defaultName(slot)}</option>
              <PlaybookOptions settings={settings} slot={slot} current={choice[slot] || null} />
            </Select>
          </Field>
        ))}
        {formError ? (
          <p role="alert" className="or-chat__error">
            {formError}
          </p>
        ) : null}
        <div className="or-chat-sheet__actions">
          <Button type="submit" variant="solid" disabled={save.isPending}>
            {save.isPending ? "Saving…" : row ? "Save override" : "Add override"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * Each chat connection's channel overrides, with Edit and Remove for admins and "Add
 * override" opening the sheet. Removing asks first, then drops the row at once (put back
 * with the danger toast if the server refuses). Without a chat connection there is nothing
 * to override: it says to connect one.
 */
function OverridesCard({
  settings,
  isAdmin,
}: {
  settings: ChatPlaybooksSettings;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  // The override the remove dialog asks about; kept while the dialog closes.
  const [target, setTarget] = useState<OverrideRow | null>(null);
  const [confirming, setConfirming] = useState(false);
  const remove = useApiMutation({
    mutationFn: (row: OverrideRow, { organizationId }) =>
      api.delete(
        `/api/ui/integrations/chat-connections/${encodeURIComponent(row.connection.id)}/channels`,
        mutationResultSchema,
        { body: { channelId: row.override.channelId }, organizationId },
      ),
    optimistic: (row, cache) =>
      cache.set<ChatPlaybooksSettings>(
        chatPlaybooksKey(cache.keys),
        (previous) =>
          previous && withoutOverride(previous, row.connection.id, row.override.channelId),
        { exact: true },
      ),
    invalidate: (keys) => [chatPlaybooksKey(keys)],
    success: (_result, row) => `Removed the override for ${row.override.channel}`,
  });

  const hasConnections = settings.connections.length > 0;
  const rows = overrideRows(settings);
  const open = (row: OverrideRow | null) =>
    setEditing((current) => ({ row, session: (current?.session ?? 0) + 1 }));

  return (
    <Card
      title="Channel overrides"
      titleId="chat-overrides"
      actions={
        isAdmin && hasConnections ? (
          <Button icon={IconPlus} size="sm" onClick={() => open(null)}>
            Add override
          </Button>
        ) : undefined
      }
    >
      {!hasConnections ? (
        <p className="or-chat__note">
          {NO_CHAT_CONNECTION} <AppLink href={SETTINGS_PATHS.addConnection}>Add connection</AppLink>
        </p>
      ) : rows.length === 0 ? (
        <p className="or-chat__note">{NO_OVERRIDES}</p>
      ) : (
        <DataTable
          caption="Channel overrides"
          rows={rows}
          getRowId={(row) => `${row.connection.id}:${row.override.channelId}`}
          columns={overrideColumns(settings, isAdmin, open, (row) => {
            setTarget(row);
            setConfirming(true);
          })}
        />
      )}
      {editing ? (
        <OverrideSheet
          key={editing.session}
          settings={settings}
          row={editing.row}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={target ? `Remove the override for ${target.override.channel}?` : ""}
        description={
          target
            ? `${target.override.channel} in ${target.connection.name} uses the organization default again.`
            : ""
        }
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (target) remove.mutate(target);
        }}
      />
    </Card>
  );
}

/**
 * Advanced › Chat channel overrides: the playbooks chat answers questions and starts work
 * with, for the whole organization and per channel. Every member sees them; admins change
 * them. A live query: another admin's save arrives through the `settings` event (section
 * `chat_playbooks`).
 */
export function ChatOverridesSettings() {
  const query = useChatPlaybooks();
  const { role } = useCurrentUser();
  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    return (
      <EmptyState
        title="Couldn't load the chat playbooks"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const isAdmin = role === "admin";
  return (
    <>
      <DefaultsCard settings={query.data} isAdmin={isAdmin} />
      <OverridesCard settings={query.data} isAdmin={isAdmin} />
    </>
  );
}
