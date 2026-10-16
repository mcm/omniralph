"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutationState, useQuery } from "@tanstack/react-query";
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
  Skeleton,
  Stack,
  Switch,
} from "@iamthemcmaster/ui";
import { IconDoorExit, IconMailPlus, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { Timestamp } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { useCurrentUser } from "@/components/current-user";
import { useExpectOrganizationSwitch } from "@/components/organization-guard";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import {
  organizationSettingsSchema,
  type InvitationRow,
  type MemberRow,
  type OrganizationSettings,
} from "@/lib/api/organization";
import { mutationResultSchema } from "@/lib/api/schemas";
import { isRole, type Role } from "@/lib/auth/roles";
import { MAX_ORGANIZATION_NAME_LENGTH } from "@/lib/organizations/name";
import { userDisplayName, userInitials } from "@/lib/user-display";

export type { InvitationRow, MemberRow };

/** The active organization's settings, live (`GET /api/ui/organization`). */
export function useOrganizationSettings() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.organization.detail("settings"),
    queryFn: ({ signal }) =>
      api.get("/api/ui/organization", organizationSettingsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/** What an organization change affects: this page (the sidebar re-renders from the layout). */
const organizationChanged = (keys: QueryKeys) => [keys.organization.all];

/** A JSON mutation of `/api/ui/organization/**`. */
function send(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  organizationId: string,
  body?: unknown,
) {
  const request = { body, organizationId };
  const full = `/api/ui/organization${path}`;
  if (method === "POST") return api.post(full, mutationResultSchema, request);
  if (method === "PATCH") return api.patch(full, mutationResultSchema, request);
  return api.delete(full, mutationResultSchema, request);
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
  const router = useRouter();
  // Follows a rename made elsewhere while the field isn't being edited.
  const [value, setValue] = useSeededDraft(name);
  const trimmed = value.trim();
  const rename = useApiMutation({
    mutationFn: (newName: string, { organizationId }) =>
      send("PATCH", "", organizationId, { name: newName }),
    invalidate: organizationChanged,
    success: (_, newName) => `Renamed to ${newName}`,
    // The sidebar's organization switcher shows the name too.
    onSuccess: () => router.refresh(),
  });
  const pending = rename.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed === name) return;
    rename.mutate(trimmed);
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
  const router = useRouter();
  const name = userDisplayName(member);
  const change = useApiMutation({
    mutationFn: (role: Role, { organizationId }) =>
      send("PATCH", `/members/${encodeURIComponent(member.id)}`, organizationId, { role }),
    invalidate: organizationChanged,
    success: (_, role) => `${name} is now ${roleLabel[role].toLowerCase()}`,
    // A changed own role changes the sidebar.
    onSuccess: () => {
      if (isSelf) router.refresh();
    },
  });
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      send("DELETE", `/members/${encodeURIComponent(member.id)}`, organizationId),
    invalidate: organizationChanged,
    success: `Removed ${name}`,
  });
  const pending = change.isPending || remove.isPending;
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
        {/* The email truncates at the end (full value in its title); the join date wraps whole. */}
        <div className="org-row-meta">
          {member.email ? <MonoValue value={member.email} truncate="end" /> : "No email"} ·{" "}
          <span className="list-nowrap">
            joined <Timestamp iso={member.joinedAt} date inline />
          </span>
        </div>
      </div>
      {isAdmin ? (
        <div className="org-row-actions">
          <RoleSelect
            aria-label={`Role for ${name}`}
            value={member.role}
            disabled={pending}
            onChange={(role) => change.mutate(role)}
          />
          <Confirm
            title={`Remove ${name}?`}
            description="They lose access to this organization. Their account and other organizations are kept."
            action="Remove"
            onConfirm={() => remove.mutate()}
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
  const revoke = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      send("DELETE", `/invitations/${invitation.id}`, organizationId),
    invalidate: organizationChanged,
    success: `Revoked ${invitation.email}`,
  });
  const pending = revoke.isPending;
  return (
    <div className="org-row">
      <div className="org-row-text">
        <div className="org-row-title">{invitation.email}</div>
        {/* Prose in sans, the times mono; it wraps between the two dates, never inside one. */}
        <div className="org-row-meta">
          <span className="list-nowrap">
            Invited <Timestamp iso={invitation.createdAt} inline />
          </span>{" "}
          ·{" "}
          <span className="list-nowrap">
            expires <Timestamp iso={invitation.expiresAt} inline />
          </span>
        </div>
      </div>
      <div className="org-row-actions">
        <Badge variant="neutral">{roleLabel[invitation.role]}</Badge>
        <Confirm
          title={`Revoke the invitation for ${invitation.email}?`}
          description="They can no longer accept it. You can invite them again afterwards."
          action="Revoke"
          onConfirm={() => revoke.mutate()}
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
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");
  const invite = useApiMutation({
    mutationFn: (input: { email: string; role: Role }, { organizationId }) =>
      send("POST", "/invitations", organizationId, input),
    invalidate: organizationChanged,
    success: (_, input) => `Invited ${input.email}`,
    onSuccess: () => {
      setEmail("");
      setRole("member");
    },
  });
  const pending = invite.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    invite.mutate({ email: value, role });
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
                  placeholder="e.g. name@example.com"
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
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      send("DELETE", `/domains/${encodeURIComponent(domain)}`, organizationId),
    invalidate: organizationChanged,
    success: `Removed ${domain}`,
  });
  const pending = remove.isPending;
  return (
    <div className="org-row org-row-compact">
      <span className="flex-1 font-mono text-sm">{domain}</span>
      {isAdmin && (
        <DangerIconButton
          label={`Remove ${domain}`}
          disabled={pending}
          onClick={() => remove.mutate()}
        >
          <IconTrash size={14} />
        </DangerIconButton>
      )}
    </div>
  );
}

