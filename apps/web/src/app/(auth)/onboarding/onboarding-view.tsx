"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Muted,
  SonnerToaster,
} from "@iamthemcmaster/ui";
import { IconBuilding, IconLogout, IconPlus } from "@tabler/icons-react";
import { AuthBrand } from "@/components/auth-shell";
import { useAction } from "@/components/use-action";
import { signOutAction } from "@/lib/auth/actions";
import type { Role } from "@/lib/auth/roles";
import {
  acceptInvitationAction,
  createOrganizationAction,
  declineInvitationAction,
  joinOrganizationAction,
  switchOrganization,
} from "@/lib/organizations/actions";

export interface InvitationRow {
  id: string;
  organizationId: string;
  organizationName: string;
  role: Role;
  /** ISO timestamp. */
  expiresAt: string;
}

interface OnboardingViewProps {
  hasActiveOrganization: boolean;
  email: string | null;
  invitations: InvitationRow[];
  joinable: { id: string; name: string }[];
  memberships: { id: string; name: string; role: Role }[];
}

const roleLabel: Record<Role, string> = { admin: "Admin", member: "Member" };

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-4)",
  background: "var(--bg-raised)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-subtle)",
};

function OrganizationName({ name, detail }: { name: string; detail?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </div>
      {detail && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>{detail}</div>
      )}
    </div>
  );
}

/** Runs an organization action and, on success, opens the control panel in it. */
function useOrganizationAction() {
  const router = useRouter();
  const { pending, run } = useAction();
  const open = React.useCallback(
    (action: () => ReturnType<typeof switchOrganization>, success: string) =>
      run(action, success, () => router.push("/")),
    [run, router],
  );
  return { pending, run, open };
}

function CreateOrganizationCard() {
  const { pending, open } = useOrganizationAction();
  const [name, setName] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    open(() => createOrganizationAction(value), `Created ${value}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an organization</CardTitle>
        <CardDescription>
          Organizations share repositories, agents and integrations between their members. You
          become its admin and can invite others.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
        >
          <Field label="Name" htmlFor="organization-name" required>
            <Input
              id="organization-name"
              required
              maxLength={100}
              placeholder="Acme"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
            <IconPlus size={14} />
            {pending ? "Creating…" : "Create organization"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Invitation({ invitation }: { invitation: InvitationRow }) {
  const { pending, run, open } = useOrganizationAction();
  const router = useRouter();
  return (
    <div style={rowStyle}>
      <OrganizationName
        name={invitation.organizationName}
        detail={`${roleLabel[invitation.role]} · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          run(
            () => declineInvitationAction(invitation.id),
            `Declined ${invitation.organizationName}`,
            () => router.refresh(),
          )
        }
      >
        Decline
      </Button>
      <Button
        variant="primary"
        size="sm"
        disabled={pending}
        onClick={() =>
          open(
            () => acceptInvitationAction(invitation.id, invitation.organizationId),
            `Joined ${invitation.organizationName}`,
          )
        }
      >
        Accept
      </Button>
    </div>
  );
}

function JoinableOrganization({ organization }: { organization: { id: string; name: string } }) {
  const { pending, open } = useOrganizationAction();
  return (
    <div style={rowStyle}>
      <OrganizationName name={organization.name} detail="Open to your email domain" />
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          open(() => joinOrganizationAction(organization.id), `Joined ${organization.name}`)
        }
      >
        Join
      </Button>
    </div>
  );
}

function Membership({ organization }: { organization: { id: string; name: string; role: Role } }) {
  const { pending, open } = useOrganizationAction();
  return (
    <div style={rowStyle}>
      <OrganizationName name={organization.name} />
      <Badge variant="neutral">{roleLabel[organization.role]}</Badge>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          open(() => switchOrganization(organization.id), `Switched to ${organization.name}`)
        }
      >
        Open
      </Button>
    </div>
  );
}

function ListCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        {children}
      </CardContent>
    </Card>
  );
}

export function OnboardingView({
  hasActiveOrganization,
  email,
  invitations,
  joinable,
  memberships,
}: OnboardingViewProps) {
  const [signingOut, startSignOut] = React.useTransition();
  return (
    <>
      <AuthBrand />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <IconBuilding size={18} style={{ color: "var(--glacier-300)" }} />
          <h1 style={{ margin: 0, fontSize: "var(--text-xl)", fontWeight: 600 }}>
            {hasActiveOrganization ? "Organizations" : "Choose an organization"}
          </h1>
        </div>
        {!hasActiveOrganization && (
          <Muted>
            Everything in Omniralph belongs to an organization. Create one, or join one you were
            invited to{email ? ` as ${email}` : ""}.
          </Muted>
        )}

        {memberships.length > 0 && (
          <ListCard title="Your organizations" description="Organizations you're a member of.">
            {memberships.map((o) => (
              <Membership key={o.id} organization={o} />
            ))}
          </ListCard>
        )}

        {invitations.length > 0 && (
          <ListCard title="Invitations" description="Organizations that invited you.">
            {invitations.map((i) => (
              <Invitation key={i.id} invitation={i} />
            ))}
          </ListCard>
        )}

        {joinable.length > 0 && (
          <ListCard
            title="Organizations you can join"
            description="These organizations let anyone with your email domain join as a member."
          >
            {joinable.map((o) => (
              <JoinableOrganization key={o.id} organization={o} />
            ))}
          </ListCard>
        )}

        <CreateOrganizationCard />

        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-2)" }}>
          {hasActiveOrganization ? (
            <Button asChild variant="ghost">
              <Link href="/">Back to the control panel</Link>
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="ghost"
            disabled={signingOut}
            onClick={() => startSignOut(() => signOutAction())}
          >
            <IconLogout size={14} />
            Sign out
          </Button>
        </div>
      </div>
      <SonnerToaster position="bottom-right" />
    </>
  );
}
