# ADR 0002: Harness and code-host authentication

- **Status:** Accepted (GitHub App JWTs, US-004; harness identity and token lifecycle, US-017; job token kinds, [ADR 0008](0008-agents-tasks-and-the-harness.md))
- **Date:** 2026-10-04

## Context

The control panel is the only integration point: it holds the GitHub App and
GitLab credentials, performs every code-host write and brokers short-lived,
scoped credentials to harnesses. Long-lived signing keys should not sit in
environment variables where Vercel KMS can hold them instead.

## Decision: GitHub App JWTs

The GitHub App authenticates with an RS256 JWT (`iss` = app ID) that it
exchanges for installation tokens. `packages/scm` gets JWTs from an
`AppJwtSigner` interface (`src/github/app-jwt.ts`) with two implementations:

| Signer            | Key                                                                                                                                                                                                                                                                                                                                                 | Used when                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `KmsAppJwtSigner` | The GitHub App private key imported into an **external-origin**, **RS256** Vercel KMS issuer (see _KMS issuer setup_ below). Calls `signJWT({ issuerId, claims: { iss: appId, iat: now - 60, exp: now + 540 }, ttl: 540 })` from `@vercel/kms` (authenticated with the function's Vercel OIDC token), then decodes and checks the token before use. | `GITHUB_APP_KMS_ISSUER_ID` is set   |
| `PemAppJwtSigner` | `GITHUB_APP_PRIVATE_KEY` (PKCS#1 or PKCS#8 PEM), signed locally with `jose`; `iat` is backdated 60s.                                                                                                                                                                                                                                                | Local dev, tests, and as a fallback |

`createAppJwtSigner(env)` picks KMS when the issuer ID is set, otherwise the PEM.
The TTL is 540s (GitHub's maximum is 600s), leaving headroom for clock drift.

### KMS issuer setup

GitHub only accepts **RS256** app JWTs, but Vercel KMS issuers default to
**RS512**, and an issuer's algorithm can't be changed after it's created. Import
the App's private key (downloaded from the App's settings) into a new issuer
with the algorithm set explicitly, then grant the project the environments that
use it:

```sh
vercel kms import omniralph-github-app-<env> --key ./app.private-key.pem --algorithm RS256
vercel kms add-grant <issuerId>   # project omniralph, environment(s) that set GITHUB_APP_KMS_ISSUER_ID
```

Set `GITHUB_APP_KMS_ISSUER_ID` to the issuer ID and `GITHUB_APP_ID` to the App ID
(GitHub also accepts the `Iv…` Client ID as `iss`). `vercel kms inspect <issuerId>`
must show `"algorithm": "RS256"` and `"origin": "external"`.

KMS sets `iat`/`nbf`/`exp` itself; the signer also sends `iat` backdated 60s
and `exp` = now + 540s (and retries with `iss` alone if KMS rejects caller-set
registered claims). Every KMS token is decoded and rejected with a
`KmsAppJwtError` naming the fix if its algorithm isn't RS256, its `iss` isn't
the App ID, or it would be valid for more than 600s, instead of surfacing as an
opaque 401 from GitHub.

TOOL-50 (2026-10-05): during the TOOL-49 smoke test the installation callback
failed with KMS and worked with the PEM. `vercel kms inspect` showed the
preview's GitHub App issuer was external-origin but **RS512** (the CLI's
`--algorithm` was required for the RSA key and RS512 was chosen, matching the
KMS default). Signing with the preview issuer from outside a preview deployment
isn't possible (a development OIDC token gets 403 `oidc_token_not_authorized`),
so GitHub's exact response to that token wasn't captured.

### Installation tokens: direct exchange instead of `@octokit/auth-app`

`@octokit/auth-app` signs app JWTs itself from a `privateKey` and has no way to
accept an externally signed JWT, so it can't be used with KMS. Instead
`GitHubAppAuth` (`src/github/app-auth.ts`) calls
`POST /app/installations/{id}/access_tokens` through `@octokit/rest` with
`Authorization: Bearer <app JWT>`, passing `repositories` and `permissions` when
the token must be scoped. The same path is used for both signers, so local dev
exercises the production code path.

- App JWTs are cached until 60s before they expire (one KMS call per ~8 minutes).
- Installation tokens are cached per (installation, repositories, permissions)
  until 5 minutes before GitHub's `expires_at` (tokens last 1 hour). Concurrent
  requests share one in-flight exchange; failures aren't cached.
- The installation for a repository comes from the connection
  (`scm_connections.external_id`) or is looked up with
  `GET /repos/{owner}/{repo}/installation`.
- Brokered clone credentials (`getReadOnlyCloneCredential`) are installation
  tokens limited to `contents: read` on the single repository
  (`repositories: [name]`), used with username `x-access-token`. They expire in
  at most 1 hour.

### Consequences

- With KMS configured, the GitHub App private key exists only inside KMS; a
  leaked Vercel env dump doesn't expose it.
- Each JWT signature is a network call to KMS, mitigated by JWT caching.
- Rotating the GitHub App key means importing the new key into a new KMS issuer
  (again with `--algorithm RS256`) and updating `GITHUB_APP_KMS_ISSUER_ID`.

## Decision: harness identity and token lifecycle

Harnesses (hosts running `omniralph-harness`; called "agents" until
[ADR 0008](0008-agents-tasks-and-the-harness.md); this file keeps its old name)
only make outbound calls to the control panel and must not hold long-lived
code-host or Vercel credentials. Their identity is:

- **Enrollment.** An admin creates a one-time enrollment token (256-bit
  random, valid 1 hour, single use, stored as a SHA-256 hash).
  `POST /api/harness/enroll` consumes it, creates the harness and returns
  `{ harnessId, refreshToken }`.
- **Refresh tokens.** RS256 JWTs signed like access tokens (since TOOL-856; see
  _Write-free token refresh_ below): `typ: "refresh"`, `sub: harnessId`, a
  generation `gen` and a random ID `jti`, valid 90 days. The harness keeps its
  token in a 0600 file (`~/.config/omniralph/harness.json`).
  `POST /api/harness/token` replaces the presented token with the next generation
  plus an access token (rotation on every refresh). Opaque tokens from before
  (`orr_`, hashed in `harness_refresh_tokens`) are redeemed once for a signed one.
- **Reuse detection.** Presenting an already-used refresh token (an older
  generation, or the current generation with another random ID) means two
  parties hold the chain (theft or a cloned host): **the harness** is revoked
  (`harnesses.revoked_at`), a `refresh_reuse` audit row is written, and the
  harness has to re-enroll. The comparison is atomic (a Redis script, or a
  transaction with the harness row locked), so concurrent presentations resolve
  to one rotation and one reuse.
- **Access and job tokens.** **RS256** JWTs signed by
  **Vercel KMS** (`signJWT`, issuer `KMS_AGENT_ISSUER_ID`, one issuer per Vercel
  environment), so no signing key ever sits in an env var. Access tokens last
  900s (`AGENT_ACCESS_TOKEN_TTL_SECONDS`; see _Write-free token refresh_ below),
  job tokens 900s (`JOB_TOKEN_TTL_SECONDS`). Both carry
  `aud: "omniralph-harness"`; tokens with the audience from before the
  rename are rejected. Access tokens: `typ: "harness"`, `sub: harnessId`. Job tokens
  (issued when a job is claimed and renewed by the heartbeat): `typ: "job"`,
  `sub: jobId`, `harnessId`, `scopes` and, for run-spec jobs, a `kind`:

  | Token              | Jobs                                         | Held by                                                                                                                                   | Scopes                                                                                          |
  | ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
  | `lifecycle`        | run-spec jobs (with a `task_id`)             | the harness's own git calls (syncing and checking out the repository)                                                                     | `credentials:read`; `coding` runs add `credentials:write`                                       |
  | `session`          | run-spec jobs                                | the Claude session: its env (`OMNIRALPH_JOB_TOKEN`, `OMNIRALPH_JOB_TOKEN_FILE`), its git credential helper and the `omniralph` MCP server | `credentials:read`, `run:activity`, `run:attachments`, `linear:read`; never `credentials:write` |
  | no `kind` (legacy) | `repo.sync` and other system RPCs            | everything in the job                                                                                                                     | `credentials:read`                                                                              |
  | no `kind` (legacy) | `ralph.*` (until the coding epic ports them) | everything in the job                                                                                                                     | `credentials:read`, `credentials:write`, `run:activity`, `run:attachments`                      |

  The credential broker hands out a push credential only for
  `credentials:write` on the `lifecycle` token of a `coding` run-spec job or the
  single token of a legacy `ralph.*` job; a `session` token is read-only
  whatever scopes it claims. Processes inside a job (the `git-credential`
  helper) only see a job token, never the harness's tokens. `LocalTokenSigner`
  (`jose`, `LOCAL_AGENT_SIGNING_KEY` or an in-memory key) exists for local dev
  and tests and refuses to run with `VERCEL_ENV=production`.

- **Verification.** `requireAgent`/`requireJob` (`apps/web/src/lib/agent-auth/verify.ts`)
  check the signature (RS256 only), `aud`, `typ` and `exp` with `jose` against
  the issuer's cached JWKS (`https://kms.vercel.com/<issuer>/jwks.json`), then
  **check the database** that the harness isn't revoked (and, for job tokens,
  that the job is `running` on that harness and the scope matches). Revocation
  (`revokeHarness`) therefore takes effect on the next request, not when the
  token expires.
