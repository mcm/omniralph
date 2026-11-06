# Claude authentication

Agents run Claude through `@anthropic-ai/claude-agent-sdk`, which runs Claude Code underneath and
authenticates exactly like Claude Code does on that host. The control panel never calls Claude and
holds no Claude credentials.

## Default: the host's `claude` login

Log in once as the user the agent runs as (see _Choose the agent's user_ in
[deploy-agent.md](deploy-agent.md#1-choose-the-agents-user)). On a Coder workspace that's usually
the workspace user, so if you already use `claude` there, the agent uses that login and nothing
else is needed. Otherwise, as the agent's user (e.g. after `sudo -iu omniralph` for a dedicated
user):

```sh
claude                      # follow the login prompt, then /exit
claude -p "say ok"          # check it works non-interactively
```

The login lives in that user's home (`~/.claude/`, `~/.claude.json`), so each Unix user has its own.
An agent running as your user shares your login, and with it your subscription's rate limits (see
[Shared rate limits](#shared-rate-limits)).
Review sessions run with `settingSources: []`: they use the login but never load `~/.claude`
settings, skills, MCP servers or `CLAUDE.md` files. Coding sessions (stories and requests) do load
them (`settingSources: ["user", "project", "local"]`), so skills installed in the agent user's
`~/.claude/skills/` are available to them.

If the login is missing or expired, reviews fail with "Log in once on this host with `claude` …".
Sign in again with **Refresh sign-in…** on the agent's page (see
[Refresh sign-in](#refresh-sign-in)), or log in again as the agent's user with `claude`. Either
way, no restart is needed.

## How the agent checks its login

At startup, then hourly, the agent opens an idle Claude session (no prompt, no tools) and reads
the account (`accountInfo()`) and the models it can run (`supportedModels()`). Every heartbeat
reports the models and the login state:

- **status**: `signed_in`; `signed_out` when the check fails with an authentication error, the
  login reports no models, or the `claude` login's stored tokens can't work (see below); `unknown`
  when the check times out (after a minute) or fails otherwise.
- **source**: `login` (the `claude` login), `api_key` (`ANTHROPIC_API_KEY`), `oauth_token`
  (`CLAUDE_CODE_OAUTH_TOKEN`) or `other` (a third-party provider such as Bedrock or Vertex).

The SDK names the account from `~/.claude.json` and lists models without calling Anthropic, so
with the `claude` login the agent also reads its stored tokens (`claudeAiOauth` in
`$CLAUDE_CONFIG_DIR/.credentials.json`, by default `~/.claude/.credentials.json`). When a refresh
fails for good, `claude` clears them (`expiresAt: 0`, empty tokens) but keeps the account. The
agent reports that login as `signed_out`, and its page says **Sign-in expired**. It does the same
when the refresh token has expired, or the access token has expired with no refresh token. An
expired access token with a refresh token still counts as signed in, because `claude` refreshes it
on use. On macOS the tokens are in the keychain, so this check doesn't run.

The account's email, organization and subscription stay on the machine: the control panel only
learns the status and source, and shows them on Fleet.

The agent's own page ([**Claude**](deploy-agent.md#the-agent-page)) shows all of it, with the
account, and says which OS user to sign in as when nobody is. **Check again** there checks at once
after you sign in, instead of waiting for the hourly check.

## Refresh sign-in

**Refresh sign-in…** on the agent's page (**Claude**) signs the `claude` login in again without a
shell on the machine. It runs the same manual OAuth flow as `claude`'s login (PKCE with Claude
Code's public client ID):

1. The page opens Claude's sign-in in a new tab. Sign in with the account the agent should use,
   and Claude shows a code.
2. Paste the code into the page and save. The agent exchanges it at
   `platform.claude.com/v1/oauth/token`, which can take up to 2 minutes. It then writes the tokens
   to `.credentials.json` (mode 0600, keeping its other keys, e.g. MCP logins) and updates
   `oauthAccount` in `~/.claude.json`, leaving the rest of that file alone. Finally it checks Claude
   again and reports to the control panel.

A sign-in must be completed within 15 minutes, and each code works once. Starting again replaces
the previous sign-in. It isn't available on macOS, where `claude` keeps its tokens in the keychain,
or while `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set: those win over a sign-in, so
remove them first. The tokens are written for the OS user the agent runs as, so `claude` sessions
of that user use the new sign-in too.

## Env-var overrides

Set one of these in the agent's environment (the systemd unit's `EnvironmentFile`, or the shell
you start tmux or pm2 from) to override the login. pm2 only picks up a change with
`pm2 restart omniralph-agent --update-env`. A set but invalid value **wins over** a working login,
so remove stale ones.

| Variable                  | What it is                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | An Anthropic Console API key. Billed per token to the Console organization, with that organization's rate limits. Always supported.                                              |
| `CLAUDE_CODE_OAUTH_TOKEN` | A long-lived OAuth token for a Claude subscription, created with `claude setup-token`. Useful where an interactive login is awkward (e.g. a fresh host provisioned by a script). |

Keep them out of world-readable files: put them in an `EnvironmentFile` with mode 0600 owned by
root (systemd reads it before dropping privileges).

## Shared rate limits

All Claude Code sessions using the same subscription share its rate limits: the agent's reviews,
cyralph runs and your interactive `claude` sessions on any host logged in to that account. A busy
agent can slow your own sessions down, and the other way round.

When Claude reports a rate or usage limit, the agent doesn't fail the job. It reports a retryable
failure with the reset time (5 minutes if unknown), the job goes back to `queued`, and the queue
redelivers it after that delay. A job gives up after its 3rd delivery. To keep reviews and
interactive work apart:

- lower Slots on the agent's page (`maxConcurrency` in its
  [`settings.json`](deploy-agent.md#machine-settings-settingsjson); it applies at once, no restart),
- use a cheaper review depth (Quick) on busy repositories, or
- give the agent its own credentials: an `ANTHROPIC_API_KEY` in its environment, or a separate
  subscription's `claude` login for a dedicated agent user.

## Check the terms first

Anthropic's terms restrict using consumer-subscription (Claude Pro/Max) authentication to power
third-party products. Omniralph is an internal, self-run tool, which is a gray area. **Check
Anthropic's current terms before relying on subscription auth** (the `claude` login or
`CLAUDE_CODE_OAUTH_TOKEN`) for the agent. The `ANTHROPIC_API_KEY` path is always supported and
is the safe choice when in doubt.
