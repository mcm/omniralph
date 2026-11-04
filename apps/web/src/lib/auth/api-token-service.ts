import "server-only";
import {
  createApiToken as createApiTokenRow,
  listApiTokens,
  MAX_ACTIVE_API_TOKENS,
  revokeApiToken as revokeApiTokenRow,
  type ApiToken,
  type Database,
} from "@omniralph/db";
import type {
  ApiTokenList,
  ApiTokenRow,
  CreateApiTokenBody,
  CreatedApiToken,
} from "@/lib/api/api-tokens";
import { ApiRouteError } from "@/lib/api/handler";
import { generateApiToken } from "./api-tokens";
import type { OrgUser } from "./session";

/**
 * You › API tokens: what `/api/ui/api-tokens/**` lists, creates and revokes. Every member
 * manages only their own tokens for the active organization.
 */

export const API_TOKEN_LIMIT_MESSAGE = `You have ${MAX_ACTIVE_API_TOKENS} tokens. Revoke one you no longer use first.`;
export const API_TOKEN_NOT_FOUND_MESSAGE = "That token doesn't exist or was already revoked.";

function tokenRow(token: ApiToken): ApiTokenRow {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}

const member = (user: OrgUser) => ({ organizationId: user.organization.id, userId: user.id });

export async function loadApiTokens(db: Database, user: OrgUser): Promise<ApiTokenList> {
  return { tokens: (await listApiTokens(db, member(user))).map(tokenRow) };
}

/** Creates a token; the response is the only place its value appears. */
export async function createApiToken(
  db: Database,
  user: OrgUser,
  body: CreateApiTokenBody,
): Promise<CreatedApiToken> {
  const { token, tokenHash, prefix } = generateApiToken();
  const result = await createApiTokenRow(db, {
    ...member(user),
    name: body.name,
    tokenHash,
    prefix,
  });
  if (result.status !== "created") {
    throw result.status === "limit"
      ? new ApiRouteError(400, API_TOKEN_LIMIT_MESSAGE, "api_token_limit")
      : new ApiRouteError(403, "You aren't a member.", "forbidden");
  }
  return { apiToken: tokenRow(result.token), token };
}

/** Revokes one of the user's own tokens; 404 for any other. */
export async function revokeApiToken(
  db: Database,
  user: OrgUser,
  id: string,
): Promise<{ ok: true }> {
  const revoked = await revokeApiTokenRow(db, { ...member(user), id });
  if (!revoked) throw ApiRouteError.notFound(API_TOKEN_NOT_FOUND_MESSAGE);
  return { ok: true };
}
