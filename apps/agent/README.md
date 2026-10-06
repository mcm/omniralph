# @iamthemcmaster/omniralph-agent

`omniralph-agent` is the Omniralph agent host daemon. It pulls review jobs from an Omniralph
control panel and runs them with the Claude Agent SDK. It needs Node 22 and git ≥ 2.40.

This README covers installing and releasing the package. To set up a host (a dedicated Unix user,
the Claude login, systemd or tmux), see
[docs/deploy-agent.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-agent.md).

## Install

The package is private (restricted) on the public npm registry. The installing user needs an
`~/.npmrc` with a token that can read the `@iamthemcmaster` scope. This is the same auth that
`@iamthemcmaster/ui` uses. A granular access token with read-only access to the package is enough:

```sh
echo "//registry.npmjs.org/:_authToken=<read-only npm token>" >> ~/.npmrc
chmod 600 ~/.npmrc
```

To install globally without root, point npm's prefix at your home:

```sh
npm config set prefix ~/.local     # binaries go to ~/.local/bin; put it on PATH
npm install -g @iamthemcmaster/omniralph-agent
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

To run it as a service, see the systemd and tmux sections in
[docs/deploy-agent.md](https://github.com/mcm/omniralph/blob/main/docs/deploy-agent.md).

## Upgrade

Stop the agent, then:

```sh
npm install -g @iamthemcmaster/omniralph-agent@latest
omniralph-agent --version
```

Start it again. Upgrading keeps the config and the repo cache. The version shows on the agent's
row on the **Agents** page after its next heartbeat.

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
