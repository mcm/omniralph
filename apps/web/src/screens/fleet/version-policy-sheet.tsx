"use client";

import { Button, Field, SegmentedControl, Sheet, TextInput } from "@omniralph/ui";
import { useState, type FormEvent } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useApiMutation } from "@/components/use-api-mutation";
import { agentDefaultsSavedSchema } from "@/lib/api/agent-defaults";
import type { AgentList } from "@/lib/api/agents";
import { api, type ApiError } from "@/lib/api/client";
import {
  agentStatus,
  agentUpdateStatus,
  versionCounts,
  type VersionPolicy,
} from "@/lib/fleet/status";
import { fleetKeys } from "./queries";

/** The sheet's two choices. */
export type VersionPolicyMode = "latest" | "pinned";

const MODES = [
  { value: "latest", label: "Track latest" },
  { value: "pinned", label: "Pin a version" },
] as const;

/** Shown when "Pin a version" has no version. */
export const VERSION_REQUIRED = "Enter a version like 2.0.3.";

/** What each choice does. */
const MODE_DESCRIPTIONS: Record<VersionPolicyMode, string> = {
  latest: "Agents update to each new release of the agent package.",
  pinned: "Agents update to this version and stay on it.",
};

/** The save's toast: what agents do now. */
export function versionPolicySaved(policy: VersionPolicy | undefined): string {
  if (policy?.mode === "pinned") {
    return `Saved. Agents update to ${policy.version} with their next heartbeat.`;
  }
  return "Saved. Agents follow the latest release.";
}

/**
 * `list` with `policy` as `organizationId`'s version policy: its agents' desired version
 * (a version pinned on the agent still wins), update state and status, and the summary's policy
 * and counts, as the server computes them, so the cell shows a save at once.
 */
export function withVersionPolicy(
  list: AgentList,
  organizationId: string,
  policy: VersionPolicy,
  now: Date = new Date(),
): AgentList {
  const agents = list.agents.map((row) => {
    if (row.organization.id !== organizationId) return row;
    const desiredVersion = row.versionPin ?? policy.target;
    const updateStatus = agentUpdateStatus({
      version: row.version,
      desiredVersion,
      selfUpdate: row.selfUpdate,
      update: row.update,
      failedVersions: row.failedVersions,
    });
    return {
      ...row,
      desiredVersion,
      tracksLatest: !row.versionPin && policy.mode === "latest",
      updateStatus,
      status: agentStatus(
        {
          revoked: row.revoked,
          online: row.online,
          lastHeartbeatAt: row.lastHeartbeatAt,
          updateStatus,
          runningCount: row.runningCount,
          maxSlots: row.slots.max,
        },
        now,
      ),
    };
  });
  return {
    ...list,
    agents,
    summary: { ...list.summary, versionPolicy: policy, versions: versionCounts(agents) },
  };
}

/** The form: mounted only while the sheet is open, so it starts from the saved policy. */
function VersionPolicyForm({ policy, onDone }: { policy: VersionPolicy; onDone: () => void }) {
  const { organization } = useCurrentUser();
  const [mode, setMode] = useState<VersionPolicyMode>(
    policy.mode === "pinned" ? "pinned" : "latest",
  );
  const [version, setVersion] = useState(policy.version ?? policy.target ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useApiMutation({
    mutationFn: (sent: string, { organizationId }) =>
      api.put("/api/ui/agent-defaults", agentDefaultsSavedSchema, {
        body: { version: sent },
        organizationId,
      }),
    // Fleet, agent details and repos show the version agents should run.
    invalidate: (keys) => [
      keys.agents.all,
      keys.repositories.all,
      keys.settings.detail("agent-defaults"),
    ],
    applyResult: async (result, cache) => {
      const saved = result.versionPolicy;
      if (!saved) return;
      await cache.set<AgentList>(fleetKeys(cache.keys).list(organization.id), (list) =>
        list ? withVersionPolicy(list, organization.id, saved) : list,
      );
    },
    success: (result) => versionPolicySaved(result.versionPolicy),
    onSuccess: onDone,
    onError: (failure: ApiError) => setError(failure.fieldErrors?.version ?? failure.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "pinned" && !version.trim()) {
      setError(VERSION_REQUIRED);
      return;
    }
    setError(null);
    save.mutate(mode === "latest" ? "latest" : version.trim());
  };

  return (
    <form className="or-version-policy" onSubmit={submit} noValidate>
      <SegmentedControl
        aria-label="Version policy"
        options={MODES}
        value={mode}
        onValueChange={(next) => {
          setMode(next);
          setError(null);
        }}
      />
      <p className="or-version-policy__text">{MODE_DESCRIPTIONS[mode]}</p>
      {mode === "pinned" ? (
        <Field label="Version" stacked>
          <TextInput
            mono
            value={version}
            placeholder="2.0.3"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            onChange={(event) => {
              setVersion(event.target.value);
              setError(null);
            }}
            errorMessage={error ?? undefined}
          />
        </Field>
      ) : error ? (
        <p className="or-version-policy__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="or-version-policy__actions">
        <Button type="submit" variant="solid" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export interface VersionPolicySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active organization's policy. */
  policy: VersionPolicy;
}

/** The Version policy cell's "Edit" (admins, one organization): track latest or pin a version. */
export function VersionPolicySheet({ open, onOpenChange, policy }: VersionPolicySheetProps) {
  return (
    <Sheet title="Version policy" open={open} onOpenChange={onOpenChange}>
      {open ? <VersionPolicyForm policy={policy} onDone={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}
