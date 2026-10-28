/**
 * Capacity (`/capacity`): one staged card for the agent's slots, its coding and review and
 * ask slots and the kinds of work it accepts, saved to `settings.json` through
 * `PUT /api/settings/capacity` and `PUT /api/settings/kinds` against the revision the page
 * read. The answer is written into the state at once; a hand edit of the file arrives as a
 * `settings` event and updates the fields that haven't been edited.
 */
import {
  Card,
  Checkbox,
  EmptyState,
  Field,
  SaveBar,
  TextInput,
  toast,
  useStagedCard,
  type StagedSaveError,
} from "@omniralph/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import type { LocalSettingsState } from "../../../../src/settings.js";
import { LocalApiError, localRequest } from "../../api.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation } from "../../live/use-local-mutation.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import { SETTINGS_CHANGED, withSettings } from "../settings.js";
import {
  KEEP_ONE_KIND,
  KIND_OPTIONS,
  capacityBody,
  capacityChanged,
  capacityChanges,
  capacityDraft,
  capacityErrors,
  kindsBody,
  kindsChanged,
  placeholderFor,
  type CapacityDraft,
  type CapacityField,
} from "./model.js";

export { SETTINGS_CHANGED };

/** Shown in the save bar when Save is pressed with a field in error. */
export const FIX_FIELDS = "Some values can't be saved yet.";

type Section = "capacity" | "kinds";

interface SectionSave {
  section: Section;
  body: object;
  revision: string;
}

/** Where an answer's issue path belongs in the card. */
const ISSUE_FIELDS: Record<string, CapacityField> = {
  maxConcurrency: "slots",
  "poolLimits.long": "coding",
  "poolLimits.short": "short",
  acceptedTaskTypes: "kinds",
};

