<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Writing tests

Test this project's own behavior. Don't write tests that:

- **Test migrations.** There is one deployment, so a migration runs once and is done. The db
  test setup applies every migration to build its template database, which is enough.
- **Test someone else's code.** When our code only passes through to a library, don't test
  what the library does: Radix keyboard navigation or Escape closing a dialog, Postgres
  enforcing a constraint or a one-line query, jose rejecting a bad signature. Test the
  decisions our code makes around it.
- **Assert a mock was called when the code just forwards to it.** "Mock `setX`, call our
  function, expect `setX` was called with the same arguments" restates the implementation.
  Asserting a call is fine when our code decides whether it happens, how often, or computes
  its arguments.
- **Read source or CSS files as text.** Don't regex a stylesheet for property values or grep
  the source for imports and patterns. A rule worth enforcing belongs in the linter.
- **Echo static values.** Don't compare a constant or a static definition to a copy of its
  own literal, or rely on a snapshot alone with no stated expectation.
