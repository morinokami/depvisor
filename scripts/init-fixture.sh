#!/usr/bin/env bash
# Create a local working fixture from fixtures/sample-app.template/.
#
# The working fixture must be its OWN git repository (update-one creates
# branches/commits inside it), so it cannot be tracked by the depvisor repo —
# it is gitignored and recreated on demand with this script.
#
#   init-fixture.sh [--pm npm|pnpm|bun] [dest]
#
# --pm pnpm creates the pnpm variant (default dest fixtures/sample-app-pnpm):
# same template, but with a pnpm-lock.yaml instead of the template's committed
# package-lock.json, so package-manager detection resolves to pnpm.
# --pm bun does the same with a bun.lock (default dest fixtures/sample-app-bun).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
template="$root/fixtures/sample-app.template"

pm="npm"
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pm)
      pm="$2"
      shift 2
      ;;
    *)
      dest="$1"
      shift
      ;;
  esac
done
case "$pm" in
  npm) dest="${dest:-$root/fixtures/sample-app}" ;;
  pnpm) dest="${dest:-$root/fixtures/sample-app-pnpm}" ;;
  bun) dest="${dest:-$root/fixtures/sample-app-bun}" ;;
  *)
    echo "unsupported --pm '$pm' (npm|pnpm|bun)" >&2
    exit 1
    ;;
esac

if [ -e "$dest/.git" ]; then
  echo "fixture already initialized at $dest — nothing to do."
  echo "(to rebuild from scratch: rm -rf '$dest' && re-run this script)"
  exit 0
fi

mkdir -p "$dest"
cp -R "$template/." "$dest/"
cd "$dest"
if [ "$pm" = "pnpm" ]; then
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
echo "fixture ready at $dest (green baseline on branch main, $pm)."
