#!/usr/bin/env bash
# Packs apps/agent, checks the tarball's contents, installs it into a clean
# directory outside the workspace and runs the binary. Run after `pnpm install`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_dir="$repo_root/apps/agent"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "smoke-agent-package: $*" >&2
  exit 1
}

pnpm --dir "$agent_dir" build
pnpm --dir "$agent_dir" pack --pack-destination "$work/pack" >/dev/null
tarball="$(ls "$work"/pack/*.tgz)"
echo "Packed $(basename "$tarball")"

# Captured first: `grep -q` exiting early would SIGPIPE tar and trip pipefail.
contents="$(tar -tzf "$tarball")"
unexpected="$(grep -vE '^package/(package\.json|README\.md|dist/.*)$' <<<"$contents" || true)"
[[ -z "$unexpected" ]] || fail "unexpected files in the tarball:"$'\n'"$unexpected"
for file in package/README.md package/dist/cli.js package/dist/universal.md; do
  grep -qxF "$file" <<<"$contents" || fail "tarball is missing ${file#package/}"
done

manifest="$(tar -xOzf "$tarball" package/package.json)"
if grep -q 'workspace:' <<<"$manifest"; then
  fail "packed package.json still references workspace: packages"
fi

mkdir "$work/install"
(
  cd "$work/install"
  npm init -y >/dev/null
  npm install --no-audit --no-fund "$tarball"
  bin="$work/install/node_modules/.bin/omniralph-agent"
  "$bin" --version
  "$bin" --help >/dev/null
)

echo "smoke-agent-package: OK"
