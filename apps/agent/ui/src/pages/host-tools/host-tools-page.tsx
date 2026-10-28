/**
 * Host tools (`/host-tools`): each tool configured in `settings.json`, checked by the agent
 * or required by a playbook, with its status and path. "Set path…" and "Add host tool…"
 * save the whole map through `PUT /api/settings/host-tools` against the revision the page
 * read; the row shows the new path at once as "Checking…", and the agent's check arrives as
 * a `host_tools` event. "Never run from" shows `agent.json`'s `blockedExecPaths`.
 */
import { effectiveLocalSettings } from "@omniralph/shared";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  MetaBadge,
  Sheet,
  StatusText,
  TextInput,
  Toolbar,
  type DataTableColumn,
} from "@omniralph/ui";
import { IconPlus } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { LocalSettingsState } from "../../../../src/settings.js";
import type { AgentUiHostTools } from "../../../../src/ui/state.js";
import { localRequest } from "../../api.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation } from "../../live/use-local-mutation.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import { withSettings } from "../settings.js";
import {
  NEVER_RUN_FROM_DESCRIPTION,
  hostToolPath,
  hostToolRows,
  hostToolStatus,
  nameError,
  pathError,
  withHostToolPath,
  type HostToolRow,
} from "./model.js";

interface HostToolSave {
  name: string;
  /** null: "Use PATH". */
  path: string | null;
  revision: string;
  hostTools: Record<string, string>;
}

/** The settings once `hostTools` is saved, for the optimistic state. */
function settingsWith(settings: LocalSettingsState, hostTools: Record<string, string>) {
  const next = { ...settings.settings };
  if (Object.keys(hostTools).length === 0) delete next.hostTools;
  else next.hostTools = hostTools;
  return { ...settings, settings: next, effective: effectiveLocalSettings(next) };
}

/**
 * Sets or clears one tool's path. The row shows it at once ("Checking…"); a failure rolls it
 * back with a danger toast, and a 409 then writes the file's current settings into the state.
 */
function useSaveHostTool() {
  const client = useQueryClient();
  return useLocalMutation<LocalSettingsState, HostToolSave>({
    mutationFn: ({ revision, hostTools }) =>
      localRequest<LocalSettingsState>("/api/settings/host-tools", {
        method: "PUT",
        body: { revision, hostTools },
      }),
    invalidate: () => [agentKeys.state],
    success: ({ settings }, { name, path }) =>
      path === null && !settings.hostTools?.[name]
        ? `${name} is looked up on PATH`
        : `${name} path saved`,
    optimistic: ({ hostTools }, cache) =>
      cache.set<AgentUiState>(
        cache.keys.state,
        (state) => state && withSettings(state, settingsWith(state.settings, hostTools)),
        { exact: true },
      ),
    applyResult: (result, cache) =>
      cache.set<AgentUiState>(cache.keys.state, (state) => withSettings(state, result), {
        exact: true,
      }),
    onError: (error) => {
      if (error.status === 409) {
        const latest = (error.body as { settings?: LocalSettingsState } | undefined)?.settings;
        if (latest) {
          client.setQueryData<AgentUiState>(agentKeys.state, (state) =>
            withSettings(state, latest),
          );
        }
      }
    },
  });
}

/** The sheet: setting a row's path, or adding a tool. */
type Editing = { kind: "path"; row: HostToolRow } | { kind: "add" };

