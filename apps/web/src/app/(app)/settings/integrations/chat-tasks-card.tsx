"use client";

import * as React from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Cluster,
  Field,
  Input,
  InlineCode,
  Muted,
  NativeSelect,
  Stack,
} from "@iamthemcmaster/ui";
import { IconArrowBackUp, IconDeviceFloppy, IconPlus, IconTrash } from "@tabler/icons-react";
import { SettingsCard } from "@/components/settings-card";
import { useUnsavedChanges } from "@/components/unsaved-changes";
import { useApiAction } from "@/components/use-api-action";
import { useApiMutation } from "@/components/use-api-mutation";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { api } from "@/lib/api/client";
import type {
  ChannelTasks,
  ChannelTasksInput,
  ChatTasksSettings,
  TaskChoice,
} from "@/lib/api/integrations";
import { mutationResultSchema } from "@/lib/api/schemas";
import { settingChanges, withDefault, type SettingSpec } from "@/lib/settings/changes";
import { integrationsChanged } from "./integrations-queries";

export type { ChannelTasks, ChatTasksSettings, TaskChoice };

type Role = "askAboutCode" | "startWork";

const ROLES: readonly Role[] = ["askAboutCode", "startWork"];

const LABELS: Record<Role, string> = {
  askAboutCode: "Ask about code",
  startWork: "Start work",
};

/** The request that saves a channel's tasks (`PUT …/chat-connections/[id]/channels`). */
const saveChannel = (connectionId: string, input: ChannelTasksInput, organizationId: string) =>
  api.put(`/api/ui/integrations/chat-connections/${connectionId}/channels`, mutationResultSchema, {
    body: input,
    organizationId,
  });

/** A form's task choices as the request sends them: "" keeps the organization's task. */
const channelInput = (channel: string, tasks: Record<Role, string>): ChannelTasksInput => ({
  channel,
  askAboutCode: tasks.askAboutCode || null,
  startWork: tasks.startWork || null,
});

/** The options of a task picker; a current task that's no longer a choice stays listed. */
function TaskOptions({ choices, value }: { choices: TaskChoice[]; value: string }) {
  return (
    <>
      {value && !choices.some((c) => c.id === value) && (
        <option value={value}>{value} (unavailable)</option>
      )}
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.builtin ? `${choice.name} (built-in)` : choice.name}
        </option>
      ))}
    </>
  );
}

const SPEC_DESCRIPTIONS: Record<Role, string> = {
  askAboutCode: "Answers a question about code asked in Slack or Discord.",
  startWork: "Handles a request to start work made in Slack or Discord.",
};

/**
 * Settings › Integrations: the tasks chat runs for the organization (a settings card that
 * confirms its change list), and each connection's channel overrides.
 */
export function ChatTasksCard({
  defaults,
  builtinDefaults,
  choices,
  connections,
}: ChatTasksSettings) {
  const apiAction = useApiAction();
  // Follows a change saved elsewhere while the card isn't being edited.
  const [chosen, setChosen] = useSeededDraft(defaults);
  const names = new Map(
    ROLES.flatMap((role) => choices[role].map((choice) => [choice.id, choice.name] as const)),
  );
  const nameOf = (id: string) => names.get(id) ?? id;
  const specs: SettingSpec<Role>[] = ROLES.map((role) => ({
    key: role,
    label: LABELS[role],
    format: (value) => (typeof value === "string" ? nameOf(value) : String(value)),
  }));
  const changes = settingChanges(specs, defaults, chosen);

  return (
    <>
      <SettingsCard
        title="Chat tasks"
        description="The tasks a question about code and a request to start work run when asked in Slack or Discord. A channel can run different ones."
        changes={changes}
        prepare={() => ({
          action: () =>
            apiAction(
              ({ organizationId }) =>
                api.put("/api/ui/integrations/chat-tasks", mutationResultSchema, {
                  body: chosen,
                  organizationId,
                }),
              integrationsChanged,
            ),
          success: "Saved the chat tasks",
        })}
        onDiscard={() => setChosen(defaults)}
        confirm={{
          consequence:
            "The next question or request in every channel without its own tasks runs the new task.",
        }}
      >
        <div className="settings-row">
          {ROLES.map((role) => (
            <Field
              key={role}
              label={LABELS[role]}
              htmlFor={`chat-task-${role}`}
              description={withDefault(SPEC_DESCRIPTIONS[role], nameOf(builtinDefaults[role]))}
            >
              <NativeSelect
                id={`chat-task-${role}`}
                value={chosen[role]}
                onChange={(e) => setChosen({ ...chosen, [role]: e.target.value })}
              >
                <TaskOptions choices={choices[role]} value={chosen[role]} />
              </NativeSelect>
            </Field>
          ))}
        </div>
      </SettingsCard>

      <Card>
        <CardHeader>
          <CardTitle as="h2">Channel tasks</CardTitle>
          <CardDescription>
            Channels that run different tasks from the organization&apos;s. Each change saves on its
            own.
          </CardDescription>
        </CardHeader>
        <Stack gap={6} asChild>
          <CardContent>
            {connections.length === 0 ? (
              <Muted>Connect Slack or Discord to give a channel its own tasks.</Muted>
            ) : (
              connections.map((connection) => (
                <ConnectionChannels key={connection.id} connection={connection} choices={choices} />
              ))
            )}
          </CardContent>
        </Stack>
      </Card>
    </>
  );
}

