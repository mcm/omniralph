/**
 * Packages (`/packages`): the installed installables (Update, and Remove… in the ⋯ menu),
 * the "Install package…" sheet, the allow-list (a staged card saved to `settings.json`
 * through `PUT /api/settings/allow-list`) and the install history, whose rows open a sheet
 * with npm's output (`/packages/history/<id>`). Installs, updates and removals show in the
 * history at once and turn installed or failed from the agent's `packages` events. A failed
 * entry's sheet offers the next step: Retry install, and Remove… while the package is installed.
 */
import { installableAllowed } from "@omniralph/shared";
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  Menu,
  MetaBadge,
  SaveBar,
  ScrollRegion,
  Sheet,
  StatusText,
  TextInput,
  TokenInput,
  Toolbar,
  useStagedCard,
  type DataTableColumn,
  type StagedSaveError,
  IconRetry,
} from "@omniralph/ui";
import { IconDots, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { InstallRecord } from "../../../../src/packages/history.js";
import type { LocalSettingsState } from "../../../../src/settings.js";
import { LocalApiError, localRequest } from "../../api.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation, type LocalMutationCache } from "../../live/use-local-mutation.js";
import { useNavigate } from "../../router.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import { SETTINGS_CHANGED, withSettings } from "../settings.js";
import {
  ALLOW_LIST_DESCRIPTION,
  DEFAULT_INSTALL_VERSION,
  FROM_LABELS,
  INSTALL_SHEET_DESCRIPTION,
  NO_PACKAGE_INSTALLABLE,
  PACKAGE_NAME_REQUIRED,
  allowListChanges,
  formatTime,
  installOutcome,
  installPackageLabel,
  patternError,
  pendingInstall,
  pendingRemoval,
  type InstallHistoryList,
  type InstallSummary,
  type InstalledPackage,
  type InstalledPackages,
} from "./model.js";

export const PACKAGES_PATH = "/packages";

/** A history row's sheet. */
export function installHistoryPath(id: string): string {
  return `${PACKAGES_PATH}/history/${encodeURIComponent(id)}`;
}

function usePackages() {
  return useQuery({
    queryKey: agentKeys.packages.list,
    queryFn: ({ signal }) => localRequest<InstalledPackages>("/api/packages", { signal }),
  });
}

function useInstallHistory() {
  return useQuery({
    queryKey: agentKeys.packages.history,
    queryFn: ({ signal }) => localRequest<InstallHistoryList>("/api/packages/history", { signal }),
  });
}

/** Puts `install` at the top of the history (replacing the entry `replaces`, if any). */
function addToHistory(cache: LocalMutationCache, install: InstallSummary, replaces?: string) {
  return cache.set<InstallHistoryList>(
    cache.keys.packages.history,
    (list) => ({
      installs: [
        install,
        ...(list?.installs ?? []).filter(
          (entry) => entry.id !== install.id && entry.id !== replaces,
        ),
      ],
    }),
    { exact: true },
  );
}

let pendingIds = 0;
const nextPendingId = () => `pending-${++pendingIds}`;

interface InstallRequest {
  name: string;
  version: string;
  /** The history entry shown until the agent answers. */
  pendingId: string;
}

/** Removal: the history shows "Removing <name>…" before the agent answers. */
function useRemove() {
  return useLocalMutation<InstallSummary, InstalledPackage & { pendingId: string }>({
    mutationFn: ({ name }) =>
      // A body, so the request carries the JSON content type every change needs.
      localRequest<InstallSummary>(`/api/packages/${encodeURIComponent(name)}`, {
        method: "DELETE",
        body: {},
      }),
    invalidate: () => [agentKeys.packages.all],
    optimistic: (request, cache) => addToHistory(cache, pendingRemoval(request.pendingId, request)),
    applyResult: (removal, cache, request) => addToHistory(cache, removal, request.pendingId),
    success: null,
  });
}

/** Install or update: the history shows "Installing <name>…" before the agent answers. */
function useInstall(onSuccess?: () => void, onError?: (error: LocalApiError) => void) {
  return useLocalMutation<InstallSummary, InstallRequest>({
    mutationFn: ({ name, version }) =>
      localRequest<InstallSummary>("/api/packages", { method: "POST", body: { name, version } }),
    invalidate: () => [agentKeys.packages.all],
    optimistic: (request, cache) => addToHistory(cache, pendingInstall(request.pendingId, request)),
    applyResult: (install, cache, request) => addToHistory(cache, install, request.pendingId),
    success: null,
    onSuccess,
    onError,
  });
}

export function PackagesPage({ historyId }: { historyId?: string }) {
  const state = useAgentState();
  const navigate = useNavigate();
  // The install sheet, with the package it opened for (a row's "Install a version…").
  const [installing, setInstalling] = useState<{ name: string } | null>(null);
  // The package "Remove…" asks about, from its row's ⋯ menu or a failed entry's sheet.
  const [removing, setRemoving] = useState<InstalledPackage | null>(null);
  const remove = useRemove();
  const allow = state.data?.settings.effective.installablesAllow;
  const noneAllowed = allow !== undefined && allow.length === 0;

  return (
    <AgentPage
      title="Packages"
      actions={
        <Toolbar
          label="Package actions"
          actions={[
            {
              label: "Install package…",
              icon: IconPlus,
              onSelect: () => setInstalling({ name: "" }),
              disabled: noneAllowed,
              ...(noneAllowed && { disabledReason: NO_PACKAGE_INSTALLABLE }),
            },
          ]}
        />
      }
    >
      <InstalledCard
        noneAllowed={noneAllowed}
        onInstallVersion={(name) => setInstalling({ name })}
        onRemove={setRemoving}
      />
      {state.data ? (
        <AllowListCard settings={state.data.settings} />
      ) : state.isError ? (
        <EmptyState title="Can't load the settings" description={state.error.message} />
      ) : null}
      <HistoryCard />
      <Sheet
        title="Install package"
        description={INSTALL_SHEET_DESCRIPTION}
        open={installing !== null}
        onOpenChange={(open) => {
          if (!open) setInstalling(null);
        }}
      >
        {installing ? (
          <InstallForm
            allow={allow ?? []}
            initialName={installing.name}
            onDone={() => setInstalling(null)}
          />
        ) : null}
      </Sheet>
      <InstallOutputSheet
        id={historyId}
        allow={allow}
        onClose={() => navigate(PACKAGES_PATH)}
        onRemove={setRemoving}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ""}?`}
        description="Runs that need it won't be offered to this agent."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing) remove.mutate({ ...removing, pendingId: nextPendingId() });
          setRemoving(null);
          // From a failed entry's sheet: back to the history, where the removal shows.
          if (historyId !== undefined) navigate(PACKAGES_PATH);
        }}
      />
    </AgentPage>
  );
}

function InstalledCard({
  noneAllowed,
  onInstallVersion,
  onRemove,
}: {
  noneAllowed: boolean;
  onInstallVersion: (name: string) => void;
  onRemove: (installed: InstalledPackage) => void;
}) {
  const packages = usePackages();
  const install = useInstall();

  const columns: DataTableColumn<InstalledPackage>[] = [
    { id: "name", header: "Package", cell: (row) => row.name, card: "title", mono: true },
    {
      id: "version",
      header: "Version",
      cell: (row) => <MetaBadge text={row.version} mono />,
    },
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      align: "end",
      card: "status",
      cell: (row) => (
        <div className="agent-row-actions">
          <IconButton
            label={`Update ${row.name}`}
            icon={IconRefresh}
            size="sm"
            disabled={noneAllowed}
            {...(noneAllowed && { disabledReason: NO_PACKAGE_INSTALLABLE })}
            onClick={() =>
              install.mutate({
                name: row.name,
                version: DEFAULT_INSTALL_VERSION,
                pendingId: nextPendingId(),
              })
            }
          />
          <Menu
            items={[
              {
                label: "Install a version…",
                onSelect: () => onInstallVersion(row.name),
                disabled: noneAllowed,
              },
              { label: "Remove…", destructive: true, onSelect: () => onRemove(row) },
            ]}
            trigger={
              <IconButton label={`More actions for ${row.name}`} icon={IconDots} size="sm" />
            }
          />
        </div>
      ),
    },
  ];

  const rows = packages.data?.packages ?? [];
  return (
    <Card title="Installed">
      {noneAllowed ? <p className="agent-card-description">{NO_PACKAGE_INSTALLABLE}</p> : null}
      {packages.isError ? (
        <EmptyState title="Can't load the packages" description={packages.error.message} />
      ) : packages.data && rows.length === 0 ? (
        <EmptyState title="No packages installed" />
      ) : (
        <DataTable
          caption="Installed packages"
          rows={rows}
          getRowId={(row) => row.name}
          columns={columns}
        />
      )}
    </Card>
  );
}

function InstallForm({
  allow,
  initialName,
  onDone,
}: {
  allow: readonly string[];
  initialName: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [version, setVersion] = useState(DEFAULT_INSTALL_VERSION);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = useInstall(onDone, (failure) => {
    const field = failure.issues.find((issue) => issue.path[0] === "name");
    if (field) setNameError(field.message);
    else setError(failure.message);
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(PACKAGE_NAME_REQUIRED);
      return;
    }
    if (!installableAllowed(allow, trimmed)) {
      setNameError(`${trimmed} doesn't match the allow-list.`);
      return;
    }
    setError(null);
    install.mutate({
      name: trimmed,
      version: version.trim() || DEFAULT_INSTALL_VERSION,
      pendingId: nextPendingId(),
    });
  };

  return (
    <form className="agent-install" onSubmit={submit} noValidate>
      <Field label="Package" stacked>
        <TextInput
          mono
          value={name}
          placeholder="@scope/name"
          autoComplete="off"
          spellCheck={false}
          required
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          errorMessage={nameError ?? undefined}
        />
      </Field>
      <Field label="Version" stacked>
        <TextInput
          mono
          value={version}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setVersion(event.target.value)}
        />
      </Field>
      {error ? (
        <p className="agent-alert" role="alert">
          {error}
        </p>
      ) : null}
      <div className="agent-install__actions">
        <Button type="submit" variant="solid" disabled={install.isPending}>
          {install.isPending ? "Installing…" : "Install"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface AllowListDraft {
  allow: string[];
}

function AllowListCard({ settings }: { settings: LocalSettingsState }) {
  const client = useQueryClient();
  const saved = useMemo<AllowListDraft>(
    () => ({ allow: [...settings.effective.installablesAllow] }),
    [settings.effective.installablesAllow],
  );
  const mutation = useLocalMutation<LocalSettingsState, { allow: string[]; revision: string }>({
    mutationFn: ({ allow, revision }) =>
      localRequest<LocalSettingsState>("/api/settings/allow-list", {
        method: "PUT",
        body: { revision, allow },
      }),
    invalidate: () => [agentKeys.state],
    success: "Allow-list saved",
    applyResult: (result, cache) =>
      cache.set<AgentUiState>(cache.keys.state, (state) => withSettings(state, result), {
        exact: true,
      }),
  });

  const save = async ({ allow }: AllowListDraft): Promise<LocalSettingsState> => {
    const revision =
      client.getQueryData<AgentUiState>(agentKeys.state)?.settings.revision ?? settings.revision;
    try {
      return await mutation.mutateAsync({ allow, revision });
    } catch (error) {
      if (!(error instanceof LocalApiError)) throw error;
      if (error.status === 409) {
        const latest = (error.body as { settings?: LocalSettingsState } | undefined)?.settings;
        if (latest) {
          client.setQueryData<AgentUiState>(agentKeys.state, (state) =>
            withSettings(state, latest),
          );
        }
        throw { message: SETTINGS_CHANGED } satisfies StagedSaveError;
      }
      throw { message: error.message } satisfies StagedSaveError;
    }
  };

  const card = useStagedCard<AllowListDraft, LocalSettingsState>({
    label: "Allow-list",
    saved,
    toChanges: (from, to) => allowListChanges(from.allow, to.allow),
    save,
  });

  return (
    <Card title="Allow-list">
      {settings.lastError !== null ? (
        <p role="alert" className="agent-alert">
          settings.json isn't valid: {settings.lastError}; the agent keeps its last good settings
        </p>
      ) : null}
      <Field label="Allowed packages" description={ALLOW_LIST_DESCRIPTION} stacked>
        <TokenInput
          values={card.draft.allow}
          onChange={(values) => card.set("allow", values)}
          validate={patternError}
          placeholder="@scope/*"
          disabled={card.saving}
        />
      </Field>
      <SaveBar
        changes={card.changes}
        onSave={card.submit}
        onDiscard={card.discard}
        saving={card.saving}
        error={card.error}
      />
    </Card>
  );
}

const HISTORY_COLUMNS: DataTableColumn<InstallSummary>[] = [
  { id: "time", header: "Time", cell: (row) => formatTime(row.startedAt), card: "time" },
  {
    id: "package",
    header: "Package",
    cell: (row) => installPackageLabel(row),
    card: "title",
    mono: true,
  },
  { id: "from", header: "From", cell: (row) => FROM_LABELS[row.from] },
  {
    id: "outcome",
    header: "Outcome",
    card: "status",
    cell: (row) => {
      const { text, tone } = installOutcome(row);
      return <StatusText tone={tone}>{text}</StatusText>;
    },
  },
];

function HistoryCard() {
  const history = useInstallHistory();
  const rows = history.data?.installs ?? [];
  return (
    <Card title="Install history">
      {history.isError ? (
        <EmptyState title="Can't load the install history" description={history.error.message} />
      ) : history.data && rows.length === 0 ? (
        <EmptyState title="Nothing installed from this agent yet" />
      ) : (
        <DataTable
          caption="Install history"
          rows={rows}
          getRowId={(row) => row.id}
          columns={HISTORY_COLUMNS}
          getRowHref={(row) => installHistoryPath(row.id)}
          rowTone={(row) => (row.outcome === "failed" ? "bad" : undefined)}
        />
      )}
    </Card>
  );
}

/**
 * One install's facts and npm output, at `/packages/history/<id>`. A failed one ends with
 * its next step: Retry install (the same version again), and Remove… while it's installed.
 */
function InstallOutputSheet({
  id,
  allow,
  onClose,
  onRemove,
}: {
  id: string | undefined;
  /** The allow-list, once the agent's state has loaded. */
  allow: readonly string[] | undefined;
  onClose: () => void;
  onRemove: (installed: InstalledPackage) => void;
}) {
  const entry = useQuery({
    queryKey: agentKeys.packages.historyEntry(id ?? ""),
    queryFn: ({ signal }) =>
      localRequest<InstallRecord>(`/api/packages/history/${encodeURIComponent(id!)}`, {
        signal,
      }),
    enabled: id !== undefined,
  });
  // The title stays while the sheet closes.
  const lastTitle = useRef("Install");
  if (entry.data) lastTitle.current = installPackageLabel(entry.data);
  const install = entry.data;
  const outcome = install ? installOutcome(install) : null;
  const packages = usePackages();
  const retry = useInstall();
  const failed = install?.outcome === "failed" ? install : null;
  const installed = failed
    ? packages.data?.packages.find((pkg) => pkg.name === failed.name)
    : undefined;
  const retryBlocked =
    failed && allow !== undefined && !installableAllowed(allow, failed.name)
      ? `${failed.name} doesn't match the allow-list.`
      : null;
  const nextSteps =
    failed && (failed.action === "install" || installed) ? (
      <>
        {failed.action === "install" ? (
          <Button
            variant="solid"
            icon={IconRetry}
            disabled={retryBlocked !== null}
            {...(retryBlocked !== null && { disabledReason: retryBlocked })}
            onClick={() => {
              retry.mutate({
                name: failed.name,
                version: failed.version ?? DEFAULT_INSTALL_VERSION,
                pendingId: nextPendingId(),
              });
              onClose();
            }}
          >
            Retry install
          </Button>
        ) : null}
        {installed ? (
          <Button variant="outline" onClick={() => onRemove(installed)}>
            Remove…
          </Button>
        ) : null}
      </>
    ) : undefined;
  return (
    <Sheet
      title={lastTitle.current}
      open={id !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={nextSteps}
    >
      {entry.isError ? (
        <EmptyState title="Can't load this install" description={entry.error.message} />
      ) : install && outcome ? (
        <div className="agent-install-output">
          <dl className="agent-facts">
            <dt>Outcome</dt>
            <dd>
              <StatusText tone={outcome.tone}>{outcome.text}</StatusText>
            </dd>
            <dt>From</dt>
            <dd>{FROM_LABELS[install.from]}</dd>
            <dt>Started</dt>
            <dd>{formatTime(install.startedAt)}</dd>
            {install.finishedAt ? (
              <>
                <dt>Finished</dt>
                <dd>{formatTime(install.finishedAt)}</dd>
              </>
            ) : null}
          </dl>
          {install.error ? (
            <p className="agent-alert" role="alert">
              {install.error}
            </p>
          ) : null}
          {install.output ? (
            <ScrollRegion as="pre" className="agent-output or-mono" label="npm output">
              {install.output}
            </ScrollRegion>
          ) : (
            <p className="agent-card-description">
              {install.outcome === null ? "npm hasn't finished yet." : "npm printed nothing."}
            </p>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
