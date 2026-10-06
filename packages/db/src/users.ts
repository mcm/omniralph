/**
 * Typed queries for control panel users, roles and the sign-in allowlist.
 */
import { asc, count, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { allowedEmails, users } from "./schema.js";

export type UserRole = (typeof users.$inferSelect)["role"];
/** Control panel color theme; a user's `null` theme follows the OS preference. */
export type UiTheme = NonNullable<(typeof users.$inferSelect)["theme"]>;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AllowedEmail = typeof allowedEmails.$inferSelect;

/** Emails are compared case-insensitively; they are stored lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Role for a newly created user: the very first user is `admin`, otherwise the allowlisted role. */
export function initialUserRole(input: {
  isFirstUser: boolean;
  allowlistedRole?: UserRole | null;
}): UserRole {
  if (input.isFirstUser) return "admin";
  return input.allowlistedRole ?? "member";
}

/**
 * Inserts a user, assigning `role` via {@link initialUserRole}. An advisory lock serializes
 * concurrent first sign-ins so exactly one user becomes the bootstrap admin.
 */
export async function createUserWithInitialRole(
  db: Database,
  data: Omit<NewUser, "role">,
): Promise<User> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('omniralph:create-user'))`);
    const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
    const email = data.email ? normalizeEmail(data.email) : null;
    const [allowlisted] = email
      ? await tx
          .select({ role: allowedEmails.role })
          .from(allowedEmails)
          .where(eq(allowedEmails.email, email))
      : [];
    const role = initialUserRole({ isFirstUser: !existing, allowlistedRole: allowlisted?.role });
    const [user] = await tx
      .insert(users)
      .values({ ...data, email, role })
      .returning();
    if (!user) throw new Error("Failed to create user");
    return user;
  });
}

export async function listUsers(db: Database): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.createdAt));
}

export async function getUserById(db: Database, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

export async function countAdmins(db: Database): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(eq(users.role, "admin"));
  return row?.n ?? 0;
}

export async function setUserRole(db: Database, id: string, role: UserRole): Promise<void> {
  await db.update(users).set({ role }).where(eq(users.id, id));
}

/** Remembers the user's control panel theme. */
export async function setUserTheme(db: Database, id: string, theme: UiTheme): Promise<void> {
  await db.update(users).set({ theme }).where(eq(users.id, id));
}

/** Deletes a user (their accounts and sessions cascade) and any allowlist entry for their email. */
export async function deleteUser(db: Database, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(users)
      .where(eq(users.id, id))
      .returning({ email: users.email });
    if (deleted?.email) {
      await tx.delete(allowedEmails).where(eq(allowedEmails.email, normalizeEmail(deleted.email)));
    }
  });
}

export async function listAllowedEmails(db: Database): Promise<AllowedEmail[]> {
  return db.select().from(allowedEmails).orderBy(asc(allowedEmails.email));
}

export async function isEmailAllowlisted(db: Database, email: string): Promise<boolean> {
  const [row] = await db
    .select({ email: allowedEmails.email })
    .from(allowedEmails)
    .where(eq(allowedEmails.email, normalizeEmail(email)));
  return row !== undefined;
}

/** Adds (or updates the role of) an allowlisted email. */
export async function addAllowedEmail(
  db: Database,
  input: { email: string; role: UserRole; addedBy: string | null },
): Promise<void> {
  const email = normalizeEmail(input.email);
  await db
    .insert(allowedEmails)
    .values({ email, role: input.role, addedBy: input.addedBy })
    .onConflictDoUpdate({ target: allowedEmails.email, set: { role: input.role } });
}

export async function deleteAllowedEmail(db: Database, email: string): Promise<void> {
  await db.delete(allowedEmails).where(eq(allowedEmails.email, normalizeEmail(email)));
}
