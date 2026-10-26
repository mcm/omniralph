# @omniralph/agent

`omniralph-agent` is the Omniralph agent: the daemon that runs jobs on a machine. It pulls jobs
(reviews, queries, coding stories) from an Omniralph control panel and runs them with the Claude
Agent SDK. It needs Node 22 and git ≥ 2.40.

This README covers installing and releasing the package. To set up a host (the agent's user, the
Claude login, pm2, tmux or systemd), see
[docs/deploy-harness.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-harness.md).

## Install

The package is public on the npm registry: installing it needs no npm token. To install globally
without root, point npm's prefix at your home:

```sh
npm config set prefix ~/.local     # binaries go to ~/.local/bin; put it on PATH
npm install -g @omniralph/agent
omniralph-agent --version
```

## Enroll

As an admin, open **Agents › Enroll agent** in the control panel and run the command it shows on
the host, as the agent's user:

```sh
omniralph-agent enroll --server https://omniralph.example.com --token <enrollment-token>
```

This writes `~/.config/omniralph/agent.json` (`--config` or `OMNIRALPH_AGENT_CONFIG` choose
another path). Run `omniralph-agent --help` to see all the options.

## Start

```sh
omniralph-agent start --healthz-port 9310
```

To run it as a service, see the systemd, tmux and pm2 sections in
[docs/deploy-harness.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-harness.md).

## Upgrade

Stop the agent, then:

```sh
npm install -g @omniralph/agent@latest
omniralph-agent --version
```

Start it again. Upgrading keeps the config and the repo cache. The version shows on the agent's
row on the **Agents** page after its next heartbeat.

### From @omniralph/harness

Up to 0.13 the agent was published as `@omniralph/harness` with the `omniralph-harness` binary and
the config file `~/.config/omniralph/harness.json`. Self-update can't cross the rename, so install
`@omniralph/agent` once by hand, as the agent's user:

1. Stop the old daemon (`pm2 delete omniralph-harness`, or however you run it).
2. `npm install -g @omniralph/agent`.
3. `omniralph-agent import`: it reads the old install's config and writes
   `~/.config/omniralph/agent.json`, so the machine comes back as the same agent without enrolling
   again.
4. Start `omniralph-agent start` under pm2, tmux or systemd as before.
5. `npm uninstall -g @omniralph/harness` once the agent is back.

Self-update works again from then on.

## Releasing

Releases are automated with [changesets](https://github.com/changesets/changesets) and
`.github/workflows/publish-agent.yml`. Nobody edits `version` or pushes `agent-v*` tags by hand.
Merging the "Version Packages" pull request is the only release action.

### Add a changeset to your pull request

Every pull request that changes this package must add a changeset: a small Markdown file in
`.changeset/` that names the semver bump and holds the release note. To add one, run this from the
repository root, pick `@omniralph/agent` and the bump, write the note, and commit the file:

```sh
pnpm changeset
```

The agent bundles the workspace packages `@omniralph/engine`, `@omniralph/ralph`,
`@omniralph/shared` and `@omniralph/tasks` (its `workspace:*` devDependencies). Changesets doesn't
release those private packages, and it doesn't bump the agent when only they change. A pull
request that changes one of them must add a changeset for `@omniralph/agent` itself.

CI (`ci.yml`, `scripts/check-harness-changeset.ts`) fails a pull request that changes
`apps/agent/`, or any workspace package the agent depends on, and adds no
`@omniralph/agent` changeset. The package list comes from the workspace graph, so a new
dependency is covered automatically. If the change needs no release note (tests, an internal
refactor), add an empty changeset instead. CI accepts it as a deliberate opt-out:

```sh
pnpm changeset --empty
```

Pull requests that touch neither the agent nor its workspace packages need no changeset.

### The Version Packages pull request

When changesets reach `main`, the workflow opens a pull request titled "Version Packages" (branch
`changeset-release/main`), and updates it on every later push to `main`. The pull request runs
`pnpm changeset version`, which:

- bumps `version` in `apps/agent/package.json` by the largest bump the changesets declare;
- writes their notes to `apps/agent/CHANGELOG.md`, linking each entry's pull request and author;
- deletes the changeset files it consumed.

Empty changesets alone don't open the pull request. CI checks the pull request like any other,
but it skips the changeset check there.

### Release by merging it

Merging the Version Packages pull request releases the new version. On that push to `main`, the
workflow finds no pending changesets and a version that isn't on npm yet, and then:

1. installs only this package and the workspace packages it bundles (the web app and db are left
   to CI, so no npm token is needed);
2. typechecks, lints and tests them;
3. reads the version's section of `CHANGELOG.md` (it fails here if there is none);
4. runs `scripts/smoke-agent-package.sh`;
5. publishes the tarball the smoke script tested, through npm trusted publishing (OIDC). No npm
   publish token is stored anywhere;
6. pushes the tag `agent-v<version>` on the released commit and creates a GitHub Release named
   after it, with that version's changelog section as its notes.

Any other push to `main` finds the version already on npm, logs that there is nothing to release,
and succeeds.

### Re-run a failed publish

If a release fails before publishing (a check, the smoke test, npm), fix the cause on `main` if
needed. Then run the workflow again from **Actions › Publish agent › Run workflow** on `main`
(`workflow_dispatch`), or re-run the failed job. It publishes the version on `main` if that
version isn't on npm yet.

Once the version is on npm, the workflow treats it as released. If the tag or the GitHub Release
step failed after publishing, create them by hand for that version:

```sh
git tag agent-v<version> <released commit> && git push origin agent-v<version>
gh release create agent-v<version> --verify-tag --title agent-v<version> --notes "<changelog section>"
```

### The `CHANGESETS_GITHUB_TOKEN` secret

GitHub runs no workflows for pull requests or pushes made with the workflow's default
`GITHUB_TOKEN`. So the Version Packages pull request is opened and updated with the repository
secret `CHANGESETS_GITHUB_TOKEN`, and `ci.yml` runs on it. The secret holds a fine-grained
personal access token, or a GitHub App installation token, scoped to `mcm/omniralph`, with:

- **Contents: Read and write**, to commit the version bump and push the `changeset-release/main`
  branch. These commits must come from this token, so that CI also runs on later updates to the
  pull request;
- **Pull requests: Read and write**, to open the pull request and update its title and body.
  `@changesets/changelog-github` also uses it to look up each entry's pull request and author;
- **Metadata: Read-only**, which GitHub adds to every fine-grained token.

A GitHub App needs the same Contents and Pull requests permissions on its installation.

If the secret is unset, the workflow falls back to the default `GITHUB_TOKEN`. Everything still
works, except that CI doesn't run on the Version Packages pull request. To get the checks, close
and reopen the pull request, or push a commit to its branch yourself. Tags and GitHub Releases
always use the default token.

### Bundling

The build (`tsup`) inlines the workspace packages (`@omniralph/engine`, `@omniralph/shared`) into
`dist/cli.js`. Third-party packages stay external. A third-party package that the bundle imports
must be listed in this package's `dependencies`, or the installed binary won't start. The smoke
script catches this.
