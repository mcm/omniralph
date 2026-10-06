"use client";

import * as React from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
} from "@iamthemcmaster/ui";
import { IconCopy, IconKey, IconPackage, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { toast } from "sonner";
import { AGENT_INSTALL_COMMAND } from "@/lib/agents/display";
import { formatDateTime } from "@/lib/format-date";
import { createEnrollment } from "./actions";

interface Enrollment {
  token: string;
  expiresAt: string;
  command: string;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
}

const secretRow = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-4)",
  background: "var(--bg-raised)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-subtle)",
} as const;

const secretText = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-primary)",
  wordBreak: "break-all",
} as const;

/** A one-time secret row, following the template's API-key display. */
function SecretRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div style={secretRow}>
      {icon}
      <div style={secretText} aria-label={label}>
        {value}
      </div>
      <Button size="sm" variant="ghost" onClick={() => copy(value, label)}>
        <IconCopy size={14} />
        Copy
      </Button>
    </div>
  );
}

/** "Enroll agent": creates a one-time enrollment token and shows it (once) with its command. */
export function EnrollAgentDialog() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [pending, startTransition] = React.useTransition();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // The token is only ever shown in this dialog: forget it when it closes.
    if (!next) {
      setEnrollment(null);
      setName("");
    }
  };

  const generate = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const result = await createEnrollment(name);
      if (result.ok) setEnrollment(result);
      else toast.error(result.error);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <IconPlus size={14} />
          Enroll agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        {enrollment ? (
          <>
            <DialogHeader>
              <DialogTitle>Enrollment token created</DialogTitle>
              <DialogDescription>
                Run these on the agent host as the agent&apos;s Unix user (installing needs npm
                access to the private <code>@iamthemcmaster</code> scope). The token works once and
                expires {formatDateTime(enrollment.expiresAt)}.
              </DialogDescription>
            </DialogHeader>
            <DialogBody style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <Alert variant="warning">
                <AlertTitle>Shown once</AlertTitle>
                <AlertDescription>
                  Copy it now: only its hash is stored, so it can&apos;t be shown again. Treat it
                  like a password.
                </AlertDescription>
              </Alert>
              <SecretRow
                icon={
                  <IconPackage
                    size={14}
                    style={{ color: "var(--text-secondary)", flexShrink: 0 }}
                  />
                }
                label="Install command"
                value={AGENT_INSTALL_COMMAND}
              />
              <SecretRow
                icon={
                  <IconTerminal2
                    size={14}
                    style={{ color: "var(--text-secondary)", flexShrink: 0 }}
                  />
                }
                label="Enroll command"
                value={enrollment.command}
              />
              <SecretRow
                icon={
                  <IconKey size={14} style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
                }
                label="Token"
                value={enrollment.token}
              />
            </DialogBody>
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={generate}>
            <DialogHeader>
              <DialogTitle>Enroll an agent</DialogTitle>
              <DialogDescription>
                Creates a one-time enrollment token, valid for 1 hour. The agent exchanges it for
                its own rotating refresh token.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field
                label="Name"
                htmlFor="agent-name"
                hint="Optional. Defaults to the host's name."
              >
                <Input
                  id="agent-name"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="coder-review-1"
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={pending}>
                <IconKey size={14} />
                {pending ? "Generating…" : "Generate token"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
