/**
 * Version (`/version`): the running version, the organization's policy and where an update
 * is; the staged "Pin a version" card (`PUT /api/settings/version`); "Update now"
 * (`POST /api/update`, confirmed first), which shows "Finishing running work" at once while
 * the drain, the install and the check arrive as `update` events; and the versions that
 * failed. An agent not under pm2 can't update itself, so "Update now" is disabled there.
 */
import {
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  MetaBadge,
  SaveBar,
  StatusText,
  SummaryCells,
  Switch,
  TextInput,
  Toolbar,
  useStagedCard,
  type StagedSaveError,
} from "@omniralph/ui";
import { IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { LocalSettingsState } from "../../../../src/settings.js";
import type { UpdateRequest } from "../../../../src/update.js";
import { LocalApiError, localRequest } from "../../api.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation } from "../../live/use-local-mutation.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import { SETTINGS_CHANGED, withSettings } from "../settings.js";
import {
  NOT_UNDER_PM2,
  PIN_DESCRIPTION,
  UPDATE_RUNNING,
  draftPin,
  pinChanges,
  pinDraft,
  pinError,
  policyParts,
  updateNowDescription,
  updateStateText,
  updateTarget,
  updating,
  type PinDraft,
} from "./model.js";

/** Shown in the save bar when Save is pressed with an invalid version. */
export const FIX_PIN = "Fix the version before saving.";

function useUpdateNow() {
  return useLocalMutation<{ request: UpdateRequest }, void>({
    // A body, so the request carries the JSON content type every change needs.
    mutationFn: () =>
      localRequest<{ request: UpdateRequest }>("/api/update", { method: "POST", body: {} }),
    invalidate: () => [agentKeys.state],
    success: null,
    // "Finishing running work" before the agent answers.
    optimistic: (_, cache) =>
      cache.set<AgentUiState>(
        cache.keys.state,
        (state) =>
          state && {
            ...state,
            update: {
              ...state.update,
              request: { version: null, requestedAt: new Date().toISOString() },
            },
          },
        { exact: true },
      ),
    applyResult: ({ request }, cache) =>
      cache.set<AgentUiState>(
        cache.keys.state,
        (state) => state && { ...state, update: { ...state.update, request } },
        { exact: true },
      ),
  });
}

export function VersionPage() {
  const state = useAgentState();
  const [confirming, setConfirming] = useState(false);
  const updateNow = useUpdateNow();
  const data = state.data;
  const unsupported = data?.update.selfUpdate === "unsupported";
  const busy = data ? updating(data.update) : false;

  return (
    <AgentPage
      title="Version"
      actions={
        <Toolbar
          label="Version actions"
          actions={[
            {
              label: "Update now",
              icon: IconRefresh,
              onSelect: () => setConfirming(true),
              disabled: !data || unsupported || busy,
              ...(unsupported
                ? { disabledReason: NOT_UNDER_PM2 }
                : busy
                  ? { disabledReason: UPDATE_RUNNING }
                  : {}),
            },
          ]}
        />
      }
    >
      {data ? (
        <>
          <VersionSummary state={data} />
          {unsupported ? <p className="agent-card-description">{NOT_UNDER_PM2}</p> : null}
          <PinCard settings={data.settings} />
          <FailedVersions update={data.update} />
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title="Update now?"
            description={updateNowDescription(updateTarget(data))}
            confirmLabel="Update now"
            onConfirm={() => {
              setConfirming(false);
              updateNow.mutate();
            }}
          />
        </>
      ) : state.isError ? (
        <EmptyState title="Can't load the version" description={state.error.message} />
      ) : null}
    </AgentPage>
  );
}

/** "Track latest" with the organization's version as a badge, like the running version. */
function PolicyValue({ state }: { state: AgentUiState }) {
  const { text, version } = policyParts(state.versionPolicy);
  if (version === null) return text;
  return (
    <span className="agent-version-policy">
      {text} <MetaBadge text={version} mono />
    </span>
  );
}

function VersionSummary({ state }: { state: AgentUiState }) {
  const { text, tone } = updateStateText(state);
  return (
    <SummaryCells
      aria-label="Version summary"
      cells={[
        {
          id: "running",
          label: "Running",
          value: <MetaBadge text={state.agent.version} mono />,
        },
        { id: "policy", label: "Organization", value: <PolicyValue state={state} /> },
        { id: "update", label: "Update", value: <StatusText tone={tone}>{text}</StatusText> },
      ]}
    />
  );
}

function FailedVersions({ update }: { update: AgentUiState["update"] }) {
  const error = update.update?.error ?? null;
  if (update.failedVersions.length === 0 && error === null) return null;
  return (
    <Card title="Failed versions">
      {update.failedVersions.length > 0 ? (
        <ul className="agent-badges" aria-label="Failed versions">
          {update.failedVersions.map((version) => (
            <li key={version}>
              <MetaBadge text={version} mono className="agent-badge--fail" />
            </li>
          ))}
        </ul>
      ) : null}
      {error !== null ? <StatusText tone="fail">{error}</StatusText> : null}
    </Card>
  );
}

function PinCard({ settings }: { settings: LocalSettingsState }) {
  const client = useQueryClient();
  const saved = useMemo(
    () => pinDraft(settings.effective.versionPin),
    [settings.effective.versionPin],
  );
  const mutation = useLocalMutation<LocalSettingsState, { pin: string | null; revision: string }>({
    mutationFn: ({ pin, revision }) =>
      localRequest<LocalSettingsState>("/api/settings/version", {
        method: "PUT",
        body: { revision, pin },
      }),
    invalidate: () => [agentKeys.state],
    success: ({ effective }) =>
      effective.versionPin === null ? "Version unpinned" : `Pinned to ${effective.versionPin}`,
    applyResult: (result, cache) =>
      cache.set<AgentUiState>(cache.keys.state, (state) => withSettings(state, result), {
        exact: true,
      }),
  });

  const save = async (draft: PinDraft): Promise<LocalSettingsState> => {
    const problem = pinError(draft);
    if (problem)
      throw { message: FIX_PIN, fieldErrors: { version: problem } } satisfies StagedSaveError;
    const revision =
      client.getQueryData<AgentUiState>(agentKeys.state)?.settings.revision ?? settings.revision;
    try {
      return await mutation.mutateAsync({ pin: draftPin(draft), revision });
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
      const issue = error.issues.find((entry) => entry.path[0] === "pin");
      throw {
        message: error.message,
        ...(issue && { fieldErrors: { version: issue.message } }),
      } satisfies StagedSaveError;
    }
  };

  const card = useStagedCard<PinDraft, LocalSettingsState>({
    label: "Pin a version",
    saved,
    toChanges: pinChanges,
    save,
  });
  const versionError = card.dirty ? pinError(card.draft) : null;

  return (
    <Card title="Pin a version">
      {settings.lastError !== null ? (
        <p role="alert" className="agent-alert">
          settings.json isn't valid: {settings.lastError}; the agent keeps its last good settings
        </p>
      ) : null}
      <p className="agent-card-description">{PIN_DESCRIPTION}</p>
      <div className="agent-fields">
        <Switch
          label="Pin this agent's version"
          checked={card.draft.pinned}
          disabled={card.saving}
          onCheckedChange={(pinned) => card.set("pinned", pinned)}
        />
        <Field label="Version" stacked>
          <TextInput
            mono
            value={card.draft.version}
            placeholder="2.0.4"
            autoComplete="off"
            spellCheck={false}
            disabled={!card.draft.pinned || card.saving}
            onChange={(event) => card.set("version", event.target.value)}
            errorMessage={versionError ?? card.fieldErrors.version ?? undefined}
          />
        </Field>
      </div>
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
