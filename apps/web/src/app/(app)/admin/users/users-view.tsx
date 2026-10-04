"use client";

import * as React from "react";
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
  InlineCode,
  Input,
  Muted,
  NativeSelect,
  Separator,
} from "@iamthemcmaster/ui";
import { IconMail, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import type { ActionResult } from "@/lib/action-result";
import { isRole, type Role } from "@/lib/auth/roles";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { allowEmail, changeUserRole, disallowEmail, removeUser } from "./actions";

export interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: Role;
  /** ISO timestamp. */
  createdAt: string;
}

export interface AllowedEmailRow {
  email: string;
  role: Role;
  /** A user with this email exists. */
  signedUp: boolean;
}

interface UsersViewProps {
  currentUserId: string;
  allowedDomains: string[];
  users: UserRow[];
  allowedEmails: AllowedEmailRow[];
}

/** Runs a server action in a transition and reports its result as a toast. */
function useAction() {
  const [pending, startTransition] = React.useTransition();
  const run = React.useCallback(
    (action: () => Promise<ActionResult>, success: string, onSuccess?: () => void) => {
      startTransition(async () => {
        const result = await action();
        if (result.ok) {
          toast.success(success);
          onSuccess?.();
        } else {
          toast.error(result.error);
        }
      });
    },
    [],
  );
  return { pending, run };
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

function ConfirmRemove({
  title,
  description,
  onConfirm,
  disabled,
  label,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={label}
          title={label}
          style={{ color: "var(--error-text)" }}
        >
          <IconTrash size={14} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Team member row ──────────────────────────────────────────────────────────

function TeamMember({ user, isSelf }: { user: UserRow; isSelf: boolean }) {
  const { pending, run } = useAction();
  const name = userDisplayName(user);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-3) 0",
      }}
    >
      <Avatar style={{ width: 36, height: 36 }}>
        {user.image && <AvatarImage src={user.image} alt="" />}
        <AvatarFallback
          style={{ fontSize: 12, background: "var(--bg-raised)", color: "var(--glacier-300)" }}
        >
          {userInitials(user)}
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
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-mono)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {user.email ?? "no email"} · joined {new Date(user.createdAt).toLocaleDateString()}
        </div>
      </div>
      <RoleSelect
        aria-label={`Role for ${name}`}
        value={user.role}
        disabled={pending}
        onChange={(role) =>
          run(
            () => changeUserRole(user.id, role),
            `${name} is now ${roleLabel[role].toLowerCase()}`,
          )
        }
      />
      <ConfirmRemove
        label={`Remove ${name}`}
        disabled={pending || isSelf}
        title={`Remove ${name}?`}
        description="They are signed out and lose access. Their email is removed from the allowlist; if their domain is allowed they can still sign in again as a member."
        onConfirm={() => run(() => removeUser(user.id), `Removed ${name}`)}
      />
    </div>
  );
}

// ── Allowlist ────────────────────────────────────────────────────────────────

function AllowEmailForm() {
  const { pending, run } = useAction();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    run(
      () => allowEmail(value, role),
      `${value} can now sign in`,
      () => {
        setEmail("");
        setRole("member");
      },
    );
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: "var(--space-2)" }}>
      <Input
        type="email"
        required
        placeholder="name@example.com"
        aria-label="Email to allow"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ flex: 1 }}
      />
      <RoleSelect aria-label="Role on first sign-in" value={role} onChange={setRole} />
      <Button type="submit" variant="primary" disabled={pending || !email.trim()}>
        <IconUserPlus size={14} />
        Add
      </Button>
    </form>
  );
}

function AllowedEmail({ entry }: { entry: AllowedEmailRow }) {
  const { pending, run } = useAction();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-3) var(--space-4)",
        background: "var(--bg-raised)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <IconMail size={14} style={{ color: "var(--glacier-500)", flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {entry.email}
      </div>
      <Badge variant={entry.signedUp ? "success" : "neutral"}>
        {entry.signedUp ? "Signed up" : "Pending"}
      </Badge>
      <Badge variant="outline">{roleLabel[entry.role]}</Badge>
      <ConfirmRemove
        label={`Remove ${entry.email} from the allowlist`}
        disabled={pending}
        title={`Remove ${entry.email} from the allowlist?`}
        description="They can no longer sign in unless their email domain is allowed. An existing account is kept; remove the user to revoke access."
        onConfirm={() => run(() => disallowEmail(entry.email), `Removed ${entry.email}`)}
      />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UsersView({ currentUserId, allowedDomains, users, allowedEmails }: UsersViewProps) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Admin" }, { label: "Users" }]} />
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
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>Users</h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Manage who can sign in and what they can do. Admins manage repositories, agents and
            users; members have read access.
          </Muted>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Team members</CardTitle>
            <CardDescription>Everyone who has signed in to this control panel.</CardDescription>
          </CardHeader>
          <CardContent>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {users.map((user, i) => (
                <React.Fragment key={user.id}>
                  <TeamMember user={user} isSelf={user.id === currentUserId} />
                  {i < users.length - 1 && <Separator />}
                </React.Fragment>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Allowed emails</CardTitle>
            <CardDescription>
              {allowedDomains.length > 0 ? (
                <>
                  Anyone with an email at{" "}
                  {allowedDomains.map((domain, i) => (
                    <React.Fragment key={domain}>
                      {i > 0 && ", "}
                      <InlineCode>{domain}</InlineCode>
                    </React.Fragment>
                  ))}{" "}
                  can sign in. Add other people by email; they get the chosen role on first sign-in.
                </>
              ) : (
                <>
                  No email domains are allowed (<InlineCode>ALLOWED_EMAIL_DOMAINS</InlineCode> is
                  empty), so only the emails below can sign in. They get the chosen role on first
                  sign-in.
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <AllowEmailForm />
            {allowedEmails.map((entry) => (
              <AllowedEmail key={entry.email} entry={entry} />
            ))}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