- **No HS\* keys.** Tokens are never signed with a shared HMAC secret: a
  verifier holding the secret could mint tokens, and the secret would have to
  live in an env var. Only RS256 is accepted, so `alg` confusion attacks don't
  apply.
- **Rate limits and audit.** Fixed windows in Postgres (`rate_limits`, or Redis
  when `REDIS_URL` is set):
  `/enroll` 10/min per IP; `/token` 30/min per harness and 60/min per IP; 20
  failed auth attempts from one IP within 10 minutes lock that IP out of the
  harness API (429) for 10 minutes. `harness_audit` records enroll, token
  refresh, refresh reuse, revoke, credential issuance, results and auth
  failures (sampled to one per harness per minute).

### Access-token lifetime (TOOL-276, superseded by TOOL-856)

Access tokens were 900s, like job tokens, so each agent refreshed about every 12
minutes (at 80% of `expiresIn`): about 840 refreshes a day for 6 agents, each one
rotating the refresh token and writing a `token_refresh` audit row in Postgres. That
alone kept the Neon compute awake about 68% of the day. Access tokens now last a day
(86,400s), so an agent refreshes about once a day (every ~19 hours). Job tokens keep
900s and their renewal by the heartbeat; refresh-token rotation, reuse detection and
the `token_refresh` audit row are unchanged and stay in Postgres.

