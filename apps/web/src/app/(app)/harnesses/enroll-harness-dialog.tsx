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
  notify,
  Stack,
} from "@iamthemcmaster/ui";
import { IconCopy, IconKey, IconPackage, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { Timestamp } from "@/components/list-table";
import { HARNESS_INSTALL_COMMAND } from "@/lib/harnesses/display";
import { createEnrollment } from "./actions";

interface Enrollment {
  token: string;
  expiresAt: string;
  command: string;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what} copied`);
  } catch {
    notify("Couldn't copy to the clipboard", { variant: "danger" });
  }
}

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
    <div className="harness-raised-row harness-secret-row">
      {icon}
      <div className="harness-secret-text" aria-label={label}>
        {value}
      </div>
      <Button size="sm" variant="ghost" onClick={() => copy(value, label)}>
        <IconCopy size={14} />
        Copy
      </Button>
    </div>
  );
}

/** "Enroll harness": creates a one-time enrollment token and shows it (once) with its command. */
export function EnrollHarnessDialog() {
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
      else notify(result.error, { variant: "danger" });
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <IconPlus size={14} />
          Enroll harness
        </Button>
      </DialogTrigger>
      <DialogContent>
        {enrollment ? (
          <>
            <DialogHeader>
              <DialogTitle>Enrollment token created</DialogTitle>
              <DialogDescription>
                Run these on the harness host as the harness&apos;s Unix user (installing needs npm
                access to the private <code>@iamthemcmaster</code> scope). The token works once and
                expires <Timestamp iso={enrollment.expiresAt} inline />.
              </DialogDescription>
            </DialogHeader>
            <Stack asChild gap={3}>
              <DialogBody>
                <Alert variant="warning">
                  <AlertTitle as="h3">Shown once</AlertTitle>
                  <AlertDescription>
                    Copy it now: only its hash is stored, so it can&apos;t be shown again. Treat it
                    like a password.
                  </AlertDescription>
                </Alert>
                <SecretRow
                  icon={<IconPackage size={14} className="shrink-0 text-text-secondary" />}
                  label="Install command"
                  value={HARNESS_INSTALL_COMMAND}
                />
                <SecretRow
                  icon={<IconTerminal2 size={14} className="shrink-0 text-text-secondary" />}
                  label="Enroll command"
                  value={enrollment.command}
                />
                <SecretRow
                  icon={<IconKey size={14} className="shrink-0 text-text-secondary" />}
                  label="Token"
                  value={enrollment.token}
                />
              </DialogBody>
            </Stack>
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={generate}>
            <DialogHeader>
              <DialogTitle>Enroll a harness</DialogTitle>
              <DialogDescription>
                Creates a one-time enrollment token, valid for 1 hour. The harness exchanges it for
                its own rotating refresh token.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Field
                label="Name"
                htmlFor="harness-name"
                description="Optional. Defaults to the host's name."
              >
                <Input
                  id="harness-name"
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
