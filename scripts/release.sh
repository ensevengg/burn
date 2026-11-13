#!/bin/sh
# Cut a release: bump every version field, run the checks, commit, tag and
# push. The tag starts .github/workflows/release.yml, which builds the APK,
# both binaries for each platform and the installers into one release.
#
#   scripts/release.sh 0.2.0
set -eu

version="${1:-}"
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: scripts/release.sh <x.y.z>" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not in step with origin/main" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && { echo "v$version already exists" >&2; exit 1; }

bun scripts/release-version.ts set "$version"
# A failed check leaves the tree as it was.
if ! { bun run typecheck && bun run test; }; then
  git checkout --quiet -- .
  echo "checks failed; version fields restored" >&2
  exit 1
fi

# Releasing the version already in the tree needs no bump commit.
git diff --quiet || git commit --quiet -am "chore(release): v$version"
git tag -a "v$version" -m "burn v$version"
printf 'Push main and v%s to start the release build? [y/N] ' "$version"
read -r answer
case "$answer" in
  y|Y|yes) git push --quiet origin main "v$version" ;;
  *)
    undo="git tag -d v$version"
    [ "$(git log -1 --format=%s)" = "chore(release): v$version" ] && undo="$undo && git reset --hard HEAD~1"
    echo "Not pushed. To undo: $undo"; exit 0 ;;
esac
echo "Building: https://github.com/ensevengg/burn/actions/workflows/release.yml"