- **Revocation stays immediate.** Every request checks the agent's auth state
  (`readAgentAuthState`: Redis, which revocation writes after its commit, falling
  back to Postgres with hot state off or untrusted), so a revoked agent's access
  token is rejected on its next request whatever its expiry. The cached auth state
  lives a day ([ADR 0007](0007-redis-hot-state.md)).
- **The trade-off.** A stolen access token stays usable for up to 24 hours unless
  the agent is revoked, instead of 15 minutes. A stolen refresh token is detected
  (reuse) at the next refresh by either holder, up to about 19 hours later instead
  of about 12 minutes.
- **KMS.** Vercel's KMS docs and `@vercel/kms` document a default `ttl` of 300s and
  no maximum. In case KMS signs for less than asked, `/api/agent/token` reports
  `expiresIn` from the signed token's own `exp - iat` (capped at a day), so the
  agent still refreshes in time.

### Write-free token refresh (TOOL-856)

Access tokens are back to 900s: the agent refreshes at 80% of `expiresIn`, about
every 12 minutes, with no agent change. What made that expensive (a refresh-token
rotation and a `token_refresh` audit row in Postgres per refresh) moved to Redis
([ADR 0007](0007-redis-hot-state.md), _Write-free token refresh_):

- **Signed refresh tokens.** The token carries the agent ID, a generation and a
  random ID. Redis holds each agent's current generation and the hash of its
  random ID (hot state, rebuilt from `agents.refresh_generation`). The same
  generation and random ID rotates; an older generation, or the same generation
  with another random ID, is reuse and revokes the agent, as before.
- **A newer generation than Redis knows** is possible only after Redis lost state
  (it was rebuilt from Postgres, which the daily flush updates). It's accepted once
  and Redis catches up. The random-ID check means an attacker and the real agent
  can't both keep refreshing afterwards: whichever presents the shared token second
  is behind, and the agent is revoked.
- **Audit.** `token_refresh` rows are buffered in Redis and written by the
  `flush-agent-auth` cron in the daily window (03:15 UTC), about 120 per agent per
  day; rows buffered since the last window are lost if Redis loses its state.
- **Fallback.** With Redis down, refresh rotates and audits in Postgres, with the
  same comparison.
- **Why.** The access token is presented on every request, so it's the credential
  most likely to leak, and until someone notices, its lifetime is the only limit.
  Rotation with reuse detection notices a stolen refresh token without a person,
  and only quickly when refreshes are frequent. Short lifetimes plus rotation is
  the strong combination; its remaining weakness (reuse detection right after
  Redis loses state, above) is much narrower than a 24 h access token.
- **Signing.** Refresh tokens are RS256 like every other token (no HS\* keys), so
  each refresh costs two KMS signatures. A signed token is about 700 characters;
  `TokenRequest` accepts up to 4,096.

### Consequences

- A leaked job token or access token is usable for at most 15 minutes; both are cut off immediately by revoking the harness. A
  leaked refresh token is detected the next time either holder refreshes.
- A Claude session can never push, even for coding runs: only the harness's
  `lifecycle` token can, and the session never sees it.
- Every authenticated harness request costs one indexed database lookup.
- Each refresh costs two KMS signatures (access and refresh token); harnesses
  refresh about every 12 minutes.
- A harness that crashes between the control panel rotating its token and
  persisting the new one will present the old token and be revoked; it must
  re-enroll. The harness writes the new token atomically before using it.
