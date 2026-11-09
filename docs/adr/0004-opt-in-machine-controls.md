# ADR 0004 — Opt-in machine controls: power mode

Status: accepted, implemented for Linux · 2026-11-09 · Amends D1 and D7 for one opt-in endpoint.

The owner wants to switch a laptop's fan/power mode (the three Fn+Q modes on the Lenovo 83LT) from the phone while away from it. On Linux these modes are the OS power profile: power-profiles-daemon `power-saver`/`balanced`/`performance`, which map to the kernel `platform_profile` `low-power`/`balanced`/`performance`. On most laptops the platform profile also selects the firmware fan curve. The owner chose to build this into burn rather than a separate remote-control app: the reporter, tailnet transport, autostart and machine registration already exist, and Systems is where the fan speed and temperatures it affects are shown.

## Decision

- **One write, off by default.** The reporter gains `GET`/`POST /controls/power-mode`. It is disabled unless `burn-report controls enable power-mode` sets `controls.powerMode` in the reporter config. When disabled, the endpoint answers 404 and the reporter does not advertise it. Every other endpoint stays read-only, so D1 holds for all usage, quota and health data.
- **Advertised, not assumed.** An enabled reporter that finds power modes adds `power-mode` to `/ping` capabilities. The phone shows the control only for machines that advertise it. It is re-detected at most once a minute if the daemon was not ready at boot.
- **Only the machine's own modes.** The request body is exactly `{ "mode": <id> }`. Ids are validated on both sides. A mode outside the machine's current list is refused (409). Kernel `custom` is never offered. The mode is passed to `powerprofilesctl` as one argument with no shell, or written directly to `platform_profile`.
- **Confirmed by read-back.** The reporter answers only after reading the new mode back (up to about 1 s). The phone moves the selector immediately, then confirms or springs back with the reporter's message.
- **Live-only on the phone.** Power-mode state is never written to the SQLite mirror, and nothing is queued for an offline machine. It polls every 3 s, and only while Systems is focused. Fan speeds come with the state; they are not persisted.
- **Browser-forgery resistant.** D7 (tailnet membership authorizes) still applies. A write must also carry `x-burn-control: 1` and `content-type: application/json`, and must not carry an `Origin` header. A web page open on another tailnet device therefore cannot change the mode: the custom header forces a CORS preflight the reporter never grants. Writes are serialized and logged by the daemon.
- **Linux first.** Backend order: power-profiles-daemon (the session's authority, and it stays in sync with firmware hotkeys), then a directly writable `platform_profile`. power-profiles-daemon's polkit policy allows the change while the user has an active desktop session. `burn-report controls polkit-rule` prints a rule limited to `switch-profile` for that one user, for changing modes while signed out. Installing it is the user's explicit, root-owned choice.

## Not in scope

Windows (no OS-standard fan mode; vendor WMI needs admin, and the per-user launcher runs without it), macOS, WSL (no hardware access), custom fan curves, and any other remote action. A broader remote-control feature set would need its own ADR, with caller identity checks (for example Tailscale WhoIs) and confirmations.
