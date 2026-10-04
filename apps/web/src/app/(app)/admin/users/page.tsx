import type { Metadata } from "next";
import { listAllowedEmails, listUsers } from "@omniralph/db";
import { parseAllowedDomains } from "@/lib/auth/allowlist";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { UsersView } from "./users-view";

export const metadata: Metadata = { title: "Users · Omniralph" };

export default async function UsersPage() {
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [users, allowed] = await Promise.all([listUsers(db), listAllowedEmails(db)]);
  const userEmails = new Set(users.map((u) => u.email?.toLowerCase()));

  return (
    <UsersView
      currentUserId={admin.id}
      allowedDomains={parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS)}
      users={users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        image: u.image,
        role: u.role,
        createdAt: u.createdAt.toISOString(),
      }))}
      allowedEmails={allowed.map((a) => ({
        email: a.email,
        role: a.role,
        signedUp: userEmails.has(a.email),
      }))}
    />
  );
}