/** A connection's channel overrides: change or remove each, and add one by channel ID. */
function ConnectionChannels({
  connection,
  choices,
}: {
  connection: ChatTasksSettings["connections"][number];
  choices: ChatTasksSettings["choices"];
}) {
  const [channel, setChannel] = React.useState("");
  const [tasks, setTasks] = React.useState<Record<Role, string>>({
    askAboutCode: "",
    startWork: "",
  });
  const add = useApiMutation({
    mutationFn: (input: ChannelTasksInput, { organizationId }) =>
      saveChannel(connection.id, input, organizationId),
    invalidate: integrationsChanged,
    success: (_, input) => `Channel ${input.channel.trim()} runs its own tasks`,
    onSuccess: () => {
      setChannel("");
      setTasks({ askAboutCode: "", startWork: "" });
    },
  });
  const pending = add.isPending;
  const platform = connection.platform === "slack" ? "Slack" : "Discord";
  const prefix = `chat-channel-${connection.id}`;

  return (
    <Stack gap={2} asChild>
      <section>
        <strong>
          {connection.name} <Muted>({platform})</Muted>
        </strong>
        {connection.channels.length === 0 ? (
          <Muted>No channel runs different tasks.</Muted>
        ) : (
          connection.channels.map((override) => (
            <ChannelRow
              key={override.channelId}
              connectionId={connection.id}
              override={override}
              choices={choices}
            />
          ))
        )}
        <Cluster gap={3} align="end" asChild>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(channelInput(channel, tasks));
            }}
          >
            <Field
              label={`${platform} channel ID`}
              htmlFor={`${prefix}-channel`}
              className="flex-1"
            >
              <Input
                id={`${prefix}-channel`}
                autoComplete="off"
                placeholder={
                  connection.platform === "slack" ? "e.g. C0123ABCD" : "e.g. 123456789012345678"
                }
                value={channel}
                disabled={pending}
                onChange={(e) => setChannel(e.target.value)}
              />
            </Field>
            {ROLES.map((role) => (
              <Field
                key={role}
                label={LABELS[role]}
                htmlFor={`${prefix}-${role}`}
                className="flex-1"
              >
                <NativeSelect
                  id={`${prefix}-${role}`}
                  value={tasks[role]}
                  disabled={pending}
                  onChange={(e) => setTasks({ ...tasks, [role]: e.target.value })}
                >
                  <option value="">Organization&apos;s task</option>
                  <TaskOptions choices={choices[role]} value={tasks[role]} />
                </NativeSelect>
              </Field>
            ))}
            <Button
              type="submit"
              variant="secondary"
              disabled={pending || !channel.trim() || (!tasks.askAboutCode && !tasks.startWork)}
            >
              <IconPlus size={14} />
              Add channel
            </Button>
          </form>
        </Cluster>
      </section>
    </Stack>
  );
}

function ChannelRow({
  connectionId,
  override,
  choices,
}: {
  connectionId: string;
  override: ChannelTasks;
  choices: ChatTasksSettings["choices"];
}) {
  const initial = {
    askAboutCode: override.askAboutCode ?? "",
    startWork: override.startWork ?? "",
  };
  // Follows a change saved elsewhere while the row isn't being edited.
  const [tasks, setTasks] = useSeededDraft<Record<Role, string>>(initial);
  const save = useApiMutation({
    mutationFn: (input: ChannelTasksInput, { organizationId }) =>
      saveChannel(connectionId, input, organizationId),
    invalidate: integrationsChanged,
    success: `Saved channel ${override.channel}'s tasks`,
  });
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(
        `/api/ui/integrations/chat-connections/${connectionId}/channels`,
        mutationResultSchema,
        { body: { channelId: override.channelId }, organizationId },
      ),
    invalidate: integrationsChanged,
    success: `Channel ${override.channel} runs the organization's tasks`,
  });
  const pending = save.isPending || remove.isPending;
  const changed = ROLES.some((role) => tasks[role] !== initial[role]);
  const prefix = `chat-channel-${connectionId}-${override.channel}`;
  useUnsavedChanges(`Channel ${override.channel}`, prefix, changed);

  return (
    <Cluster id={prefix} gap={3} align="end" className="settings-card">
      <div className="flex-1 pb-2">
        <InlineCode>{override.channel}</InlineCode>
      </div>
      {ROLES.map((role) => (
        <Field key={role} label={LABELS[role]} htmlFor={`${prefix}-${role}`} className="flex-1">
          <NativeSelect
            id={`${prefix}-${role}`}
            value={tasks[role]}
            disabled={pending}
            onChange={(e) => setTasks({ ...tasks, [role]: e.target.value })}
          >
            <option value="">Organization&apos;s task</option>
            <TaskOptions choices={choices[role]} value={tasks[role]} />
          </NativeSelect>
        </Field>
      ))}
      <Button
        variant="secondary"
        disabled={pending || !changed || (!tasks.askAboutCode && !tasks.startWork)}
        onClick={() => save.mutate(channelInput(override.channel, tasks))}
      >
        <IconDeviceFloppy size={14} />
        Save
      </Button>
      {changed && (
        <Button variant="ghost" disabled={pending} onClick={() => setTasks(initial)}>
          <IconArrowBackUp size={14} />
          Discard
        </Button>
      )}
      <Button
        variant="danger"
        disabled={pending}
        aria-label={`Remove channel ${override.channel}`}
        onClick={() => remove.mutate()}
      >
        <IconTrash size={14} />
        Remove
      </Button>
    </Cluster>
  );
}
