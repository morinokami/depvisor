#!/usr/bin/env bash
# Create a local working fixture from fixtures/sample-app.template/.
#
# The working fixture must be its OWN git repository (update-one creates
# branches/commits inside it), so it cannot be tracked by the depvisor repo —
# it is gitignored and recreated on demand with this script.
#
#   init-fixture.sh [--pm npm|pnpm|bun] [--workspaces] [dest]
#
# --pm pnpm creates the pnpm variant (default dest fixtures/sample-app-pnpm):
# same template, but with a pnpm-lock.yaml instead of the template's committed
# package-lock.json, so package-manager detection resolves to pnpm.
# --pm bun does the same with a bun.lock (default dest fixtures/sample-app-bun).
# --workspaces creates the npm-workspaces monorepo variant from a separate
# template (default dest fixtures/sample-app-workspaces): two packages that
# share a dependency, so it exercises workspace collection and -w-scoped updates.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

pm="npm"
ws=0
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pm)
      pm="$2"
      shift 2
      ;;
    --workspaces)
      ws=1
      shift
      ;;
    *)
      dest="$1"
      shift
      ;;
  esac
done

if [ "$ws" = "1" ]; then
  # The monorepo variant is npm-only for now (bun/yarn workspaces are out of
  # scope; a pnpm-workspaces variant would need its own workspace declaration).
  if [ "$pm" != "npm" ]; then
    echo "--workspaces currently supports only --pm npm" >&2
    exit 1
  fi
  template="$root/fixtures/sample-app-workspaces.template"
  dest="${dest:-$root/fixtures/sample-app-workspaces}"
else
  template="$root/fixtures/sample-app.template"
  case "$pm" in
    npm) dest="${dest:-$root/fixtures/sample-app}" ;;
    pnpm) dest="${dest:-$root/fixtures/sample-app-pnpm}" ;;
    bun) dest="${dest:-$root/fixtures/sample-app-bun}" ;;
    *)
      echo "unsupported --pm '$pm' (npm|pnpm|bun)" >&2
      exit 1
      ;;
  esac
fi

if [ -e "$dest/.git" ]; then
  echo "fixture already initialized at $dest — nothing to do."
  echo "(to rebuild from scratch: rm -rf '$dest' && re-run this script)"
  exit 0
fi

mkdir -p "$dest"
cp -R "$template/." "$dest/"
cd "$dest"
if [ "$ws" = "1" ]; then
  # npm workspaces: the template ships no lockfile, so generate the single root
  # package-lock.json BEFORE the baseline commit (like the pnpm/bun variants),
  # leaving a clean, lockfile-complete tree. `npm install` at the root installs
  # every workspace; the root scripts fan build/test out across them.
  npm install --no-audit --no-fund
  git init -q -b main
  git add -A
  git -c user.email=fixture@depvisor.dev -c user.name=depvisor-fixture \
    commit -qm 'baseline: sample-workspaces (deps intentionally outdated)'
  npm run build >/dev/null
elif [ "$pm" = "pnpm" ]; then
  # The template ships npm's lockfile; the pnpm variant must generate its own
  # BEFORE the baseline commit so pnpm-lock.yaml is part of the green baseline.
  rm package-lock.json
  # Mark the fixture as its own pnpm workspace root. Without this, pnpm walks
  # up, finds depvisor's own pnpm-workspace.yaml (this repo uses pnpm too) and
  # captures the fixture into that workspace — installing nothing locally.
  printf 'packages: []\n' > pnpm-workspace.yaml
  pnpm install
  git init -q -b main
  git add -A
  git -c user.email=fixture@depvisor.dev -c user.name=depvisor-fixture \
    commit -qm 'baseline: sample-app (deps intentionally outdated)'
  pnpm run build >/dev/null
elif [ "$pm" = "bun" ]; then
  # Like the pnpm variant: generate bun.lock BEFORE the baseline commit so the
  # lockfile is part of the green baseline. No workspace-capture guard needed —
  # bun resolves workspace roots via package.json `workspaces`, which depvisor
  # does not have.
  rm package-lock.json
  bun install
  git init -q -b main
  git add -A
  git -c user.email=fixture@depvisor.dev -c user.name=depvisor-fixture \
    commit -qm 'baseline: sample-app (deps intentionally outdated)'
  bun run build >/dev/null
else
  git init -q -b main
  git add -A
  git -c user.email=fixture@depvisor.dev -c user.name=depvisor-fixture \
    commit -qm 'baseline: sample-app (deps intentionally outdated)'
  npm install --no-audit --no-fund
  npm run build >/dev/null
fi
label="$pm"
[ "$ws" = "1" ] && label="npm-workspaces"
echo "fixture ready at $dest (green baseline on branch main, $label)."
