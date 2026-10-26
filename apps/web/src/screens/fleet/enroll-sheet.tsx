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

async function copy(text: string, what: string) {
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
          onClick={() => void copy(value, label)}
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
      <div className="or-enroll">
        <p className="or-enroll__connected" role="status">
          <StatusText tone="good">Connected</StatusText>
        </p>
        <p className="or-enroll__text">
          {connected.name} redeemed the token, which can&apos;t be used again.
        </p>
        <div className="or-enroll__actions">
          <Button href={agentHref(connected.id)} variant="solid" onClick={onDone}>
            Open {connected.name}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (enrollment) {
    return (
      <div className="or-enroll">
        <p className="or-enroll__text">
          Run these on the agent host as the agent&apos;s Unix user. The token works once and
          expires {formatDateTime(enrollment.expiresAt)}.
        </p>
        <p className="or-enroll__warning">
          Copy it now: only its hash is stored, so it can&apos;t be shown again. Treat it like a
          password.
        </p>
        <CopyRow label="Install command" value={AGENT_INSTALL_COMMAND} />
        <CopyRow label="Enroll command" value={enrollment.command} />
        <CopyRow label="Token" value={enrollment.token} />
        <Waiting enrollment={enrollment} name={name.trim()} />
        <div className="or-enroll__actions">
          <Button variant="outline" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

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
