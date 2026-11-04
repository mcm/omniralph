import { apiHandler } from "@/lib/api/handler";
import {
  createApiTokenBodySchema,
  type ApiTokenList,
  type CreatedApiToken,
} from "@/lib/api/api-tokens";
import { createApiToken, loadApiTokens } from "@/lib/auth/api-token-service";
import { getDb } from "@/lib/db";

/** The signed-in member's active API tokens for the active organization, newest first. Session only. */
export const GET = apiHandler({}, async ({ user }): Promise<ApiTokenList> =>
  loadApiTokens(getDb(), user),
);

/**
 * Creates an API token (any member, for themselves): `{ name }`. The token is in this response
 * only. 400 `api_token_limit` at the cap. Session only: a token can't create tokens.
 */
export const POST = apiHandler(
  { body: createApiTokenBodySchema },
  async ({ user, body }): Promise<CreatedApiToken> => createApiToken(getDb(), user, body),
);
