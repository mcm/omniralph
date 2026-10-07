import type { Metadata } from "next";
import { listMembers } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { UsersView } from "./users-view";

export const metadata: Metadata = { title: "Users · Omniralph" };

export default async function UsersPage() {
  const admin = await requirePageUser("admin");
  const members = await listMembers(getDb(), admin.organization.id);

  return (
    <UsersView
      currentUserId={admin.id}
      organizationName={admin.organization.name}
      users={members.map((m) => ({
        id: m.userId,
        name: m.name,
        email: m.email,
        image: m.image,
        role: m.role,
        createdAt: m.createdAt.toISOString(),
      }))}
    />
  );
}
