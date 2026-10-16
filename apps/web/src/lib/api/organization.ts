import { z } from "zod";
import { isoDate } from "./schemas";

/**
 * Settings › Organization and the organization switcher (`/api/ui/organization/**`,
 * `/api/ui/organizations/switch`) and Settings › Chat accounts (`/api/ui/chat-accounts/**`).
 */

const roleSchema = z.enum(["admin", "member"]);

export const memberRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  role: roleSchema,
  joinedAt: isoDate,
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const invitationRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  createdAt: isoDate,
  expiresAt: isoDate,
});
export type InvitationRow = z.infer<typeof invitationRowSchema>;

/** `GET /api/ui/organization`: the active organization's settings, as the caller may see them. */
export const organizationSettingsSchema = z.object({
  organization: z.object({ id: z.string(), name: z.string(), allowDomainJoin: z.boolean() }),
  isAdmin: z.boolean(),
  currentUserId: z.string(),
  domains: z.array(z.string()),
  members: z.array(memberRowSchema),
  /** Pending invitations; empty for members. */
  invitations: z.array(invitationRowSchema),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;

/** `PATCH /api/ui/organization`: a rename, or joining by email domain switched on or off. */
export const organizationChangeSchema = z.union([
  z.object({ name: z.string() }).strict(),
  z.object({ allowDomainJoin: z.boolean() }).strict(),
]);
export type OrganizationChange = z.infer<typeof organizationChangeSchema>;

export const invitationInputSchema = z.object({ email: z.string(), role: z.string() });
export type InvitationInput = z.infer<typeof invitationInputSchema>;

export const memberChangeSchema = z.object({ role: z.string() });

export const domainInputSchema = z.object({ domain: z.string() });

/** `POST /api/ui/organizations/switch`. */
export const switchOrganizationSchema = z.object({ organizationId: z.string() });

/** `GET /api/ui/chat-accounts`: the caller's linked chat accounts, in every organization. */
export const chatAccountSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  platform: z.enum(["slack", "discord"]),
  externalUserId: z.string(),
  displayName: z.string().nullable(),
  source: z.enum(["manual", "email"]),
  linkedAt: isoDate,
});
export type ChatAccount = z.infer<typeof chatAccountSchema>;
export const chatAccountsSchema = z.object({ identities: z.array(chatAccountSchema) });

/** `POST /api/ui/chat-accounts/unlink`. */
export const unlinkChatAccountSchema = z.object({
  organizationId: z.string(),
  platform: z.string(),
  externalUserId: z.string(),
});
export type UnlinkChatAccountInput = z.infer<typeof unlinkChatAccountSchema>;
