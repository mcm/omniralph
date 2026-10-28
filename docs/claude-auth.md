# Claude authentication

Agents run Claude through `@anthropic-ai/claude-agent-sdk`, which runs Claude Code underneath and
authenticates exactly like Claude Code does on that host. The control panel never calls Claude and
holds no Claude credentials.

## Default: the host's `claude` login

Log in once as the user the agent runs as (see *Choose the agent's user* in
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
Log in again as the agent's user; no restart is needed.

## Env-var overrides

Set one of these in the agent's environment (the systemd unit's `EnvironmentFile`, or the shell
you start tmux or pm2 from) to override the login. pm2 only picks up a change with
`pm2 restart omniralph-agent --update-env`. A set but invalid value **wins over** a working login,
so remove stale ones.

| Variable | What it is |
| -- | -- |
| `ANTHROPIC_API_KEY` | An Anthropic Console API key. Billed per token to the Console organization, with that organization's rate limits. Always supported. |
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
