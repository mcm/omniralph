"use client";

import {
  Button,
  ConfirmDialog,
  Field,
  Sheet,
  TextInput,
  Toolbar,
  type MenuItem,
} from "@omniralph/ui";
import {
  IconCopy,
  IconHistory,
  IconPackage,
  IconPlugConnectedX,
  IconTrash,
} from "@tabler/icons-react";
import { installableAllowed } from "@omniralph/shared";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api, type ApiError } from "@/lib/api/client";
import {
  installEnqueuedSchema,
  type AgentDetail,
  type AgentList,
  type FleetAgentRow,
} from "@/lib/api/agents";
import { mutationResultSchema } from "@/lib/api/schemas";
import { formatDateTime } from "@/lib/format-date";
import { auditEventLabel } from "@/lib/fleet/status";
import { FLEET_PATH } from "@/lib/runs/hrefs";
import { copyToClipboard } from "./enroll-sheet";
import { fleetKeys } from "./queries";

/** npm's limit on a package name. */
export const PACKAGE_NAME_MAX = 214;
/** The install route's limit on a version or dist-tag. */
export const PACKAGE_VERSION_MAX = 64;

/** Shown when the install sheet has no package name. */
export const PACKAGE_NAME_REQUIRED = "Enter a package name.";

/** What the install sheet says installing does (the agent decides). */
export const INSTALL_ALLOW_LIST = "The agent installs it only if its local allow-list permits it.";

/** Under the Package field when the typed name doesn't match the reported allow-list. */
export const NOT_ON_ALLOW_LIST = "This agent's allow-list doesn't include this package.";

/**
 * The install sheet's sentence about the agent's reported allow-list: "This agent only installs
 * packages that match @omniralph/* or @acme/*.", "This agent doesn't allow any package
 * installs." when it's empty; null before the agent reports one.
 */
export function allowListSentence(allow: readonly string[] | null): string | null {
  if (allow === null) return null;
  if (allow.length === 0) return "This agent doesn't allow any package installs.";
  const patterns = new Intl.ListFormat("en-US", { type: "disjunction" }).format(allow);
  return `This agent only installs packages that match ${patterns}.`;
}

/** The revoke confirmation's description. */
export const REVOKE_DESCRIPTION =
  "The agent stops at once and can't reconnect without enrolling again. Its running attempts fail.";

/** The remove confirmation's description. */
export const REMOVE_DESCRIPTION = "Its history stays on its runs.";

/** Opens one of the ⋯ menu's flows. */
export type AgentAction = "install" | "audit" | "revoke" | "remove";

/**
 * The ⋯ menu's items (Design rule 5): for an admin of the agent's organization, "Install
 * package…" (live agents), "Audit log", "Copy agent ID", then after a separator "Revoke
 * agent…" (live) or "Remove agent…" (revoked). Members get "Audit log" and "Copy agent ID".
 */
export function agentMenuItems(
  agent: Pick<FleetAgentRow, "id" | "revoked" | "organization">,
  open: (action: AgentAction) => void,
): MenuItem[] {
  const admin = agent.organization.role === "admin";
  const items: MenuItem[] = [];
  if (admin && !agent.revoked) {
    items.push({ label: "Install package…", icon: IconPackage, onSelect: () => open("install") });
  }
  items.push(
    { label: "Audit log", icon: IconHistory, onSelect: () => open("audit") },
    {
      label: "Copy agent ID",
      icon: IconCopy,
      onSelect: () => void copyToClipboard(agent.id, "Agent ID"),
    },
  );
  if (admin) {
    items.push(
      agent.revoked
        ? {
            label: "Remove agent…",
            icon: IconTrash,
            destructive: true,
            onSelect: () => open("remove"),
          }
        : {
            label: "Revoke agent…",
            icon: IconPlugConnectedX,
            destructive: true,
            onSelect: () => open("revoke"),
          },
    );
  }
  return items;
}

/** Writes every cached Fleet list (each scope). Other queries under the prefix are left alone. */
function updateLists(cache: MutationCache, update: (list: AgentList) => AgentList) {
  return cache.set<AgentList | unknown>(fleetKeys(cache.keys).lists, (previous) =>
    previous && typeof previous === "object" && "agents" in previous
      ? update(previous as AgentList)
      : previous,
  );
}

/** `row` once revoked: offline, nothing running, "Revoked". */
export function revokedRow(row: FleetAgentRow, revokedAt: string): FleetAgentRow {
  return {
    ...row,
    revoked: true,
    revokedAt,
    online: false,
    runningCount: 0,
    runningJobs: [],
    pinnedRepositories: [],
    status: { kind: "revoked", label: "Revoked", tone: "neutral" },
  };
}

/**
 * The install sheet's form: mounted only while the sheet is open, so it starts empty. A name
 * outside the reported allow-list is flagged, but submit stays enabled: the agent decides.
 */
