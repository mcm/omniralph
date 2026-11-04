import { z } from "zod";
import { isoDate } from "./schemas";

/**
 * Personal API tokens (`/api/ui/api-tokens/**`, You › API tokens): the signed-in member's own
 * tokens for the active organization. Safe to import in the browser.
 */

export const API_TOKEN_NAME_MAX_LENGTH = 80;

export const apiTokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The token's first characters, e.g. `omr_Ab3x`. */
  prefix: z.string(),
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
});
export type ApiTokenRow = z.infer<typeof apiTokenSchema>;

export const apiTokenListSchema = z.object({ tokens: z.array(apiTokenSchema) });
export type ApiTokenList = z.infer<typeof apiTokenListSchema>;

/** `POST /api/ui/api-tokens`. */
export const createApiTokenBodySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Name the token.")
    .max(API_TOKEN_NAME_MAX_LENGTH, `Keep the name under ${API_TOKEN_NAME_MAX_LENGTH} characters.`),
});
export type CreateApiTokenBody = z.infer<typeof createApiTokenBodySchema>;

/** The new token: `token` is in this response only, never shown again. */
export const createdApiTokenSchema = z.object({ apiToken: apiTokenSchema, token: z.string() });
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>;
