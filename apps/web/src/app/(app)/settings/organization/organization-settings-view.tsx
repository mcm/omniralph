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
  Field,
  Input,
  Muted,
  NativeSelect,
  Separator,
  Switch,
} from "@iamthemcmaster/ui";
import { IconDoorExit, IconMailPlus, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
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
      style={{ width: 120 }}
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
          <AlertDialogAction onClick={onConfirm}>{action}</AlertDialogAction>
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
      style={{ color: "var(--error)" }}
      {...props}
    >
      {children}
    </Button>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-3) 0",
};

const secondaryLine: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

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
        <CardTitle>General</CardTitle>
        <CardDescription>The organization&apos;s name, shown to its members.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={submit}
          style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)" }}
        >
          <Field label="Name" htmlFor="organization-name" required style={{ flex: 1 }}>
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
    <div style={rowStyle}>
      <Avatar style={{ width: 36, height: 36 }}>
        {member.image && <AvatarImage src={member.image} alt="" />}
        <AvatarFallback
          style={{ fontSize: 12, background: "var(--bg-raised)", color: "var(--glacier-300)" }}
        >
          {userInitials(member)}
        </AvatarFallback>
      </Avatar>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text-primary)",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          {name}
          {isSelf && <Badge variant="neutral">You</Badge>}
        </div>
        <div style={secondaryLine}>
          {member.email ?? "no email"} · joined {new Date(member.joinedAt).toLocaleDateString()}
        </div>
      </div>
      {isAdmin ? (
        <>
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
        </>
      ) : (
        <Badge variant="outline">{roleLabel[member.role]}</Badge>
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
        <CardTitle>Members</CardTitle>
        <CardDescription>
          Everyone who belongs to {organizationName}. Admins manage repositories, agents and
          members; members have read access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ display: "flex", flexDirection: "column" }}>
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
    <div style={rowStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 500 }}>
          {invitation.email}
        </div>
        <div style={secondaryLine}>
          invited {formatDateTime(invitation.createdAt)} · expires{" "}
          {formatDateTime(invitation.expiresAt)}
        </div>
      </div>
      <Badge variant="outline">{roleLabel[invitation.role]}</Badge>
      <Confirm
        title={`Revoke the invitation for ${invitation.email}?`}
        description="They can no longer accept it. You can invite them again afterwards."
        action="Revoke"
        onConfirm={() =>
          run(() => revokeInvitationAction(invitation.id), `Revoked ${invitation.email}`)
        }
        trigger={
          <DangerIconButton label={`Revoke invitation for ${invitation.email}`} disabled={pending}>
            <IconX size={14} />
          </DangerIconButton>
        }
      />
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
        <CardTitle>Invitations</CardTitle>
        <CardDescription>
          Invited people see the invitation after signing in with that email. Invitations expire
          after 14 days.
          {domains.length > 0 && ` Only emails in ${domains.join(", ")} can be invited.`}
        </CardDescription>
      </CardHeader>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <form
          onSubmit={submit}
          style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)" }}
        >
          <Field label="Email" htmlFor="invite-email" required style={{ flex: 1 }}>
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
        {invitations.length === 0 ? (
          <Muted>No pending invitations.</Muted>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {invitations.map((invitation, i) => (
              <React.Fragment key={invitation.id}>
                <Invitation invitation={invitation} />
                {i < invitations.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Email domains ─────────────────────────────────────────────────────────────

function Domain({ domain, isAdmin }: { domain: string; isAdmin: boolean }) {
  const { pending, run } = useAction();
  return (
    <div style={{ ...rowStyle, padding: "var(--space-2) 0" }}>
      <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
        {domain}
      </span>
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
        <CardTitle>Email domains</CardTitle>
        <CardDescription>
          With domains set, only emails in them can be invited or join. Existing members are kept
          when the domains change.
        </CardDescription>
      </CardHeader>
      <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        {domains.length === 0 ? (
          <Muted>No domains: anyone can be invited.</Muted>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {domains.map((d) => (
              <Domain key={d} domain={d} isAdmin={isAdmin} />
            ))}
          </div>
        )}
        {isAdmin && (
          <form
            onSubmit={submit}
            style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-3)" }}
          >
            <Field label="Domain" htmlFor="organization-domain" style={{ flex: 1 }}>
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
        )}
        <Separator />
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <div style={{ flex: 1 }}>
            <label
              htmlFor="allow-domain-join"
              style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 500 }}
            >
              Allow anyone with a matching email to join
            </label>
            <Muted style={{ display: "block" }}>
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
        </div>
      </CardContent>
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
        <CardTitle>Leave organization</CardTitle>
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
            <Button variant="destructive" disabled={pending}>
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
      <AppHeader breadcrumbs={[{ label: "Settings" }, { label: "Organization" }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>
            {organization.name}
          </h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            {isAdmin
              ? "Manage the organization's name, members, invitations and email domains."
              : "Only admins can change these settings."}
          </Muted>
        </div>

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
