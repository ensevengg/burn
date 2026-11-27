# ADR 0007 — Opt-in machine controls: keep awake

Status: accepted, implemented · 2026-11-26 · Extends ADR 0004 with a second control.

A long agent run (Claude Code, Codex, OpenCode…) stops when its laptop goes idle and suspends. The owner asked for more control over their machines from the phone. Keep awake is the control that matches what burn tracks: start a long run, walk away, and keep the machine from sleeping until the run is done, or extend the hold from the phone while away.

## Decision

- **Same rules as power mode.** `GET`/`POST /controls/keep-awake`, off unless `burn-report controls enable keep-awake`. Enabled reporters that find a backend advertise `keep-awake` in `/ping`. Writes go through the shared guard: `x-burn-control: 1`, JSON, no `Origin`, at most 1 KB. The phone shows the control only for advertising machines. It never mirrors the state and never queues a write for an offline machine.
- **Every hold expires on its own.** The body is exactly `{ "minutes": 0–720 }`. `0` releases. Anything else starts a hold of that length from now. There is no "forever". A hold is a child process that owns the OS inhibitor and exits when its timer runs out, so a crashed or restarted daemon cannot leave a machine awake indefinitely. Extending starts the new hold before stopping the old one, so the machine is never left uninhibited in between.
- **Sleep only, not the display.** Linux: `systemd-inhibit --what=sleep:idle --mode=block sleep <s>` (logind allows this for the user's session by default). macOS: `caffeinate -i -s -t <s>`. Windows: a hidden PowerShell calling `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`, then sleeping. The display may still turn off and the session may still lock. Lid-close handling is not inhibited: a closed laptop in a bag should still suspend.
- **Confirmed start.** The reporter answers only once the hold is in force: `systemd-inhibit` and `caffeinate` after surviving their first 400 ms, Windows after its PowerShell prints a marker following a successful `SetThreadExecutionState`. A hold that is refused (for example, a polkit denial) or does not start within 15 seconds is stopped and reported as an error, not shown as awake.
- **One owner per daemon.** The controller outlives listener rebinds, and stopping the daemon releases the hold.
- **No caller identity check.** ADR 0004 asks a broader remote-control set to consider one (for example, Tailscale WhoIs). Keep awake stays within power mode's risk class. The worst a tailnet member can do is keep a machine awake for 12 hours, or let it sleep on its usual schedule. It cannot run code, read data or change settings. So tailnet membership (D7) remains the authorization. A control that can lose work or data, such as shutdown, would need the identity check and an on-phone confirmation.
- **WSL is never offered.** It has no power management of its own. Enable the control on the Windows reporter of the same host.
- **Phone.** Each Systems card gets a Keep awake panel: "Awake · 1h 12m left", the clock time it ends, 1h / 2h / 4h / 8h buttons (restart the timer from now) and Off. The phone polls every 15 s while Systems is focused and shows writes optimistically, rolling them back on refusal.

## Not in scope

Holding the display on, inhibiting lid-close, scheduling holds for later, and tying a hold to an agent process exiting. The last would need the reporter to watch processes. The fixed timer is the safe default.
