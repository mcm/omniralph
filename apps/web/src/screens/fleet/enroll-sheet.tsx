"use client";

import { Button, Field, IconButton, Sheet, StatusText, TextInput, toast } from "@omniralph/ui";
import { IconCopy, IconKey } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { useApiMutation } from "@/components/use-api-mutation";
import { AGENT_INSTALL_COMMAND } from "@/lib/agents/display";
import { api } from "@/lib/api/client";
import {
  createdEnrollmentSchema,
  ENROLLMENT_NAME_MAX,
  type CreatedEnrollment,
} from "@/lib/api/agents";
import { formatDateTime } from "@/lib/format-date";
import { agentHref } from "@/lib/runs/hrefs";
import { useClock } from "../clock";
import { useEnrollmentStatus } from "./queries";

/** Copies `text`: "{what} copied", or the danger toast "Couldn't copy to the clipboard". */
export async function copyToClipboard(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast("Couldn't copy to the clipboard", { variant: "danger" });
  }
}

/** A command or the token, in mono, with its copy button. */
function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="or-enroll__row">
      <span className="or-enroll__label">{label}</span>
      <div className="or-enroll__value">
        <code className="or-mono or-enroll__code" aria-label={label}>
          {value}
        </code>
        <IconButton
          label={`Copy ${label.toLowerCase()}`}
          icon={IconCopy}
          variant="ghost"
          size="sm"
          onClick={() => void copyToClipboard(value, label)}
        />
      </div>
    </div>
  );
}

/** Under the token: waiting for the agent to connect, or that the token expired unused. */
function Waiting({ enrollment, name }: { enrollment: CreatedEnrollment; name: string }) {
  // Ticks every second, so an expired token says so while the sheet is open.
  const now = useClock(1_000);
  if (Date.parse(enrollment.expiresAt) <= now) {
    return (
      <p className="or-enroll__note">
        This token expired before an agent used it. Generate a new one.
      </p>
    );
  }
  return (
    <p className="or-enroll__waiting" role="status">
      <StatusText tone="neutral">Waiting for {name || "the agent"} to connect…</StatusText>
    </p>
  );
}

