# Omniralph

Self-hosted AI code review for GitHub and GitLab, plus the shared foundation for the cyralph agent.

- **Control panel** (`apps/web`): Next.js 16 on Vercel. The single integration point: holds code-host
  credentials, receives webhooks, owns job state and brokers short-lived credentials to agents.
- **Agent host** (`apps/agent`, `omniralph-agent`): a Node 22 daemon on Coder instances that pulls
  jobs through the control panel and runs capabilities (v1: code review via the Claude Agent SDK).

## Layout

| Path              | Package                           | Purpose                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| `apps/web`        | `@omniralph/web`                  | Control panel UI, agent API, queue proxy, webhooks           |
| `apps/agent`      | `@iamthemcmaster/omniralph-agent` | Agent daemon (`bin: omniralph-agent`)                        |
| `packages/engine` | `@omniralph/engine`               | Review core: diff parsing, budgets, prompts, Claude provider |
| `packages/scm`    | `@omniralph/scm`                  | SCM adapter interface + GitHub and GitLab implementations    |
| `packages/db`     | `@omniralph/db`                   | Drizzle schema, migrations, typed queries                    |
| `packages/shared` | `@omniralph/shared`               | zod schemas and shared types                                 |

## Development

Requires Node 22 and pnpm 10 (`corepack enable`). `@iamthemcmaster/ui` is a private npm package:
your `~/.npmrc` must be authenticated. Don't commit an `.npmrc` containing a token.

```bash
pnpm install
pnpm dev        # all dev servers
pnpm typecheck  # quality gates: typecheck, lint, test
pnpm lint
pnpm test
pnpm build
```

Workspace packages export their TypeScript source under the `@omniralph/source` export condition
(used by `tsc`, Vitest and `tsx`), and compiled `dist/` output for everything else (`node`, Next.js).
`turbo` builds dependencies first for `build` and `dev`.
