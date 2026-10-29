"use client";

import { isValidDomain, normalizeDomain } from "@omniralph/db/domains";
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  IconButton,
  MetaBadge,
  SaveBar,
  Select,
  Switch,
  TokenInput,
  toast,
  type DataTableColumn,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { IconMailPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { ApiError, api } from "@/lib/api/client";
import { organizationKeys, type QueryKeys } from "@/lib/api/keys";
import type { InvitationRow, MemberRow, OrganizationSettings } from "@/lib/api/organization";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { emailDomain, isValidEmail } from "@/lib/auth/allowlist";
import { checkUserChange, isRole, type Role } from "@/lib/auth/roles";
import { shortDate } from "@/lib/fleet/status";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { useOrganizationSettings } from "./queries";

export const ROLE_LABELS: Record<Role, string> = { admin: "Admin", member: "Member" };

/** The joining-by-domain switch's label. */
export const DOMAIN_JOIN_LABEL = "Anyone with a verified email at these domains can join";

const INVALID_EMAIL = "Enter a valid email address.";
const EMAIL_NOT_ALLOWED = "That email isn't in one of this organization's email domains.";
const INVALID_DOMAIN = "Enter a valid domain, like example.com.";

/** Today's refusal for removing an admin's own membership from Members. */
export const REMOVE_SELF = "You can't remove yourself.";

const settingsKey = (keys: QueryKeys) => organizationKeys(keys).settings;

/** A mutation of `/api/ui/organization/**` answering `{ ok: true }`. */
function send(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  organizationId: string,
  body?: unknown,
): Promise<MutationResult> {
  const request = { body, organizationId };
  const full = `/api/ui/organization${path}`;
  if (method === "POST") return api.post(full, mutationResultSchema, request);
  if (method === "PATCH") return api.patch(full, mutationResultSchema, request);
  return api.delete(full, mutationResultSchema, request);
}

/** Writes the organization's cached settings (exact key). */
function updateSettings(
  cache: MutationCache,
  update: (previous: OrganizationSettings) => OrganizationSettings,
) {
  return cache.set<OrganizationSettings>(
    settingsKey(cache.keys),
    (previous) => previous && update(previous),
    { exact: true },
  );
}

/** Why an invitation email can't be added: not an email, or outside the domains. */
export function invitationEmailError(email: string, domains: readonly string[]): string | null {
  if (!isValidEmail(email)) return INVALID_EMAIL;
  const domain = emailDomain(email.trim());
  if (domains.length > 0 && (domain === null || !domains.includes(domain))) {
    return EMAIL_NOT_ALLOWED;
  }
  return null;
}

/** Why a domain can't be added, or null. */
export function domainError(domain: string): string | null {
  return isValidDomain(normalizeDomain(domain)) ? null : INVALID_DOMAIN;
}

// ── Members ───────────────────────────────────────────────────────────────────

function Avatar({ member }: { member: MemberRow }) {
  return (
    <span className="or-avatar or-member__avatar" aria-hidden="true">
      {member.image ? (
        // The sign-in provider's picture, any host: as the shell's avatar renders it.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="or-avatar__img" src={member.image} alt="" />
      ) : (
        userInitials(member)
      )}
    </span>
  );
}

interface MemberActions {
  isAdmin: boolean;
  currentUserId: string;
  adminCount: number;
  onRole: (member: MemberRow, role: Role) => void;
  onRemove: (member: MemberRow) => void;
}

/** Why removing `member` isn't allowed (yourself, the last admin), or null. */
function removeRefusal(member: MemberRow, actions: MemberActions): string | null {
  return checkUserChange({
    actorId: actions.currentUserId,
    target: { id: member.id, role: member.role },
    newRole: null,
    adminCount: actions.adminCount,
  });
}

function memberColumns(actions: MemberActions): DataTableColumn<MemberRow>[] {
  const columns: DataTableColumn<MemberRow>[] = [
    {
      id: "name",
      header: "Name",
      card: "title",
      cell: (member) => (
        <span className="or-member">
          <Avatar member={member} />
          <span className="or-member__name">{userDisplayName(member)}</span>
          {member.id === actions.currentUserId ? <MetaBadge text="You" /> : null}
        </span>
      ),
    },
    { id: "email", header: "Email", mono: true, cell: (member) => member.email ?? "No email" },
    {
      id: "role",
      header: "Role",
      // Under the name on phone (Design rule 16): a card leads with who, not their role.
      card: "meta",
      cell: (member) =>
        actions.isAdmin ? (
          <Select
            aria-label={`Role for ${userDisplayName(member)}`}
            value={member.role}
            onChange={(event) => {
              if (isRole(event.target.value)) actions.onRole(member, event.target.value);
            }}
          >
            <option value="admin">{ROLE_LABELS.admin}</option>
            <option value="member">{ROLE_LABELS.member}</option>
          </Select>
        ) : (
          ROLE_LABELS[member.role]
        ),
    },
    {
      id: "joined",
      header: "Joined",
      card: "time",
      mono: true,
      cell: (member) => shortDate(member.joinedAt),
    },
  ];
  if (!actions.isAdmin) return columns;
  return [
    ...columns,
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      card: "meta",
      align: "end",
      cell: (member) => {
        const refusal = removeRefusal(member, actions);
        return (
          <IconButton
            label={`Remove ${userDisplayName(member)}`}
            icon={IconTrash}
            variant="ghost"
            disabled={refusal !== null}
            disabledReason={refusal ?? undefined}
            onClick={() => actions.onRemove(member)}
          />
        );
      },
    },
  ];
}