export function HostToolsPage() {
  const state = useAgentState();
  const client = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const save = useSaveHostTool();
  const settings = state.data?.settings;
  const hostTools = state.data?.hostTools;
  const configured = settings?.effective.hostTools ?? {};
  const rows = hostTools ? hostToolRows(configured, hostTools) : [];

  return (
    <AgentPage
      title="Host tools"
      actions={
        <Toolbar
          label="Host tool actions"
          actions={[
            {
              label: "Add host tool…",
              icon: IconPlus,
              onSelect: () => setEditing({ kind: "add" }),
              disabled: !settings,
            },
          ]}
        />
      }
    >
      {state.isError ? (
        <EmptyState title="Can't load the host tools" description={state.error.message} />
      ) : null}
      {settings && settings.lastError !== null ? (
        <p role="alert" className="agent-alert">
          settings.json isn't valid: {settings.lastError}; the agent keeps its last good settings
        </p>
      ) : null}
      {hostTools ? (
        <>
          <Card title="Tools">
            {rows.length === 0 ? (
              <EmptyState title="No host tools" />
            ) : (
              <HostToolsTable rows={rows} onSetPath={(row) => setEditing({ kind: "path", row })} />
            )}
          </Card>
          <NeverRunFromCard hostTools={hostTools} />
        </>
      ) : null}
      <Sheet
        title={editing?.kind === "path" ? `Set path for ${editing.row.name}` : "Add host tool"}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing && settings ? (
          <HostToolForm
            editing={editing}
            known={rows}
            saving={save.isPending}
            onSave={(name, path) => {
              // The revision and map as the page has them now, before the optimistic write.
              const current = client.getQueryData<AgentUiState>(agentKeys.state)?.settings;
              save.mutate({
                name,
                path,
                revision: current?.revision ?? settings.revision,
                hostTools: withHostToolPath(current?.effective.hostTools ?? configured, name, path),
              });
            }}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Sheet>
    </AgentPage>
  );
}

function HostToolsTable({
  rows,
  onSetPath,
}: {
  rows: HostToolRow[];
  onSetPath: (row: HostToolRow) => void;
}) {
  const columns: DataTableColumn<HostToolRow>[] = [
    {
      id: "name",
      header: "Name",
      card: "title",
      cell: (row) => (
        <span className="agent-tool-name">
          <span className="or-mono">{row.name}</span>
          {row.required ? <MetaBadge text="Required" /> : null}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      card: "status",
      cell: (row) => {
        const { text, tone } = hostToolStatus(row);
        return <StatusText tone={tone}>{text}</StatusText>;
      },
    },
    {
      id: "path",
      header: "Path",
      mono: true,
      cell: (row) => hostToolPath(row) ?? "—",
    },
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      align: "end",
      cell: (row) => (
        <Button size="sm" onClick={() => onSetPath(row)} aria-label={`Set path for ${row.name}…`}>
          Set path…
        </Button>
      ),
    },
  ];
  return (
    <DataTable
      caption="Host tools"
      rows={rows}
      getRowId={(row) => row.name}
      columns={columns}
      rowTone={(row) => (hostToolStatus(row).tone === "fail" ? "bad" : undefined)}
    />
  );
}

function HostToolForm({
  editing,
  known,
  saving,
  onSave,
  onDone,
}: {
  editing: Editing;
  known: readonly HostToolRow[];
  saving: boolean;
  /** Saves `name`'s path (null: "Use PATH"); the sheet closes and the row shows it at once. */
  onSave: (name: string, path: string | null) => void;
  onDone: () => void;
}) {
  const row = editing.kind === "path" ? editing.row : null;
  const [name, setName] = useState("");
  const [path, setPath] = useState(row?.configuredPath ?? "");
  const [nameMessage, setNameMessage] = useState<string | null>(null);
  const [pathMessage, setPathMessage] = useState<string | null>(null);

  const submit = (toolName: string, toolPath: string | null) => {
    onSave(toolName, toolPath);
    onDone();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const toolName = row ? row.name : name.trim();
    const nameProblem = row ? null : nameError(name);
    const taken =
      !row && !nameProblem && known.some((tool) => tool.name === toolName && tool.configuredPath)
        ? `${toolName} already has a path`
        : null;
    const pathProblem = pathError(path);
    setNameMessage(nameProblem ?? taken);
    setPathMessage(pathProblem);
    if (nameProblem || taken || pathProblem) return;
    submit(toolName, path.trim());
  };

  return (
    <form className="agent-install" onSubmit={onSubmit} noValidate>
      {row ? null : (
        <Field label="Name" stacked>
          <TextInput
            mono
            value={name}
            placeholder="opengrep"
            autoComplete="off"
            spellCheck={false}
            required
            onChange={(event) => {
              setName(event.target.value);
              setNameMessage(null);
            }}
            errorMessage={nameMessage ?? undefined}
          />
        </Field>
      )}
      <Field label="Path" stacked>
        <TextInput
          mono
          value={path}
          placeholder="/usr/local/bin/opengrep"
          autoComplete="off"
          spellCheck={false}
          required
          onChange={(event) => {
            setPath(event.target.value);
            setPathMessage(null);
          }}
          errorMessage={pathMessage ?? undefined}
        />
      </Field>
      <div className="agent-install__actions">
        <Button type="submit" variant="solid" disabled={saving}>
          Save
        </Button>
        {row ? (
          <Button
            type="button"
            disabled={row.configuredPath === null || saving}
            onClick={() => submit(row.name, null)}
          >
            Use PATH
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NeverRunFromCard({ hostTools }: { hostTools: AgentUiHostTools }) {
  return (
    <Card title="Never run from">
      <p className="agent-card-description">{NEVER_RUN_FROM_DESCRIPTION}</p>
      {hostTools.blockedExecPaths.length === 0 ? (
        <p className="agent-card-description">None</p>
      ) : (
        <ul className="agent-paths">
          {hostTools.blockedExecPaths.map((path) => (
            <li key={path} className="or-mono">
              {path}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
