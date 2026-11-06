---
"@omniralph/agent": patch
---

The agent notices an expired Claude sign-in, and its page can sign Claude in again. The check used to say "Signed in" whenever `~/.claude.json` still named the account, even after a failed refresh made `claude` clear its tokens (`expiresAt: 0` and empty tokens in `.credentials.json`): it now reads the stored tokens after the SDK read and reports such a login as `signed_out`, which the page shows as **Sign-in expired** with the reason. **Refresh sign-in…** on the Claude page runs `claude`'s own manual OAuth flow (PKCE, opening Claude's sign-in in a new tab, then pasting the code it shows; the token exchange may take up to 2 minutes). It writes the tokens to `.credentials.json` and the account to `~/.claude.json`, keeps every other key in both files, checks again at once and heartbeats. It doesn't run on macOS (keychain) or while `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set, and says why.
