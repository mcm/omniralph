# ADR 0002: Agent and code-host authentication

- **Status:** Accepted (GitHub App JWTs, US-004). Agent identity and token lifecycle are added by US-017.
- **Date:** 2026-10-04

## Context

The control panel is the only integration point: it holds the GitHub App and
GitLab credentials, performs every code-host write and brokers short-lived,
scoped credentials to agents. Long-lived signing keys should not sit in
environment variables where Vercel KMS can hold them instead.

## Decision: GitHub App JWTs

The GitHub App authenticates with an RS256 JWT (`iss` = app ID) that it
exchanges for installation tokens. `packages/scm` gets JWTs from an
`AppJwtSigner` interface (`src/github/app-jwt.ts`) with two implementations:

| Signer | Key | Used when |
| -- | -- | -- |
| `KmsAppJwtSigner` | The GitHub App private key imported into an **external-origin** Vercel KMS issuer. Calls `signJWT({ issuerId, claims: { iss: appId }, ttl: 540 })` from `@vercel/kms` (authenticated with the function's Vercel OIDC token). | `GITHUB_APP_KMS_ISSUER_ID` is set |
| `PemAppJwtSigner` | `GITHUB_APP_PRIVATE_KEY` (PKCS#1 or PKCS#8 PEM), signed locally with `jose`; `iat` is backdated 60s. | Local dev, tests, and as a fallback |

`createAppJwtSigner(env)` picks KMS when the issuer ID is set, otherwise the PEM.
The TTL is 540s (GitHub's maximum is 600s), leaving headroom for clock drift.

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
  and updating `GITHUB_APP_KMS_ISSUER_ID`.
