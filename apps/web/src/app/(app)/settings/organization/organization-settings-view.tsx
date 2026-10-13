"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Cluster,
  Field,
  Input,
  Muted,
  NativeSelect,
  Separator,
  Stack,
  Switch,
} from "@iamthemcmaster/ui";
import { IconDoorExit, IconMailPlus, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import { isRole, type Role } from "@/lib/auth/roles";
import { formatDateTime } from "@/lib/format-date";
import { MAX_ORGANIZATION_NAME_LENGTH } from "@/lib/organizations/name";
import { userDisplayName, userInitials } from "@/lib/user-display";
import {
  addDomain,
  changeMemberRole,
  inviteMember,
  leaveOrganization,
  removeDomain,
  removeMemberAction,
  renameOrganization,
  revokeInvitationAction,
  setAllowDomainJoin,
} from "./actions";

export interface MemberRow {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: Role;
  /** ISO timestamp. */
  joinedAt: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  expiresAt: string;
}

interface OrganizationSettingsViewProps {
  isAdmin: boolean;
  currentUserId: string;
  organization: { name: string; allowDomainJoin: boolean };
  domains: string[];
  members: MemberRow[];
  /** Pending invitations; empty for members. */
  invitations: InvitationRow[];
}

const roleLabel: Record<Role, string> = { admin: "Admin", member: "Member" };

function RoleSelect({
  value,
  onChange,
  disabled,
  ...props
}: {
  value: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
  "aria-label": string;
  id?: string;
}) {
  return (
    <NativeSelect
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (isRole(e.target.value)) onChange(e.target.value);
      }}
      className="org-role-select"
      {...props}
    >
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </NativeSelect>
  );
}

function Confirm({
  title,
  description,
  action,
  onConfirm,
  trigger,
}: {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void;
  trigger: React.ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DangerIconButton({
  label,
  disabled,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      aria-label={label}
      title={label}
      className="org-danger-icon"
      {...props}
    >
      {children}
    </Button>
  );
}

// ── General ───────────────────────────────────────────────────────────────────

function GeneralCard({ name, isAdmin }: { name: string; isAdmin: boolean }) {
  const { pending, run } = useAction();
  const [value, setValue] = React.useState(name);
  const trimmed = value.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed === name) return;
    run(() => renameOrganization(trimmed), `Renamed to ${trimmed}`);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">General</CardTitle>
        <CardDescription>The organization&apos;s name, shown to its members.</CardDescription>
      </CardHeader>
      <CardContent>
        <Cluster gap={3} align="end" asChild>
          <form onSubmit={submit}>
            <Field label="Name" htmlFor="organization-name" required className="flex-1">
              <Input
                id="organization-name"
                required
                maxLength={MAX_ORGANIZATION_NAME_LENGTH}
                value={value}
                disabled={!isAdmin}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            {isAdmin && (
              <Button
                type="submit"
                variant="primary"
                disabled={pending || !trimmed || trimmed === name}
              >
                {pending ? "Saving…" : "Rename"}
              </Button>
            )}
          </form>
        </Cluster>
      </CardContent>
    </Card>
  );
}

// ── Members ───────────────────────────────────────────────────────────────────

function Member({
  member,
  isSelf,
  isAdmin,
}: {
  member: MemberRow;
  isSelf: boolean;
  isAdmin: boolean;
}) {
  const { pending, run } = useAction();
  const name = userDisplayName(member);
  return (
    <div className="org-row">
      <Avatar className="org-avatar">
        {member.image && <AvatarImage src={member.image} alt="" />}
        <AvatarFallback className="org-avatar-fallback">{userInitials(member)}</AvatarFallback>
      </Avatar>
      <div className="org-row-text">
        <div className="org-row-title">
          {name}
          {isSelf && <Badge variant="neutral">You</Badge>}
        </div>
        <div className="org-row-secondary">
          {member.email ?? "no email"} · joined {new Date(member.joinedAt).toLocaleDateString()}
        </div>
      </div>
      {isAdmin ? (
        <div className="org-row-actions">
          <RoleSelect
            aria-label={`Role for ${name}`}
            value={member.role}
            disabled={pending}
            onChange={(role) =>
              run(
                () => changeMemberRole(member.id, role),
                `${name} is now ${roleLabel[role].toLowerCase()}`,
              )
            }
          />
          <Confirm
            title={`Remove ${name}?`}
            description="They lose access to this organization. Their account and other organizations are kept."
            action="Remove"
            onConfirm={() => run(() => removeMemberAction(member.id), `Removed ${name}`)}
            trigger={
              <DangerIconButton label={`Remove ${name}`} disabled={pending || isSelf}>
                <IconTrash size={14} />
              </DangerIconButton>
            }
          />
        </div>
      ) : (
        <Badge variant="neutral">{roleLabel[member.role]}</Badge>
      )}
    </div>
  );
}

