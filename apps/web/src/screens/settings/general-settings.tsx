"use client";

import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  SaveBar,
  TextInput,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { IconDoorExit } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useExpectOrganizationSwitch } from "@/components/organization-guard";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { organizationKeys } from "@/lib/api/keys";
import type { OrganizationSettings } from "@/lib/api/organization";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { MAX_ORGANIZATION_NAME_LENGTH } from "@/lib/organizations/name";
import { useOrganizationSettings } from "./queries";

/** The General card's one field, as `useStagedCard` stages it. */
export interface GeneralDraft {
  name: string;
}

/** The save bar's item: the name, when it differs once trimmed (the server trims it too). */
export function generalChanges(saved: GeneralDraft, draft: GeneralDraft): StagedChange[] {
  const name = draft.name.trim();
  if (name === saved.name) return [];
  return [{ id: "name", label: "Name", from: saved.name, to: name || "None" }];
}

/** The leave dialog's text. */
export const LEAVE_DESCRIPTION = "You lose access to its repos, runs and agents.";

/**
 * The Organization card (the page is General, so the card names what it holds): the organization's name (required, at most
 * `MAX_ORGANIZATION_NAME_LENGTH`), staged in its save bar and saved in one
 * `PATCH /api/ui/organization`. The answer is written into the organization's cached
 * settings, which the page, Settings' badge and the organization picker all read
 * (`LiveCurrentUser`), so they show the new name at once. Members see it read-only.
 */
function GeneralCard({ settings }: { settings: OrganizationSettings }) {
  const { organization, isAdmin } = settings;
  const saved = useMemo<GeneralDraft>(() => ({ name: organization.name }), [organization.name]);
  const card = useStagedCard<GeneralDraft, MutationResult>({
    label: "Organization",
    saved,
    toChanges: generalChanges,
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.patch("/api/ui/organization", mutationResultSchema, {
          body: { name: draft.name.trim() },
          organizationId,
        }),
      applyResult: (_result, cache, draft) =>
        cache.set<OrganizationSettings>(
          organizationKeys(cache.keys).settings,
          (previous) =>
            previous && {
              ...previous,
              organization: { ...previous.organization, name: draft.name.trim() },
            },
          { exact: true },
        ),
      success: "Renamed",
    }),
    onDirtyChange: useUnsavedCard("Organization"),
  });

  return (
    <Card
      title="Organization"
      titleId="organization"
      titleAddon={<ChangeHistoryPopover section="organization" latest={settings.history} />}
    >
      <Field label="Name" htmlFor="organization-name">
        <TextInput
          id="organization-name"
          required
          maxLength={MAX_ORGANIZATION_NAME_LENGTH}
          value={card.draft.name}
          readOnly={!isAdmin}
          disabled={card.saving}
          errorMessage={card.fieldErrors.name}
          onChange={(event) => card.set("name", event.target.value)}
        />
      </Field>
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

/**
 * Leaving the organization (`POST /api/ui/organization/leave`), after a `ConfirmDialog`:
 * the panel then starts over from the dashboard in another of the user's organizations (or
 * onboarding). The last admin is refused, with the server's message in a toast.
 */
function LeaveCard({ name }: { name: string }) {
  const router = useRouter();
  const expectSwitch = useExpectOrganizationSwitch();
  const [confirming, setConfirming] = useState(false);
  const leave = useApiMutation({
    mutationFn: async (_: void, { organizationId }) => {
      const result = await api.post("/api/ui/organization/leave", mutationResultSchema, {
        organizationId,
      });
      // Leaving switched the active organization: not another tab's switch.
      expectSwitch();
      return result;
    },
    // Nothing to refetch here: the panel starts over in the next organization.
    invalidate: () => [],
    success: `Left ${name}`,
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
  });
  return (
    <Card title="Leave organization" titleId="leave">
      <div>
        <Button
          variant="danger"
          icon={IconDoorExit}
          disabled={leave.isPending || leave.isSuccess}
          onClick={() => setConfirming(true)}
        >
          Leave organization
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Leave ${name}?`}
        description={LEAVE_DESCRIPTION}
        confirmLabel="Leave"
        destructive
        onConfirm={() => leave.mutate()}
      />
    </Card>
  );
}

/**
 * Organization › General: the organization's name and leaving it. A live query: another
 * admin's rename arrives through the `organization` event.
 */
export function GeneralSettings() {
  const query = useOrganizationSettings();
  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    return (
      <EmptyState
        title="Couldn't load the organization"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <>
      <GeneralCard settings={query.data} />
      <LeaveCard name={query.data.organization.name} />
    </>
  );
}
