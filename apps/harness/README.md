# @omniralph/harness

`omniralph-harness` is the Omniralph harness: the host daemon. It pulls review jobs from an Omniralph
control panel and runs them with the Claude Agent SDK. It needs Node 22 and git ≥ 2.40.

This README covers installing and releasing the package. To set up a host (the harness's user, the
Claude login, pm2, tmux or systemd), see
[docs/deploy-harness.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-harness.md).

## Install

The package is public on the npm registry: installing it needs no npm token. To install globally
without root, point npm's prefix at your home:

```sh
npm config set prefix ~/.local     # binaries go to ~/.local/bin; put it on PATH
npm install -g @omniralph/harness
omniralph-harness --version
```

## Enroll

As an admin, open **Harnesses › Enroll harness** in the control panel and run the command it shows on
the host, as the harness's user:

```sh
omniralph-harness enroll --server https://omniralph.example.com --token <enrollment-token>
```

This writes `~/.config/omniralph/harness.json` (`--config` or `OMNIRALPH_HARNESS_CONFIG` choose
another path). Run `omniralph-harness --help` to see all the options.

## Start

```sh
omniralph-harness start --healthz-port 9310
```

To run it as a service, see the systemd, tmux and pm2 sections in
[docs/deploy-harness.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-harness.md).

## Upgrade

Stop the harness, then:

```sh
npm install -g @omniralph/harness@latest
omniralph-harness --version
```

Start it again. Upgrading keeps the config and the repo cache. The version shows on the harness's
row on the **Harnesses** page after its next heartbeat.

### From 0.8.0 or earlier (the agent package)

Up to 0.8.0 the harness was published under the old "agent" package and binary names; from 0.9.0
it's `@omniralph/harness` with the `omniralph-harness` binary and the config file
`~/.config/omniralph/harness.json`. Hosts on 0.8.0 or earlier can't self-update across the rename,
so reinstall them by hand once, as the harness's user:

1. Stop the old daemon and uninstall its global package (`npm ls -g --depth=0` lists it).
2. `npm install -g @omniralph/harness@latest`.
3. Move the config: `mv ~/.config/omniralph/agent.json ~/.config/omniralph/harness.json` (if you
   set the old config env var, set `OMNIRALPH_HARNESS_CONFIG` instead), or enroll again.
4. Start `omniralph-harness start` under pm2, tmux or systemd as before.

Self-update works again from then on.

## Releasing

GitHub Actions (`.github/workflows/publish-agent.yml`) publishes releases through npm trusted
publishing. No npm publish token is stored anywhere.

1. Bump `version` in `apps/harness/package.json` and merge the change to `main`.
2. Tag that commit `agent-v<version>` and push the tag:

   ```sh
   git tag agent-v0.2.0 && git push origin agent-v0.2.0
   ```

The workflow installs and checks only this package and the workspace packages it bundles (the web
app and db are left to CI), runs `scripts/smoke-agent-package.sh`, then publishes the tarball the
smoke script tested. It fails if the tag version doesn't match `package.json`.

The build (`tsup`) inlines the workspace packages (`@omniralph/engine`, `@omniralph/shared`) into
`dist/cli.js`. Third-party packages stay external. A third-party package that the bundle imports
must be listed in this package's `dependencies`, or the installed binary won't start. The smoke
script catches this.
