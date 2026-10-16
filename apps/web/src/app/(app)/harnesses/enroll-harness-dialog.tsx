"use client";

import * as React from "react";
import { Link } from "@/components/link";
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
  Muted,
  notify,
  Spinner,
  Stack,
} from "@iamthemcmaster/ui";
import { IconCopy, IconKey, IconPackage, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { Timestamp } from "@/components/list-table";
import { useQueryKeys } from "@/components/query-provider";
import { useNow } from "@/components/relative-time";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  createdEnrollmentSchema,
  ENROLLMENT_NAME_MAX,
  enrollmentStatusSchema,
  type CreatedEnrollment,
} from "@/lib/api/harnesses";
import { HARNESS_INSTALL_COMMAND } from "@/lib/harnesses/display";

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

/**
 * Polls the enrollment while the dialog shows its token, until a harness redeems it (or it
 * expires). The harness list is refetched before the harness is reported, so the list behind
 * the dialog already shows it.
 */
function useEnrollmentStatus(enrollment: CreatedEnrollment | null) {
  const client = useQueryClient();
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: [...keys.harnesses.all, "enrollment", enrollment?.id],
    enabled: enrollment !== null,
    queryFn: async ({ signal }) => {
      const status = await api.get(
        `/api/ui/harness-enrollments/${enrollment!.id}`,
        enrollmentStatusSchema,
        { organizationId: organization.id, signal },
      );
      if (status.harness) await client.invalidateQueries({ queryKey: keys.harnesses.lists });
      return status;
    },
    refetchInterval: (query) => {
      const status = query.state.data;
      const expired = enrollment !== null && Date.parse(enrollment.expiresAt) <= Date.now();
      return status?.harness || expired ? false : 3_000;
    },
  });
}

/** Under the token: waiting for the harness to redeem it, or that it expired unused. */
function EnrollmentWaiting({ enrollment }: { enrollment: CreatedEnrollment }) {
  const now = useNow();
  if (Date.parse(enrollment.expiresAt) <= now) {
    return <Muted>This token expired before a harness used it. Generate a new one.</Muted>;
  }
  return (
    <div className="harness-enroll-waiting" role="status">
      <Spinner size="sm" variant="neutral" label="Waiting for the harness to enroll" />
      <Muted>Waiting for the harness to enroll…</Muted>
    </div>
  );
}

/**
 * "Enroll harness": creates a one-time enrollment token and shows it (once) with its command,
 * then shows the harness once it has enrolled with the token.
 */
export function EnrollHarnessDialog() {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [enrollment, setEnrollment] = React.useState<CreatedEnrollment | null>(null);
  const status = useEnrollmentStatus(open ? enrollment : null);
  const connected = enrollment && status.data?.harness;

  const create = useApiMutation({
    mutationFn: (harnessName: string, { organizationId }) =>
      api.post("/api/ui/harness-enrollments", createdEnrollmentSchema, {
        body: { name: harnessName },
        organizationId,
      }),
    // A token changes no list: the harness appears once it enrolls.
    invalidate: () => [],
    success: null,
    onSuccess: (created) => setEnrollment(created),
  });

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
    create.mutate(name);
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
        {connected ? (
          <>
            <DialogHeader>
              <DialogTitle>{connected.name} connected</DialogTitle>
              <DialogDescription>
                It enrolled with the token and is in the fleet. Its task types, concurrency and
                pinned repositories are on its page.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Alert variant="success" role="status">
                <AlertTitle as="h3">Enrolled</AlertTitle>
                <AlertDescription>
                  {connected.name} redeemed the token, which can&apos;t be used again.
                </AlertDescription>
              </Alert>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button asChild variant="primary">
                <Link href={`/harnesses/${connected.id}`} onClick={() => onOpenChange(false)}>
                  Open {connected.name}
                </Link>
              </Button>
            </DialogFooter>
          </>
        ) : enrollment ? (
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
                <EnrollmentWaiting enrollment={enrollment} />
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
                  maxLength={ENROLLMENT_NAME_MAX}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. coder-review-1"
                />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={create.isPending}>
                <IconKey size={14} />
                {create.isPending ? "Generating…" : "Generate token"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