function fieldErrorsOf(error: LocalApiError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.filter((part) => typeof part === "string").join(".");
    const field = ISSUE_FIELDS[path];
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

export function CapacityPage() {
  const state = useAgentState();
  if (state.data) return <CapacityCard settings={state.data.settings} />;
  return (
    <AgentPage title="Capacity">
      {state.isError ? (
        <EmptyState title="Can't load the settings" description={state.error.message} />
      ) : null}
    </AgentPage>
  );
}

function CapacityCard({ settings }: { settings: LocalSettingsState }) {
  const client = useQueryClient();
  const saved = useMemo(() => capacityDraft(settings.settings), [settings.settings]);
  const [kindsHint, setKindsHint] = useState(false);
  const kindsLabelId = useId();
  const kindsErrorId = useId();

  const mutation = useLocalMutation<LocalSettingsState, SectionSave>({
    mutationFn: ({ section, body, revision }) =>
      localRequest<LocalSettingsState>(`/api/settings/${section}`, {
        method: "PUT",
        body: { revision, ...body },
      }),
    invalidate: () => [agentKeys.state],
    // One toast for the save, after its last request.
    success: null,
    applyResult: (result, cache) =>
      cache.set<AgentUiState>(cache.keys.state, (state) => withSettings(state, result), {
        exact: true,
      }),
  });

  const save = async (draft: CapacityDraft): Promise<LocalSettingsState> => {
    if (Object.keys(capacityErrors(draft)).length > 0) {
      throw { message: FIX_FIELDS } satisfies StagedSaveError;
    }
    const sections: { section: Section; body: object }[] = [];
    if (capacityChanged(saved, draft)) {
      sections.push({ section: "capacity", body: capacityBody(draft) });
    }
    if (kindsChanged(saved, draft)) sections.push({ section: "kinds", body: kindsBody(draft) });
    // The revision the page shows; each answer's for the next request.
    let result = client.getQueryData<AgentUiState>(agentKeys.state)?.settings ?? settings;
    try {
      for (const { section, body } of sections) {
        result = await mutation.mutateAsync({ section, body, revision: result.revision });
      }
      toast("Capacity saved");
    } catch (error) {
      if (!(error instanceof LocalApiError)) throw error;
      if (error.status === 409) {
        // The current settings come with the answer: the card shows them, edits on top.
        const latest = (error.body as { settings?: LocalSettingsState } | undefined)?.settings;
        if (latest) {
          client.setQueryData<AgentUiState>(agentKeys.state, (state) =>
            withSettings(state, latest),
          );
        }
        throw { message: SETTINGS_CHANGED } satisfies StagedSaveError;
      }
      throw {
        message: error.message,
        fieldErrors: fieldErrorsOf(error),
      } satisfies StagedSaveError;
    }
    return result;
  };

  const card = useStagedCard<CapacityDraft, LocalSettingsState>({
    label: "Capacity",
    saved,
    toChanges: capacityChanges,
    save,
  });
  const { draft, set } = card;
  const errors = capacityErrors(draft);
  const errorFor = (field: CapacityField) => errors[field] ?? card.fieldErrors[field];
  const disabled = card.saving;

  const toggleKind = (kind: CapacityDraft["kinds"][number], checked: boolean) => {
    if (!checked && draft.kinds.length === 1 && draft.kinds[0] === kind) {
      setKindsHint(true);
      return;
    }
    setKindsHint(false);
    const next = checked ? [...draft.kinds, kind] : draft.kinds.filter((entry) => entry !== kind);
    set(
      "kinds",
      KIND_OPTIONS.map((option) => option.kind).filter((entry) => next.includes(entry)),
    );
  };
  const kindsError = kindsHint ? KEEP_ONE_KIND : errorFor("kinds");

  return (
    <AgentPage title="Capacity">
      <Card title="Slots and kinds">
        {settings.lastError !== null ? (
          <p role="alert" className="agent-alert">
            settings.json isn't valid: {settings.lastError}; the agent keeps its last good settings
          </p>
        ) : null}
        <div className="agent-fields">
          <Field label="Slots" description="How many attempts this agent runs at the same time.">
            <TextInput
              inputMode="numeric"
              value={draft.slots}
              placeholder={placeholderFor(draft, "slots")}
              disabled={disabled}
              onChange={(event) => set("slots", event.target.value)}
              errorMessage={errorFor("slots")}
            />
          </Field>
          <Field
            label="Coding slots"
            description="Coding attempts can take hours. By default one slot stays free for reviews and asks."
          >
            <TextInput
              inputMode="numeric"
              value={draft.coding}
              placeholder={placeholderFor(draft, "coding")}
              disabled={disabled}
              onChange={(event) => set("coding", event.target.value)}
              errorMessage={errorFor("coding")}
            />
          </Field>
          <Field label="Review and ask slots" description="Reviews, asks and triage.">
            <TextInput
              inputMode="numeric"
              value={draft.short}
              placeholder={placeholderFor(draft, "short")}
              disabled={disabled}
              onChange={(event) => set("short", event.target.value)}
              errorMessage={errorFor("short")}
            />
          </Field>
          <div className="or-field">
            <div className="or-field__head">
              <span id={kindsLabelId} className="or-field__label">
                Kinds
              </span>
              <p className="or-field__description">
                Only work of these kinds is offered to this agent.
              </p>
            </div>
            <div className="or-field__control">
              <div
                role="group"
                aria-labelledby={kindsLabelId}
                aria-describedby={kindsError ? kindsErrorId : undefined}
                className="agent-checks"
              >
                {KIND_OPTIONS.map(({ kind, label }) => (
                  <Checkbox
                    key={kind}
                    label={label}
                    checked={draft.kinds.includes(kind)}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggleKind(kind, checked)}
                  />
                ))}
              </div>
              {kindsError ? (
                <p id={kindsErrorId} role="alert" className="or-field-error">
                  {kindsError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={() => {
            setKindsHint(false);
            card.discard();
          }}
          saving={card.saving}
          error={card.error}
        />
      </Card>
    </AgentPage>
  );
}
