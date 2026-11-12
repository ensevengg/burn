#!/bin/sh
# Install burn-report and its burn-events exporter from the latest GitHub
# release (Linux x86_64, macOS Apple silicon). No Bun, Rust or checkout needed.
#
#   curl -fsSL https://raw.githubusercontent.com/ensevengg/burn/main/scripts/install.sh | sh
#
# Overrides: BURN_INSTALL_DIR (default ~/.local/bin),
#            BURN_RELEASE_TAG (default: the newest burn-events-v* release),
#            BURN_RELEASE_BASE (a download URL to use instead of a release).
# Windows: download burn-report-windows-x64.exe and
# burn-events-x86_64-pc-windows-msvc.exe from the release page into one
# folder, rename them burn-report.exe and burn-events.exe, and run
# `burn-report.exe daemon`.
set -eu

repo="ensevengg/burn"
dir="${BURN_INSTALL_DIR:-$HOME/.local/bin}"

# The binaries live on burn-events-v* releases. "latest" would be whichever
# release was published last (an app build, say), so the tag is looked up.
# The checksums come from the same place as the binaries, so the connection
# is what vouches for them: a release is fetched over HTTPS only, redirects
# included. BURN_RELEASE_BASE (a mirror or a local copy) is taken as given.
https="--proto =https --proto-redir =https"
if [ -n "${BURN_RELEASE_BASE:-}" ]; then
  base="$BURN_RELEASE_BASE"
  https=""
else
  tag="${BURN_RELEASE_TAG:-}"
  if [ -z "$tag" ]; then
    api="https://api.github.com/repos/$repo/releases?per_page=100"
    api_https="$https"
    if [ -n "${BURN_RELEASE_API:-}" ]; then api="$BURN_RELEASE_API"; api_https=""; fi
    # shellcheck disable=SC2086
    tag="$(curl -fsSL $api_https "$api" |
      grep -o '"tag_name": *"burn-events-v[^"]*"' | head -n 1 | sed 's/.*"\(burn-events-v[^"]*\)"/\1/')" || tag=""
  fi
  if [ -z "$tag" ]; then
    echo "No burn-events release was found for $repo." >&2
    echo "Build from source instead: see the README's \"From source\" section." >&2
    exit 1
  fi
  echo "release $tag"
  base="https://github.com/$repo/releases/download/$tag"
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) reporter="burn-report-linux-x64"; exporter="burn-events-x86_64-unknown-linux-gnu" ;;
  Darwin-arm64) reporter="burn-report-darwin-arm64"; exporter="burn-events-aarch64-apple-darwin" ;;
  *)
    echo "No release binaries for $(uname -s) $(uname -m)." >&2
    echo "Build from source instead: see the README's \"From source\" section." >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  echo "downloading $1"
  # shellcheck disable=SC2086
  curl -fsSL $https --retry 2 -o "$tmp/$1" "$base/$1"
}
fetch "$reporter"
fetch "$exporter"
fetch SHA256SUMS

# Refuse a binary that does not match the published checksum.
if command -v sha256sum >/dev/null 2>&1; then sum="sha256sum"; else sum="shasum -a 256"; fi
for file in "$reporter" "$exporter"; do
  want="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")"
  have="$(cd "$tmp" && $sum "$file" | awk '{ print $1 }')"
  if [ -z "$want" ] || [ "$want" != "$have" ]; then
    echo "checksum mismatch for $file; nothing was installed" >&2
    exit 1
  fi
done

mkdir -p "$dir"
# burn-report looks for burn-events beside itself, so the pair needs no PATH
# entry or environment variable to find each other.
install -m 755 "$tmp/$reporter" "$dir/burn-report"
install -m 755 "$tmp/$exporter" "$dir/burn-events"

echo
echo "installed $dir/burn-report and $dir/burn-events"
case ":$PATH:" in
  *":$dir:"*) run="burn-report" ;;
  *) run="$dir/burn-report"; echo "($dir is not on your PATH; use the full path below or add it.)" ;;
esac
echo
echo "Next, with Tailscale running on this machine and your phone:"
echo "  $run daemon             # start serving; prints what to add on the phone"
echo "  $run install-service    # or: start it at every login"
