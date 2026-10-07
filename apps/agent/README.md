# @omniralph/agent

`omniralph-agent` is the Omniralph agent host daemon. It pulls review jobs from an Omniralph
control panel and runs them with the Claude Agent SDK. It needs Node 22 and git ≥ 2.40.

This README covers installing and releasing the package. To set up a host (a dedicated Unix user,
the Claude login, systemd, tmux or pm2), see
[docs/deploy-agent.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-agent.md).

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

This writes `~/.config/omniralph/agent.json`. Run `omniralph-agent --help` to see all the options.

## Start

```sh
omniralph-agent start --healthz-port 9310
```

To run it as a service, see the systemd, tmux and pm2 sections in
[docs/deploy-agent.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-agent.md).

## Upgrade

Stop the agent, then:

```sh
npm install -g @omniralph/agent@latest
omniralph-agent --version
```

Start it again. Upgrading keeps the config and the repo cache. The version shows on the agent's
row on the **Agents** page after its next heartbeat.

### From 0.3.0 or earlier (`@iamthemcmaster/omniralph-agent`)

Up to 0.3.0 the package was `@iamthemcmaster/omniralph-agent`; from 0.3.1 it's `@omniralph/agent`.
Agents on 0.3.0 or earlier can't self-update across the rename (they'd install the old package
name), so upgrade them by hand once. Both packages install the `omniralph-agent` binary, so remove
the old one first.

```sh
npm uninstall -g @iamthemcmaster/omniralph-agent
npm install -g @omniralph/agent@latest
omniralph-agent --version
```

Under pm2, run `pm2 restart omniralph-agent` afterwards. Self-update works again from 0.3.1 on.

## Releasing

GitHub Actions (`.github/workflows/publish-agent.yml`) publishes releases through npm trusted
publishing. No npm publish token is stored anywhere.

1. Bump `version` in `apps/agent/package.json` and merge the change to `main`.
2. Tag that commit `agent-v<version>` and push the tag:

   ```sh
   git tag agent-v0.2.0 && git push origin agent-v0.2.0
   ```

The workflow runs the quality gates and `scripts/smoke-agent-package.sh`, then publishes. It fails
if the tag version doesn't match `package.json`.

The build (`tsup`) inlines the workspace packages (`@omniralph/engine`, `@omniralph/shared`) into
`dist/cli.js`. Third-party packages stay external. A third-party package that the bundle imports
must be listed in this package's `dependencies`, or the installed binary won't start. The smoke
script catches this.