const domainJoinMutationKey = ["organization-allow-domain-join"];

/**
 * Switches "Allow anyone with a matching email to join" (admins): `pendingEnabled` is the
 * state shown while the change is in flight (optimistic), and goes away by itself when it
 * fails (with the server's error as a toast), so the switch moves back. The settings
 * refetch before the change settles, so it never flickers back on success.
 */
export function useDomainJoinSwitch() {
  const mutation = useApiMutation({
    mutationKey: domainJoinMutationKey,
    mutationFn: (enabled: boolean, { organizationId }) =>
      send("PATCH", "", organizationId, { allowDomainJoin: enabled }),
    invalidate: organizationChanged,
    success: (_, enabled) =>
      enabled ? "Anyone with a matching email can join" : "Joining by email turned off",
  });
  const pending = useMutationState({
    filters: { mutationKey: domainJoinMutationKey, status: "pending" },
    select: (m) => m.state.variables as boolean | undefined,
  });
  return { setEnabled: mutation.mutate, pendingEnabled: pending.at(-1) };
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
  const [domain, setDomain] = React.useState("");
  const add = useApiMutation({
    mutationFn: (value: string, { organizationId }) =>
      send("POST", "/domains", organizationId, { domain: value }),
    invalidate: organizationChanged,
    success: (_, value) => `Added ${value}`,
    onSuccess: () => setDomain(""),
  });
  const toggle = useDomainJoinSwitch();
  const shownAllowDomainJoin = toggle.pendingEnabled ?? allowDomainJoin;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = domain.trim();
    if (!value) return;
    add.mutate(value);
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
                    placeholder="e.g. example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={add.isPending || !domain.trim()}>
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
            {/* Held disabled (showing the new state) while its change is in flight, so two
            changes never race. */}
            <Switch
              id="allow-domain-join"
              checked={shownAllowDomainJoin}
              disabled={
                !isAdmin ||
                toggle.pendingEnabled !== undefined ||
                (domains.length === 0 && !shownAllowDomainJoin)
              }
              onCheckedChange={(enabled) => toggle.setEnabled(enabled)}
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
  const expectSwitch = useExpectOrganizationSwitch();
  const leave = useApiMutation({
    // Leaving switches to another of the user's organizations, if any.
    mutationFn: async (_: void, { organizationId }) => {
      const result = await send("POST", "/leave", organizationId);
      expectSwitch();
      return result;
    },
    // Nothing to refetch here: the panel starts over in the next organization (or onboarding).
    invalidate: () => [],
    success: `Left ${organizationName}`,
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
  });
  const pending = leave.isPending || leave.isSuccess;
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
          onConfirm={() => leave.mutate()}
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

function SettingsSkeleton() {
  return (
    <Stack gap={4}>
      {[2, 4, 3].map((rows, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <Stack gap={3} asChild>
            <CardContent>
              {Array.from({ length: rows }, (_, row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </CardContent>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

/** Settings › Organization, live: member, invitation and domain changes show without a reload. */
export function OrganizationSettingsView() {
  const query = useOrganizationSettings();
  const { organization, role } = useCurrentUser();
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Organization" }]} />
      <main className="detail-main">
        <PageHeader
          title="Organization"
          description={
            role === "admin"
              ? `Settings for ${query.data?.organization.name ?? organization.name}: its name, members, invitations and email domains.`
              : `Settings for ${query.data?.organization.name ?? organization.name}. Only admins can change them.`
          }
        />
        <QueryBoundary query={query} skeleton={<SettingsSkeleton />} what="the organization">
          {(settings) => <OrganizationSettingsContent {...settings} />}
        </QueryBoundary>
      </main>
    </>
  );
}

export function OrganizationSettingsContent({
  isAdmin,
  currentUserId,
  organization,
  domains,
  members,
  invitations,
}: OrganizationSettings) {
  return (
    <>
      <GeneralCard name={organization.name} isAdmin={isAdmin} />
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
    </>
  );
}
