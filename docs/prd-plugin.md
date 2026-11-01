# The omniralph-prd plugin

`omniralph-prd` is the Claude plugin people use to plan work for Omniralph from a Claude
session (`/omniralph-prd new|triage|edit|ui-loop`). Its marketplace repo is
[`mcm/omniralph-prd`](https://github.com/mcm/omniralph-prd), but its files are generated
from this repo: don't edit them there, since the next publish overwrites them.

## Where the text comes from

- **Shared rules and templates** (the epic, story and fix formats, requirement wording,
  checkable criteria, sizing, splitting, the validation audit and the dependency rules) come
  from `packages/planning/src/methodology/rules.ts` and `templates.ts`. Omniralph's triage
  prompts render the same fragments, so planning in Claude and triage in Omniralph follow the
  same rules.
- **Plugin-only text** (the skill's entry point, the modes, lettered questions, drafting
  with the user, confirming before writing to Linear, the worked example) lives in
  `packages/planning/src/plugin/`: `skill.ts`, `common.ts` and `modes.ts`. `render.ts` puts
  the files together.

To change the plugin, change those files. `packages/planning/src/plugin/plugin.test.ts`
snapshots `SKILL.md` and `common.md` (`__snapshots__/`); update them with
`pnpm --filter @omniralph/planning exec vitest run -u` and review the diff.

## Building it

```sh
pnpm exec tsx scripts/build-prd-plugin.ts --out <dir>
```

writes the marketplace layout into `<dir>`:

- `.claude-plugin/marketplace.json`
- `plugins/omniralph-prd/.claude-plugin/plugin.json`
- `plugins/omniralph-prd/skills/omniralph-prd/SKILL.md`
- `plugins/omniralph-prd/skills/omniralph-prd/references/{common,mode-new,mode-triage,mode-edit,mode-ui-loop}.md`

It replaces `plugins/omniralph-prd/` whole and leaves other files in `<dir>` (a README, the
git history) alone. Every generated file starts with a notice that it is generated: an HTML
comment in Markdown, a YAML comment as the first line of `SKILL.md`'s frontmatter, and a
`$comment` field in the JSON manifests (which Claude Code ignores). The output is
deterministic, so an unchanged plugin builds byte for byte the same.

To try a build locally, point Claude Code at it: `claude plugin validate <dir>`, or add
`<dir>` as a marketplace with `/plugin marketplace add <dir>`.

## Publishing

`.github/workflows/publish-prd-plugin.yml` runs on every push to `main` (and by hand from the
Actions tab); it never runs on pull requests. It checks out `mcm/omniralph-prd`, builds the
plugin into it, and commits and pushes only when the output changed, with a commit message
naming the omniralph commit it was built from.

### The secret to set

The workflow pushes with a deploy key, read from the Actions secret
**`PRD_PLUGIN_DEPLOY_KEY`** of this repo. To set it up once:

1. Create a key pair: `ssh-keygen -t ed25519 -N "" -C "omniralph publish-prd-plugin" -f prd-plugin-key`.
2. In `mcm/omniralph-prd` › Settings › Deploy keys, add `prd-plugin-key.pub` with
   **Allow write access**.
3. In this repo › Settings › Secrets and variables › Actions, add a repository secret
   `PRD_PLUGIN_DEPLOY_KEY` with the contents of `prd-plugin-key`, then delete both files.
4. Run the workflow from the Actions tab (or push to `main`) to publish.

Until the secret exists, the checkout step of the workflow fails and nothing is published.
