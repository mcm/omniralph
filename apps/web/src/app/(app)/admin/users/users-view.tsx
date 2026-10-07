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
  Muted,
  NativeSelect,
  Separator,
} from "@iamthemcmaster/ui";
import { IconTrash } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { isRole, type Role } from "@/lib/auth/roles";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { changeUserRole, removeUser } from "./actions";

export interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: Role;
  /** ISO timestamp. */
  createdAt: string;
}

interface UsersViewProps {
  currentUserId: string;
  organizationName: string;
  users: UserRow[];
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
          style={{ color: "var(--error)" }}
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
          {user.email ?? "no email"} · member since {new Date(user.createdAt).toLocaleDateString()}
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
        description="They lose access to this organization. Their account and other organizations are kept."
        onConfirm={() => run(() => removeUser(user.id), `Removed ${name}`)}
      />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function UsersView({ currentUserId, organizationName, users }: UsersViewProps) {
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
            Manage the members of {organizationName} and what they can do. Admins manage
            repositories, agents and members; members have read access.
          </Muted>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Team members</CardTitle>
            <CardDescription>Everyone who belongs to {organizationName}.</CardDescription>
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
      </main>
    </>
  );
}