function InstallForm({
  agent,
  allow,
  onDone,
}: {
  agent: FleetAgentRow;
  /** The agent's reported allow-list; null before it reports one. */
  allow: readonly string[] | null;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = useApiMutation({
    mutationFn: (sent: { name: string; version: string }, { organizationId }) =>
      api.post(`/api/ui/agents/${encodeURIComponent(agent.id)}/installs`, installEnqueuedSchema, {
        body: { name: sent.name, ...(sent.version && { version: sent.version }) },
        organizationId,
      }),
    invalidate: (keys) => [fleetKeys(keys).detail(agent.id)],
    // The Packages section shows the install at once.
    applyResult: (result, cache, sent) =>
      cache.set<AgentDetail>(
        fleetKeys(cache.keys).detail(agent.id),
        (detail) =>
          detail && {
            ...detail,
            installs: [
              {
                id: result.jobId,
                name: sent.name,
                state: "installing",
                error: null,
                createdAt: new Date().toISOString(),
              },
              ...detail.installs.filter((entry) => entry.id !== result.jobId),
            ],
          },
        { exact: true },
      ),
    success: (_, sent) => `Installing ${sent.name} on ${agent.name}`,
    onSuccess: onDone,
    onError: (failure: ApiError) => setError(failure.message),
  });

  const typed = name.trim();
  const outsideAllowList = allow !== null && typed !== "" && !installableAllowed(allow, typed);
  const allowSentence = allowListSentence(allow);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(PACKAGE_NAME_REQUIRED);
      return;
    }
    setError(null);
    install.mutate({ name: trimmed, version: version.trim() });
  };

  return (
    <form className="or-agent-install" onSubmit={submit} noValidate>
      {allowSentence ? <p className="or-agent-install__allow">{allowSentence}</p> : null}
      <Field label="Package" stacked>
        <TextInput
          mono
          value={name}
          placeholder="@scope/name"
          autoComplete="off"
          spellCheck={false}
          maxLength={PACKAGE_NAME_MAX}
          required
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          errorMessage={nameError ?? (outsideAllowList ? NOT_ON_ALLOW_LIST : undefined)}
        />
      </Field>
      <Field label="Version" stacked>
        <TextInput
          mono
          value={version}
          placeholder="latest"
          autoComplete="off"
          spellCheck={false}
          maxLength={PACKAGE_VERSION_MAX}
          onChange={(event) => setVersion(event.target.value)}
        />
      </Field>
      {error ? (
        <p className="or-agent-install__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="or-agent-install__actions">
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

/** The agent's audit events, newest first, as sentences with the IP and time. */
export function AuditLog({ audit }: { audit: AgentDetail["audit"] }) {
  if (audit.length === 0) return <p className="or-agent-audit__none">No audit events</p>;
  return (
    <ul className="or-agent-audit" aria-label="Audit events">
      {audit.map((entry) => (
        <li key={entry.id} className="or-agent-audit__event">
          <span className="or-agent-audit__label">{auditEventLabel(entry)}</span>
          <span className="or-agent-audit__meta">
            {entry.ip ? <span className="or-mono">{entry.ip}</span> : null}
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The agent's ⋯ menu (`Toolbar` "Agent actions") and the flows it opens: the install and
 * audit log sheets, and the revoke (typed confirmation) and remove confirmations. Revoke
 * and remove show in every cached Fleet list and the detail at once (rolled back on a
 * refusal); a removed agent leaves Fleet and the page goes to `/fleet`.
 */
export function AgentActions({ detail }: { detail: AgentDetail }) {
  const { agent } = detail;
  const router = useRouter();
  const [open, setOpen] = useState<AgentAction | null>(null);
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  const agentPath = `/api/ui/agents/${encodeURIComponent(agent.id)}`;

  const revoke = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.post(`${agentPath}/revoke`, mutationResultSchema, { organizationId }),
    // Its row, summary and pins change; repos lose its pins.
    invalidate: (keys) => [keys.agents.all, keys.repositories.all],
    optimistic: async (_, cache) => {
      const revokedAt = new Date().toISOString();
      await updateLists(cache, (list) => ({
        ...list,
        agents: list.agents.map((row) => (row.id === agent.id ? revokedRow(row, revokedAt) : row)),
      }));
      await cache.set<AgentDetail>(
        fleetKeys(cache.keys).detail(agent.id),
        (previous) =>
          previous && {
            ...previous,
            agent: revokedRow(previous.agent, revokedAt),
            runningNow: [],
          },
        { exact: true },
      );
    },
    success: `${agent.name} revoked`,
  });

  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(agentPath, mutationResultSchema, { organizationId }),
    invalidate: (keys) => [keys.agents.lists, keys.repositories.all],
    optimistic: (_, cache) =>
      updateLists(cache, (list) => ({
        ...list,
        agents: list.agents.filter((row) => row.id !== agent.id),
      })),
    success: `${agent.name} removed`,
    onSuccess: () => router.push(FLEET_PATH),
  });

  return (
    <>
      <Toolbar label="Agent actions" menu={agentMenuItems(agent, setOpen)} />
      <Sheet
        title="Install package"
        description={INSTALL_ALLOW_LIST}
        open={open === "install"}
        onOpenChange={close}
      >
        {open === "install" ? (
          <InstallForm
            agent={agent}
            allow={detail.local.installablesAllow}
            onDone={() => setOpen(null)}
          />
        ) : null}
      </Sheet>
      <Sheet title="Audit log" open={open === "audit"} onOpenChange={close}>
        <AuditLog audit={detail.audit} />
      </Sheet>
      <ConfirmDialog
        open={open === "revoke"}
        onOpenChange={close}
        title={`Revoke ${agent.name}?`}
        description={REVOKE_DESCRIPTION}
        confirmLabel="Revoke"
        destructive
        typedConfirmation={agent.name}
        typedConfirmationAction="revoke it"
        onConfirm={() => revoke.mutate()}
      />
      <ConfirmDialog
        open={open === "remove"}
        onOpenChange={close}
        title={`Remove ${agent.name} from Fleet?`}
        description={REMOVE_DESCRIPTION}
        confirmLabel="Remove"
        destructive
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
