# ADR 0006 — One tag, one release, one line per machine

Status: accepted, implemented · 2026-11-12 · Refines D11 (GitHub Releases, no Play Store) and extends ADR 0005.

Setting burn up took a checkout or hand-picked binaries per machine, typing each machine's address into the phone, and an APK nobody published. Releasing took separate tags for the exporter and nothing for the app. The owner asked for a vertical system: fast for people to set up, and not a headache to develop and roll out.

## Decision

- **One tag publishes everything.** `scripts/release.sh x.y.z` sets the version in every place it lives (`scripts/release-version.ts`: app.json and its versionCode, both package.json files, `REPORTER_VERSION`), runs typecheck and tests, commits, tags `vx.y.z` and pushes after a prompt. The `release` workflow re-checks the tag against those fields, runs the tests, builds `burn-events` and `burn-report` for each platform and a signed arm64 APK, and only then creates the release with both installers and `SHA256SUMS`. Every release carries the whole set, so `releases/latest/download/<file>` always resolves to matching files. A manual run builds without publishing.
- **The APK is built in GitHub Actions**, not EAS: `expo prebuild` plus Gradle, signed with a keystore held in repository secrets (`plugins/with-release-signing.js`). No Expo account or build queue sits between a tag and a release. Android installs an update only when it carries the same signature, so the key never changes.
- **One line per machine.** `install.sh` (Linux, macOS, WSL) and `install.ps1` (Windows) download from the latest release, verify checksums, install, run `install-service` and print the pairing QR code. The Windows installer offers each WSL distro, turns on mirrored networking with consent, and runs the Linux installer inside it.
- **QR pairing.** `burn-report pair`, `install-service` and a foreground `daemon` print a QR code of `burn://add?url=http://<tailnet address>:<port>`. The phone scans it with Google's system code scanner (expo-camera, no camera permission; CAMERA and RECORD_AUDIO are stripped from the manifest) or opens the same link from another scanner. Scanning registers through the ordinary `/ping`-validated add flow; an opened link pre-fills the sheet and waits for a tap. The code carries an address only, no credential (D7).
- **WSL beside Windows.** Mirrored networking gives WSL the Windows address, so each fresh WSL distro takes the first free port from 8788 to 8790 and a `-wsl-<distro>` slug, the port is saved in the reporter config, and peer discovery probes 8787–8790 on each peer and on its own address.

## Consequences

- The first release needs the four signing secrets once (see the top of `release.yml`). Phones running a locally built copy must uninstall it before installing the released APK, because the keys differ.
- The APK ships arm64-v8a only.
- `burn-events-v*` tags are retired; the exporter version still follows the tokscale pin and is reported by `/ping`.