/** Once the agent redeemed the token: "Connected", and a link to the agent. */
function Connected({
  agent,
  text,
  onDone,
}: {
  agent: { id: string; name: string };
  text: string;
  onDone: () => void;
}) {
  return (
    <div className="or-enroll">
      <p className="or-enroll__connected" role="status">
        <StatusText tone="good">Connected</StatusText>
      </p>
      <p className="or-enroll__text">{text}</p>
      <div className="or-enroll__actions">
        <Button href={agentHref(agent.id)} variant="solid" onClick={onDone}>
          Open {agent.name}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** The one-time token with the install and enroll commands, waiting for the agent. */
function TokenStep({
  enrollment,
  name,
  onDone,
}: {
  enrollment: CreatedEnrollment;
  name: string;
  onDone: () => void;
}) {
  return (
    <div className="or-enroll">
      <p className="or-enroll__text">
        Run these on the agent host as the agent&apos;s Unix user. The token works once and expires{" "}
        {formatDateTime(enrollment.expiresAt)}.
      </p>
      <p className="or-enroll__warning">
        Copy it now: only its hash is stored, so it can&apos;t be shown again. Treat it like a
        password.
      </p>
      <CopyRow label="Install command" value={AGENT_INSTALL_COMMAND} />
      <CopyRow label="Enroll command" value={enrollment.command} />
      <CopyRow label="Token" value={enrollment.token} />
      <Waiting enrollment={enrollment} name={name} />
      <div className="or-enroll__actions">
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * The flow inside the sheet: a name, then the one-time token with the install and enroll
 * commands, then "Connected" once the agent redeems the token (its `agent` change event
 * refetches the enrollment). Mounted only while the sheet is open, so it starts over each
 * time and the token is forgotten when the sheet closes.
 */
function EnrollFlow({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [enrollment, setEnrollment] = useState<CreatedEnrollment | null>(null);
  const status = useEnrollmentStatus(enrollment);
  const connected = enrollment ? status.data?.agent : null;

  const create = useApiMutation({
    mutationFn: (agentName: string, { organizationId }) =>
      api.post("/api/ui/agent-enrollments", createdEnrollmentSchema, {
        body: { name: agentName },
        organizationId,
      }),
    // A token changes no list: the agent appears once it enrolls.
    invalidate: () => [],
    success: null,
    onSuccess: (created) => setEnrollment(created),
  });

  if (connected) {
    return (
      <Connected
        agent={connected}
        text={`${connected.name} redeemed the token, which can't be used again.`}
        onDone={onDone}
      />
    );
  }

  if (enrollment) return <TokenStep enrollment={enrollment} name={name.trim()} onDone={onDone} />;

  const generate = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(name);
  };

  return (
    <form className="or-enroll" onSubmit={generate}>
      <p className="or-enroll__text">
        Creates a one-time enrollment token, valid for 1 hour. The agent exchanges it for its own
        rotating refresh token.
      </p>
      <Field label="Name" description="Optional. Defaults to the host's name." stacked>
        <TextInput
          maxLength={ENROLLMENT_NAME_MAX}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. coder-review-1"
        />
      </Field>
      <div className="or-enroll__actions">
        <Button type="submit" variant="solid" icon={IconKey} disabled={create.isPending}>
          {create.isPending ? "Generating…" : "Generate token"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** What re-enrolling an agent does, above "Generate token". */
export function reenrollDescription(name: string): string {
  return (
    `Creates a one-time enrollment token for ${name}, valid for 1 hour. Enrolling with it ` +
    "brings the agent back with the same ID, pins and history, and starts a new refresh " +
    "token: every earlier one stops working."
  );
}

/** Shown before re-enrolling an agent revoked for refresh-token reuse (`docs/deploy-agent.md`). */
export const REENROLL_REUSE_WARNING =
  "This agent's refresh token was used twice, so its token family is treated as stolen. Find " +
  "out why before re-enrolling: check the audit log for the IP the reused token came from, and " +
  "delete any other copy of agent.json. If you can't explain it, treat the host as compromised.";

/** An agent to re-enroll: its ID, name and organization (the token's). */
export interface ReenrollAgent {
  id: string;
  name: string;
  organization: { id: string };
}

/**
 * The re-enroll flow: what it does (and, after token reuse, to find out why first), then the
 * one-time token bound to the agent with the same commands as Enroll, then "Connected" once
 * the agent redeems it. Mounted only while the sheet is open.
 */
function ReenrollFlow({
  agent,
  reuse,
  onDone,
}: {
  agent: ReenrollAgent;
  reuse: boolean;
  onDone: () => void;
}) {
  const [enrollment, setEnrollment] = useState<CreatedEnrollment | null>(null);
  const status = useEnrollmentStatus(enrollment, agent.organization.id);
  const connected = enrollment ? status.data?.agent : null;

  const create = useApiMutation({
    mutationFn: () =>
      api.post(`/api/ui/agents/${encodeURIComponent(agent.id)}/reenroll`, createdEnrollmentSchema, {
        organizationId: agent.organization.id,
      }),
    // A token changes nothing yet: the agent comes back once it enrolls.
    invalidate: () => [],
    success: null,
    onSuccess: (created) => setEnrollment(created),
  });

  if (connected) {
    return (
      <Connected
        agent={connected}
        text={`${connected.name} is enrolled again with its pins and history. The token can't be used again.`}
        onDone={onDone}
      />
    );
  }

  if (enrollment) return <TokenStep enrollment={enrollment} name={agent.name} onDone={onDone} />;

  const generate = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form className="or-enroll" onSubmit={generate}>
      <p className="or-enroll__text">{reenrollDescription(agent.name)}</p>
      {reuse ? (
        <p className="or-enroll__warning" role="alert">
          {REENROLL_REUSE_WARNING}
        </p>
      ) : null}
      <div className="or-enroll__actions">
        <Button type="submit" variant="solid" icon={IconKey} disabled={create.isPending}>
          {create.isPending ? "Generating…" : "Generate token"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export interface ReenrollSheetProps {
  agent: ReenrollAgent;
  /** The agent's refresh token was reused (revoked for `refresh_reuse`): say to find out why. */
  reuse: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Re-enroll…": re-enrolls an existing agent in place, keeping its ID and pins (admins). */
export function ReenrollSheet({ agent, reuse, open, onOpenChange }: ReenrollSheetProps) {
  return (
    <Sheet title={`Re-enroll ${agent.name}`} open={open} onOpenChange={onOpenChange}>
      {open ? (
        <ReenrollFlow agent={agent} reuse={reuse} onDone={() => onOpenChange(false)} />
      ) : null}
    </Sheet>
  );
}

export interface EnrollSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "Enroll": enrolls a new agent in the active organization (admins). */
export function EnrollSheet({ open, onOpenChange }: EnrollSheetProps) {
  return (
    <Sheet title="Enroll an agent" open={open} onOpenChange={onOpenChange}>
      {open ? <EnrollFlow onDone={() => onOpenChange(false)} /> : null}
    </Sheet>
  );
}
