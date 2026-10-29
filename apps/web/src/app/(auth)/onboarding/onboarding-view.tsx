"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, TextInput } from "@omniralph/ui";
import { IconLogout, IconPlus } from "@tabler/icons-react";
import { useServerAction } from "../use-server-action";
import { signOutAction } from "@/lib/auth/actions";
import type { Role } from "@/lib/auth/roles";
import {
  acceptInvitationAction,
  createOrganizationAction,
  declineInvitationAction,
  joinOrganizationAction,
  switchOrganizationAction,
} from "./actions";

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

/** One organization in a list card: its name, a detail line and its actions. */
function OrganizationRow({
  name,
  detail,
  children,
}: {
  name: string;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="onboarding-row">
      <div className="onboarding-row-text">
        <span className="onboarding-row-name">{name}</span>
        {detail && <span className="onboarding-row-detail">{detail}</span>}
      </div>
      <div className="onboarding-row-actions">{children}</div>
    </li>
  );
}

/** Runs an organization action and, on success, opens the control panel in it. */
function useOrganizationAction() {
  const router = useRouter();
  const { pending, run } = useServerAction();
  const open = React.useCallback(
    (action: () => ReturnType<typeof switchOrganizationAction>, success: string) =>
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
    <Card title="Create an organization" className="auth-card">
      <form onSubmit={submit} className="auth-stack">
        <p className="auth-lede">
          Organizations share repositories, agents and integrations between their members. You
          become its admin and can invite others.
        </p>
        <Field label="Name" htmlFor="organization-name" stacked>
          <TextInput
            required
            maxLength={100}
            placeholder="e.g. Acme"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="solid" icon={IconPlus} disabled={pending || !name.trim()}>
          {pending ? "Creating…" : "Create organization"}
        </Button>
      </form>
    </Card>
  );
}

function Invitation({ invitation }: { invitation: InvitationRow }) {
  const { pending, run, open } = useOrganizationAction();
  const router = useRouter();
  return (
    <OrganizationRow
      name={invitation.organizationName}
      detail={`${roleLabel[invitation.role]} · expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}
    >
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
        variant="solid"
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
    </OrganizationRow>
  );
}

function JoinableOrganization({ organization }: { organization: { id: string; name: string } }) {
  const { pending, open } = useOrganizationAction();
  return (
    <OrganizationRow name={organization.name} detail="Open to your email domain">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          open(() => joinOrganizationAction(organization.id), `Joined ${organization.name}`)
        }
      >
        Join
      </Button>
    </OrganizationRow>
  );
}

function Membership({ organization }: { organization: { id: string; name: string; role: Role } }) {
  const { pending, open } = useOrganizationAction();
  return (
    <OrganizationRow name={organization.name} detail={roleLabel[organization.role]}>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          open(() => switchOrganizationAction(organization.id), `Switched to ${organization.name}`)
        }
      >
        Open
      </Button>
    </OrganizationRow>
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
    <Card title={title} className="auth-card">
      <div className="auth-stack">
        <p className="auth-lede">{description}</p>
        <ul className="onboarding-list" aria-label={title}>
          {children}
        </ul>
      </div>
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
    <div className="auth-stack auth-stack--loose">
      <div className="auth-stack">
        <h1 className="auth-title">
          {hasActiveOrganization ? "Organizations" : "Choose an organization"}
        </h1>
        {!hasActiveOrganization && (
          <p className="auth-lede">
            Everything in Omniralph belongs to an organization. Create one, or join one you were
            invited to{email ? ` as ${email}` : ""}.
          </p>
        )}
      </div>

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

      <div className="auth-actions auth-actions--split">
        {hasActiveOrganization ? (
          <Button href="/" variant="ghost">
            Back to the control panel
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="ghost"
          icon={IconLogout}
          disabled={signingOut}
          onClick={() => startSignOut(() => signOutAction())}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
