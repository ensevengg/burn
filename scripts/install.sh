#!/bin/sh
# Install burn on this machine: burn-report and its burn-events exporter from
# the latest GitHub release, started now and at every boot, then the QR code
# to scan on the phone. Linux x86_64, WSL, macOS Apple silicon. No Bun, Rust
# or checkout needed. Run it again to upgrade.
#
#   curl -fsSL https://github.com/ensevengg/burn/releases/latest/download/install.sh | sh
#
# Windows: irm https://github.com/ensevengg/burn/releases/latest/download/install.ps1 | iex
#
# Overrides: BURN_INSTALL_DIR (default ~/.local/bin),
#            BURN_RELEASE_TAG (a release such as v0.2.0; default: the latest),
#            BURN_RELEASE_BASE (a download URL to use instead of a release),
#            BURN_NO_SERVICE=1 (install the binaries only).
set -eu

repo="ensevengg/burn"
dir="${BURN_INSTALL_DIR:-$HOME/.local/bin}"

# Every release carries the whole set, so "latest" always matches itself.
# The checksums come from the same place as the binaries, so the connection
# is what vouches for them: a release is fetched over HTTPS only, redirects
# included. BURN_RELEASE_BASE (a mirror or a local copy) is taken as given.
https="--proto =https --proto-redir =https"
if [ -n "${BURN_RELEASE_BASE:-}" ]; then
  base="$BURN_RELEASE_BASE"
  https=""
elif [ -n "${BURN_RELEASE_TAG:-}" ]; then
  base="https://github.com/$repo/releases/download/$BURN_RELEASE_TAG"
else
  base="https://github.com/$repo/releases/latest/download"
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) reporter="burn-report-linux-x64"; exporter="burn-events-x86_64-unknown-linux-gnu" ;;
  Darwin-arm64) reporter="burn-report-darwin-arm64"; exporter="burn-events-aarch64-apple-darwin" ;;
  *)
    echo "No release binaries for $(uname -s) $(uname -m)." >&2
    echo "Build from source instead: https://github.com/$repo#from-source" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  # shellcheck disable=SC2086
  if ! curl -fsSL $https --retry 2 -o "$tmp/$1" "$base/$1"; then
    echo "Could not download $base/$1" >&2
    exit 1
  fi
}
echo "Downloading burn from $base"
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
# entry or environment variable to find each other. Replacing a running
# binary is safe: install moves a new file into place.
install -m 755 "$tmp/$reporter" "$dir/burn-report"
install -m 755 "$tmp/$exporter" "$dir/burn-events"
echo "Installed $dir/burn-report and $dir/burn-events"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "($dir is not on your PATH: add it, or use $dir/burn-report)" ;;
esac

# The macOS app (App Store or standalone) puts no tailscale on PATH.
if ! command -v tailscale >/dev/null 2>&1 && ! command -v tailscale.exe >/dev/null 2>&1 \
  && [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  echo
  echo "Tailscale was not found. Install it and sign in (https://tailscale.com/download);"
  echo "burn waits for it, so nothing needs restarting afterwards."
fi

if [ "${BURN_NO_SERVICE:-}" = "1" ]; then
  echo
  echo "Start it with: $dir/burn-report install-service"
  exit 0
fi

echo
# Starts the reporter now and with the machine (systemd user unit on Linux,
# a sign-in launcher for WSL), then prints the QR code for the phone.
"$dir/burn-report" install-service || {
  echo
  echo "The reporter is installed but could not be set to start by itself."
  echo "Run it in a terminal instead: $dir/burn-report daemon"
  exit 1
}
echo
echo "No app yet? Install it on your phone: https://github.com/$repo/releases/latest/download/burn.apk"
echo "Show the QR code again any time with: burn-report pair"