/**
 * The Members card: everyone in the organization in a `DataTable` (cards on phone). Admins
 * change a role with its `Select` and remove a member after a `ConfirmDialog`; both show at
 * once (optimistic) and are rolled back with the server's message when refused. Demoting or
 * removing the last admin is refused before any request, with today's message.
 */
function MembersCard({ settings }: { settings: OrganizationSettings }) {
  const router = useRouter();
  const { members, isAdmin, currentUserId } = settings;
  const [target, setTarget] = useState<MemberRow | null>(null);
  const [confirming, setConfirming] = useState(false);

  const changeRole = useApiMutation({
    mutationFn: ({ member, role }: { member: MemberRow; role: Role }, { organizationId }) =>
      send("PATCH", `/members/${encodeURIComponent(member.id)}`, organizationId, { role }),
    optimistic: ({ member, role }, cache) =>
      updateSettings(cache, (previous) => ({
        ...previous,
        members: previous.members.map((m) => (m.id === member.id ? { ...m, role } : m)),
      })),
    invalidate: (keys) => [settingsKey(keys)],
    success: (_, { member, role }) =>
      `${userDisplayName(member)} is now ${ROLE_LABELS[role].toLowerCase()}`,
    // A changed own role changes what the shell offers.
    onSuccess: (_, { member }) => {
      if (member.id === currentUserId) router.refresh();
    },
  });
  const remove = useApiMutation({
    mutationFn: (member: MemberRow, { organizationId }) =>
      send("DELETE", `/members/${encodeURIComponent(member.id)}`, organizationId),
    optimistic: (member, cache) =>
      updateSettings(cache, (previous) => ({
        ...previous,
        members: previous.members.filter((m) => m.id !== member.id),
      })),
    invalidate: (keys) => [settingsKey(keys)],
    success: (_, member) => `Removed ${userDisplayName(member)}`,
  });

  const actions: MemberActions = {
    isAdmin,
    currentUserId,
    adminCount: members.filter((m) => m.role === "admin").length,
    onRole: (member, role) => {
      const refusal = checkUserChange({
        actorId: currentUserId,
        target: { id: member.id, role: member.role },
        newRole: role,
        adminCount: actions.adminCount,
      });
      if (refusal) {
        toast(refusal, { variant: "danger" });
        return;
      }
      changeRole.mutate({ member, role });
    },
    onRemove: (member) => {
      setTarget(member);
      setConfirming(true);
    },
  };

  return (
    <Card
      title="Members"
      titleId="members"
      titleAddon={<ChangeHistoryPopover section="organization" latest={settings.history} />}
    >
      <DataTable
        caption="Members"
        rows={members}
        getRowId={(member) => member.id}
        columns={memberColumns(actions)}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={target ? `Remove ${userDisplayName(target)}?` : ""}
        description="They lose access to this organization. Their account and other organizations are kept."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (target) remove.mutate(target);
        }}
      />
    </Card>
  );
}

// ── Invitations ───────────────────────────────────────────────────────────────

interface InviteInput {
  emails: string[];
  role: Role;
}

/** A pending invitation shown before the server has answered (replaced by the refetch). */
function pendingInvitation(email: string, role: Role, now: Date): InvitationRow {
  return {
    id: `pending:${email}`,
    email,
    role,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
  };
}

/**
 * The Invitations card (admins): a `TokenInput` of emails (one chip per valid address in the
 * organization's domains) and a role, then the pending invitations with their expiry and a
 * revoke icon button. Invites (one request per email) and revokes show at once; a refused
 * invite is rolled back with the server's message and its emails stay in the input.
 */
