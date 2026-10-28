#!/usr/bin/env bash
# Packs apps/agent, checks the tarball's contents, installs it into a clean
# directory outside the workspace and runs the binary. Run after `pnpm install`.
# Usage: smoke-agent-package.sh [keep-dir]
# With keep-dir, the smoke-tested tarball is copied there (for publishing it as is).
set -euo pipefail

keep_dir="${1:-}"

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

# The agent page (dist/ui): index.html loads one hashed module script and no inline script
# or style (the page's CSP), every asset it references ships, it stays small (an accidental
# full icon index would not) and no source map of it ships.
grep -qxF package/dist/ui/index.html <<<"$contents" || fail "tarball is missing dist/ui/index.html"
index_html="$(tar -xOzf "$tarball" package/dist/ui/index.html)"
[[ "$(grep -o '<script' <<<"$index_html" | wc -l | tr -d ' ')" == 1 ]] ||
  fail "dist/ui/index.html must load exactly one script"
grep -qE '<script type="module" crossorigin src="\./assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js"></script>' <<<"$index_html" ||
  fail "dist/ui/index.html must load one hashed module script from assets/"
if grep -qiE '<style|[[:space:]]style=' <<<"$index_html"; then
  fail "dist/ui/index.html has an inline style"
fi
referenced="$(grep -oE '(src|href)="\./assets/[^"]+"' <<<"$index_html" | sed -E 's/^(src|href)="\.\///; s/"$//')"
while read -r asset; do
  grep -qxF "package/dist/ui/$asset" <<<"$contents" ||
    fail "tarball is missing dist/ui/$asset, which index.html loads"
done <<<"$referenced"
ui_maps="$(grep -E '^package/dist/ui/.*\.map$' <<<"$contents" || true)"
[[ -z "$ui_maps" ]] || fail "the agent page ships source maps:"$'\n'"$ui_maps"
ui_bytes="$(node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const size = (p) => fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).reduce((sum, name) => sum + size(path.join(p, name)), 0)
    : fs.statSync(p).size;
  console.log(size(process.argv[1]));
' "$agent_dir/dist/ui")"
(( ui_bytes < 3 * 1024 * 1024 )) || fail "dist/ui is $ui_bytes bytes, over 3 MB"
echo "Agent page: $ui_bytes bytes"

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
  [[ -f node_modules/@omniralph/agent/dist/ui/index.html ]] ||
    fail "the installed package has no dist/ui/index.html"

  # ui, with no daemon running: says so and exits 1.
  ui_config="$work/ui-config/agent.json"
  mkdir -p "$(dirname "$ui_config")"
  printf '{"server":"https://omniralph.example","agentId":"3c1d0b8e-0000-4000-8000-000000000080","refreshToken":"ort_smoke","workspaceRoot":"%s"}\n' \
    "$work/ui-workspace" >"$ui_config"
  chmod 600 "$ui_config"
  ui_status=0
  ui_output="$("$bin" ui --config "$ui_config" 2>&1)" || ui_status=$?
  [[ "$ui_status" == 1 ]] || fail "ui without a daemon exited $ui_status, not 1"
  grep -qF "The agent isn't running." <<<"$ui_output" ||
    fail "ui without a daemon printed: $ui_output"

  # import, offline, on a copy of the full fixture install (git keeps only mode 0644).
  home="$work/import-home"
  cp -R "$agent_dir/src/test/fixtures/import/full" "$home"
  old_config="$home/.config/omniralph/harness.json"
  sed -i.orig "s#{{home}}#$home#g" "$old_config" && rm "$old_config.orig"
  chmod 600 "$old_config"
  new_config="$work/import-new/agent.json"
  "$bin" import --dry-run --from "$old_config" --config "$new_config" >/dev/null ||
    fail "import --dry-run failed"
  [[ ! -e "$new_config" ]] || fail "import --dry-run wrote $new_config"
)

if [[ -n "$keep_dir" ]]; then
  mkdir -p "$keep_dir"
  cp "$tarball" "$keep_dir/"
  echo "Kept $keep_dir/$(basename "$tarball")"
fi

echo "smoke-agent-package: OK"
