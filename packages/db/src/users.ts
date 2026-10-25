/**
 * Typed queries for control panel users. Roles are per organization
 * (see `organizations.ts`); users have none of their own.
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { users } from "./schema.js";

/** Control panel color theme; a user's `null` theme follows the OS preference. */
export type UiTheme = NonNullable<(typeof users.$inferSelect)["theme"]>;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** Emails are compared case-insensitively; they are stored lower-cased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Inserts a user with a lower-cased email. New users belong to no organization:
 * they create one, accept an invitation or join one on the onboarding page.
 */
export async function createUser(db: Database, data: NewUser): Promise<User> {
  const email = data.email ? normalizeEmail(data.email) : null;
  const [user] = await db
    .insert(users)
    .values({ ...data, email })
    .returning();
  if (!user) throw new Error("Failed to create user");
  return user;
}

export async function listUsers(db: Database): Promise<User[]> {
  return db.select().from(users).orderBy(asc(users.createdAt));
}

export async function getUserById(db: Database, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  return user;
}

/** Remembers the user's control panel theme; `null` follows the OS (System). */
export async function setUserTheme(db: Database, id: string, theme: UiTheme | null): Promise<void> {
  await db.update(users).set({ theme }).where(eq(users.id, id));
}

/** Deletes a user; their accounts, sessions and memberships cascade. */
export async function deleteUser(db: Database, id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}