function InvitationsCard({ settings }: { settings: OrganizationSettings }) {
  const { invitations, domains } = settings;
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<Role>("member");
  const [target, setTarget] = useState<InvitationRow | null>(null);
  const [confirming, setConfirming] = useState(false);

  const invite = useApiMutation({
    mutationFn: async (input: InviteInput, { organizationId }) => {
      const failed: { email: string; error: Error }[] = [];
      for (const email of input.emails) {
        try {
          await send("POST", "/invitations", organizationId, { email, role: input.role });
        } catch (error) {
          failed.push({ email, error: error as Error });
        }
      }
      const [first] = failed;
      if (first) {
        const message =
          input.emails.length === 1
            ? first.error.message
            : `${first.email}: ${first.error.message}`;
        throw Object.assign(
          new ApiError(message, first.error instanceof ApiError ? first.error.status : 0),
          { failed: failed.map((f) => f.email) },
        );
      }
      return { ok: true as const };
    },
    optimistic: (input, cache) => {
      const now = new Date();
      return updateSettings(cache, (previous) => ({
        ...previous,
        invitations: [
          ...previous.invitations,
          ...input.emails.map((email) => pendingInvitation(email, input.role, now)),
        ],
      }));
    },
    invalidate: (keys) => [settingsKey(keys)],
    success: (_, input) =>
      input.emails.length === 1
        ? `Invited ${input.emails[0]}`
        : `Invited ${input.emails.length} people`,
    onError: (error) => {
      const failed = (error as ApiError & { failed?: string[] }).failed;
      if (failed) setEmails(failed);
    },
  });
  const revoke = useApiMutation({
    mutationFn: (invitation: InvitationRow, { organizationId }) =>
      send("DELETE", `/invitations/${encodeURIComponent(invitation.id)}`, organizationId),
    optimistic: (invitation, cache) =>
      updateSettings(cache, (previous) => ({
        ...previous,
        invitations: previous.invitations.filter((i) => i.id !== invitation.id),
      })),
    invalidate: (keys) => [settingsKey(keys)],
    success: (_, invitation) => `Revoked ${invitation.email}`,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (emails.length === 0) return;
    invite.mutate({ emails, role });
    setEmails([]);
    setRole("member");
  };

  return (
    <Card title="Invitations" titleId="invitations">
      <form className="or-invite" onSubmit={submit}>
        <Field label="Emails" htmlFor="invite-emails" className="or-invite__emails" stacked>
          <TokenInput
            id="invite-emails"
            values={emails}
            onChange={(values) => setEmails([...new Set(values.map((v) => v.toLowerCase()))])}
            validate={(value) => invitationEmailError(value, domains)}
            placeholder="name@example.com"
            autoComplete="off"
          />
        </Field>
        <Field label="Role" htmlFor="invite-role" stacked>
          <Select
            id="invite-role"
            value={role}
            onChange={(event) => {
              if (isRole(event.target.value)) setRole(event.target.value);
            }}
          >
            <option value="member">{ROLE_LABELS.member}</option>
            <option value="admin">{ROLE_LABELS.admin}</option>
          </Select>
        </Field>
        <Button type="submit" variant="solid" icon={IconMailPlus} disabled={emails.length === 0}>
          Invite
        </Button>
      </form>
      {invitations.length === 0 ? (
        <p className="or-members__note">No pending invitations</p>
      ) : (
        <ul className="or-invitations" aria-label="Pending invitations">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="or-invitation">
              <span className="or-invitation__email or-mono">{invitation.email}</span>
              <MetaBadge text={ROLE_LABELS[invitation.role]} />
              <span className="or-invitation__expiry">
                Expires <span className="or-mono">{shortDate(invitation.expiresAt)}</span>
              </span>
              <IconButton
                label={`Revoke invitation for ${invitation.email}`}
                icon={IconX}
                variant="ghost"
                disabled={invitation.id.startsWith("pending:")}
                onClick={() => {
                  setTarget(invitation);
                  setConfirming(true);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={target ? `Revoke the invitation for ${target.email}?` : ""}
        description="They can no longer accept it. You can invite them again afterwards."
        confirmLabel="Revoke"
        destructive
        onConfirm={() => {
          if (target) revoke.mutate(target);
        }}
      />
    </Card>
  );
}

// ── Joining by domain ─────────────────────────────────────────────────────────

/** The Joining by domain card, as `useStagedCard` stages it. */
export interface DomainsDraft {
  domains: string[];
  allowDomainJoin: boolean;
}

/** The save bar's items: each domain added or removed, and the switch. */
export function domainChanges(saved: DomainsDraft, draft: DomainsDraft): StagedChange[] {
  const changes: StagedChange[] = [];
  for (const domain of draft.domains) {
    if (!saved.domains.includes(domain)) {
      changes.push({ id: `add:${domain}`, label: domain, to: "Added" });
    }
  }
  for (const domain of saved.domains) {
    if (!draft.domains.includes(domain)) {
      changes.push({
        id: `remove:${domain}`,
        label: domain,
        to: "Removed",
        effect: "Existing members are kept.",
      });
    }
  }
  const allow = draft.allowDomainJoin && draft.domains.length > 0;
  if (allow !== saved.allowDomainJoin) {
    changes.push({
      id: "allowDomainJoin",
      label: "Joining by domain",
      from: saved.allowDomainJoin ? "On" : "Off",
      to: allow ? "On" : "Off",
      effect: allow ? "People with an email at these domains join as members." : undefined,
    });
  }
  return changes;
}

/**
 * Saves the domains card with today's routes: the switch off first, then every added and
 * removed domain, then the switch on (it needs a domain). Stops at the first refusal.
 */
async function saveDomains(
  saved: DomainsDraft,
  draft: DomainsDraft,
  organizationId: string,
): Promise<DomainsDraft> {
  const allow = draft.allowDomainJoin && draft.domains.length > 0;
  if (saved.allowDomainJoin && !allow) {
    await send("PATCH", "", organizationId, { allowDomainJoin: false });
  }
  for (const domain of draft.domains) {
    if (!saved.domains.includes(domain)) {
      await send("POST", "/domains", organizationId, { domain });
    }
  }
  for (const domain of saved.domains) {
    if (!draft.domains.includes(domain)) {
      await send("DELETE", `/domains/${encodeURIComponent(domain)}`, organizationId);
    }
  }
  if (!saved.allowDomainJoin && allow) {
    await send("PATCH", "", organizationId, { allowDomainJoin: true });
  }
  return { domains: [...draft.domains].sort(), allowDomainJoin: allow };
}

/**
 * The Joining by domain card: the organization's email domains in a `TokenInput` (valid
 * domains, lower-cased) and the switch, staged in its `SaveBar` and saved together; the
 * saved state is written into the cache at once. Members see the domains and the switch
 * read-only.
 */
function DomainsCard({ settings }: { settings: OrganizationSettings }) {
  const { isAdmin } = settings;
  const saved = useMemo<DomainsDraft>(
    () => ({
      domains: settings.domains,
      allowDomainJoin: settings.organization.allowDomainJoin,
    }),
    [settings.domains, settings.organization.allowDomainJoin],
  );
  const card = useStagedCard<DomainsDraft, DomainsDraft>({
    label: "Joining by domain",
    saved,
    toChanges: domainChanges,
    save: useStagedSave({
      request: (draft, { organizationId }) => saveDomains(saved, draft, organizationId),
      applyResult: (result, cache) =>
        updateSettings(cache, (previous) => ({
          ...previous,
          domains: result.domains,
          organization: { ...previous.organization, allowDomainJoin: result.allowDomainJoin },
        })),
      // A refusal part-way leaves some changes saved: the refetch shows which.
      invalidate: (keys) => [settingsKey(keys)],
    }),
    onDirtyChange: useUnsavedCard("Joining by domain"),
  });
  const { domains, allowDomainJoin } = card.draft;
  const shownAllow = allowDomainJoin && domains.length > 0;

  return (
    <Card title="Joining by domain" titleId="joining-by-domain">
      <Field label="Email domains" htmlFor="organization-domains">
        {isAdmin ? (
          <TokenInput
            id="organization-domains"
            values={domains}
            disabled={card.saving}
            onChange={(values) =>
              card.set("domains", [...new Set(values.map(normalizeDomain))].sort())
            }
            validate={domainError}
            placeholder="example.com"
            autoComplete="off"
          />
        ) : domains.length === 0 ? (
          <p id="organization-domains" className="or-members__note">
            No domains
          </p>
        ) : (
          <ul id="organization-domains" className="or-domains" aria-label="Email domains">
            {domains.map((domain) => (
              <li key={domain}>
                <MetaBadge text={domain} mono />
              </li>
            ))}
          </ul>
        )}
      </Field>
      <Switch
        label={DOMAIN_JOIN_LABEL}
        checked={shownAllow}
        disabled={!isAdmin || card.saving || domains.length === 0}
        onCheckedChange={(checked) => card.set("allowDomainJoin", checked)}
      />
      {isAdmin ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
        />
      ) : null}
    </Card>
  );
}

/**
 * Organization › Members: the members, (admins) invitations, and joining by domain. A live
 * query: another admin's member, invitation or domain change arrives through the
 * organization's `organization` event.
 */
export function MembersSettings() {
  const query = useOrganizationSettings();
  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    return (
      <EmptyState
        title="Couldn't load the organization"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const settings = query.data;
  return (
    <>
      <MembersCard settings={settings} />
      {settings.isAdmin ? <InvitationsCard settings={settings} /> : null}
      <DomainsCard settings={settings} />
    </>
  );
}