function MembersCard({
  members,
  currentUserId,
  isAdmin,
  organizationName,
}: {
  members: MemberRow[];
  currentUserId: string;
  isAdmin: boolean;
  organizationName: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Members</CardTitle>
        <CardDescription>
          Everyone who belongs to {organizationName}. Admins manage repositories, agents and
          members; members have read access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div>
          {members.map((member, i) => (
            <React.Fragment key={member.id}>
              <Member member={member} isSelf={member.id === currentUserId} isAdmin={isAdmin} />
              {i < members.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Invitations ───────────────────────────────────────────────────────────────

function Invitation({ invitation }: { invitation: InvitationRow }) {
  const { pending, run } = useAction();
  return (
    <div className="org-row">
      <div className="org-row-text">
        <div className="org-row-title">{invitation.email}</div>
        <div className="org-row-secondary">
          invited {formatDateTime(invitation.createdAt)} · expires{" "}
          {formatDateTime(invitation.expiresAt)}
        </div>
      </div>
      <div className="org-row-actions">
        <Badge variant="neutral">{roleLabel[invitation.role]}</Badge>
        <Confirm
          title={`Revoke the invitation for ${invitation.email}?`}
          description="They can no longer accept it. You can invite them again afterwards."
          action="Revoke"
          onConfirm={() =>
            run(() => revokeInvitationAction(invitation.id), `Revoked ${invitation.email}`)
          }
          trigger={
            <DangerIconButton
              label={`Revoke invitation for ${invitation.email}`}
              disabled={pending}
            >
              <IconX size={14} />
            </DangerIconButton>
          }
        />
      </div>
    </div>
  );
}

function InvitationsCard({
  invitations,
  domains,
}: {
  invitations: InvitationRow[];
  domains: string[];
}) {
  const { pending, run } = useAction();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    run(
      () => inviteMember(value, role),
      `Invited ${value}`,
      () => {
        setEmail("");
        setRole("member");
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Invitations</CardTitle>
        <CardDescription>
          Invited people see the invitation after signing in with that email. Invitations expire
          after 14 days.
          {domains.length > 0 && ` Only emails in ${domains.join(", ")} can be invited.`}
        </CardDescription>
      </CardHeader>
      <Stack gap={3} asChild>
        <CardContent>
          <Cluster gap={3} align="end" asChild>
            <form onSubmit={submit}>
              <Field label="Email" htmlFor="invite-email" required className="org-invite-email">
                <Input
                  id="invite-email"
                  type="email"
                  required
                  autoComplete="off"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Role" htmlFor="invite-role">
                <RoleSelect id="invite-role" aria-label="Role" value={role} onChange={setRole} />
              </Field>
              <Button type="submit" variant="primary" disabled={pending || !email.trim()}>
                <IconMailPlus size={14} />
                {pending ? "Inviting…" : "Invite"}
              </Button>
            </form>
          </Cluster>
          {invitations.length === 0 ? (
            <Muted>No pending invitations.</Muted>
          ) : (
            <div>
              {invitations.map((invitation, i) => (
                <React.Fragment key={invitation.id}>
                  <Invitation invitation={invitation} />
                  {i < invitations.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </div>
          )}
        </CardContent>
      </Stack>
    </Card>
  );
}

// ── Email domains ─────────────────────────────────────────────────────────────

function Domain({ domain, isAdmin }: { domain: string; isAdmin: boolean }) {
  const { pending, run } = useAction();
  return (
    <div className="org-row org-row-compact">
      <span className="flex-1 font-mono text-sm">{domain}</span>
      {isAdmin && (
        <DangerIconButton
          label={`Remove ${domain}`}
          disabled={pending}
          onClick={() => run(() => removeDomain(domain), `Removed ${domain}`)}
        >
          <IconTrash size={14} />
        </DangerIconButton>
      )}
    </div>
  );
}

function DomainsCard({
  domains,
  allowDomainJoin,
  isAdmin,
}: {
  domains: string[];
  allowDomainJoin: boolean;
  isAdmin: boolean;
}) {
  const add = useAction();
  const toggle = useAction();
  const [domain, setDomain] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = domain.trim();
    if (!value) return;
    add.run(
      () => addDomain(value),
      `Added ${value}`,
      () => setDomain(""),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Email domains</CardTitle>
        <CardDescription>
          With domains set, only emails in them can be invited or join. Existing members are kept
          when the domains change.
        </CardDescription>
      </CardHeader>
      <Stack gap={3} asChild>
        <CardContent>
          {domains.length === 0 ? (
            <Muted>No domains: anyone can be invited.</Muted>
          ) : (
            <div>
              {domains.map((d) => (
                <Domain key={d} domain={d} isAdmin={isAdmin} />
              ))}
            </div>
          )}
          {isAdmin && (
            <Cluster gap={3} align="end" asChild>
              <form onSubmit={submit}>
                <Field label="Domain" htmlFor="organization-domain" className="flex-1">
                  <Input
                    id="organization-domain"
                    required
                    autoComplete="off"
                    placeholder="example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={add.pending || !domain.trim()}>
                  <IconPlus size={14} />
                  Add domain
                </Button>
              </form>
            </Cluster>
          )}
          <Separator />
          <Cluster gap={3}>
            <div className="flex-1">
              <label htmlFor="allow-domain-join" className="settings-group-label">
                Allow anyone with a matching email to join
              </label>
              <Muted>
                Signed-in users with an email in these domains can join as members without an
                invitation.
                {domains.length === 0 && " Add a domain first."}
              </Muted>
            </div>
            <Switch
              id="allow-domain-join"
              checked={allowDomainJoin}
              disabled={!isAdmin || toggle.pending || (domains.length === 0 && !allowDomainJoin)}
              onCheckedChange={(enabled) =>
                toggle.run(
                  () => setAllowDomainJoin(enabled),
                  enabled ? "Anyone with a matching email can join" : "Joining by email turned off",
                )
              }
            />
          </Cluster>
        </CardContent>
      </Stack>
    </Card>
  );
}

// ── Leave ─────────────────────────────────────────────────────────────────────

function LeaveCard({ organizationName }: { organizationName: string }) {
  const router = useRouter();
  const { pending, run } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Leave organization</CardTitle>
        <CardDescription>
          You lose access to {organizationName}&apos;s repositories, agents and settings. The last
          admin can&apos;t leave.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Confirm
          title={`Leave ${organizationName}?`}
          description="An admin has to invite you again to rejoin."
          action="Leave"
          onConfirm={() =>
            run(
              () => leaveOrganization(),
              `Left ${organizationName}`,
              () => {
                router.push("/");
                router.refresh();
              },
            )
          }
          trigger={
            <Button variant="danger" disabled={pending}>
              <IconDoorExit size={14} />
              Leave organization
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function OrganizationSettingsView({
  isAdmin,
  currentUserId,
  organization,
  domains,
  members,
  invitations,
}: OrganizationSettingsViewProps) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Organization" }]} />
      <main className="detail-main">
        <PageHeader
          title="Organization"
          description={
            isAdmin
              ? `Settings for ${organization.name}: its name, members, invitations and email domains.`
              : `Settings for ${organization.name}. Only admins can change them.`
          }
        />

        {/* Keyed by name so a rename elsewhere resets the field. */}
        <GeneralCard key={organization.name} name={organization.name} isAdmin={isAdmin} />
        <MembersCard
          members={members}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          organizationName={organization.name}
        />
        {isAdmin && <InvitationsCard invitations={invitations} domains={domains} />}
        <DomainsCard
          domains={domains}
          allowDomainJoin={organization.allowDomainJoin}
          isAdmin={isAdmin}
        />
        <LeaveCard organizationName={organization.name} />
      </main>
    </>
  );
}
