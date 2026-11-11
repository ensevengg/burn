# ADR 0005 — Peer discovery between reporters

Status: accepted, implemented · 2026-11-11 · Extends D4 (manual registration stays; this only pre-fills it).

Adding machines was the slowest part of setup: each reporter's address had to be read off a terminal and typed into the phone, once per machine. The phone cannot list tailnet devices itself (that needs Tailscale API credentials, which D7 rules out). A reporter can: the local Tailscale client already knows its peers.

## Decision

- **One read-only endpoint.** A listening reporter answers `GET /live/peers` with the other burn reporters it can reach: `{ peers: [{ url, slug, displayName, osKind }] }`. It advertises `peer-discovery` in `/ping` capabilities. D1 holds: nothing is written anywhere.
- **Targets come from Tailscale, never from the request.** The reporter asks its own Tailscale client for online peers (`tailscale status --json`) and sends each one `GET /ping` on the reporter's own port, with a 1.5-second limit, at most 64 peers. A peer counts only if its answer passes the same `/ping` validation the phone applies. Results are cached for 60 seconds. Without the `tailscale` CLI the list is empty.
- **The phone still registers by validated ping.** The add sheet asks every registered machine for its peers, drops slugs that are already registered, and offers the rest. Tapping one runs the ordinary add flow against that URL, including the `/ping` identity check. A peer URL must be a bare `http(s)://host[:port]`; anything else fails validation, so a machine cannot send the phone to an arbitrary address.
- **Best effort.** Unreachable machines, older reporters and failed probes contribute nothing and raise no error. Typing a name or address always works.

## Consequences

- Only the first machine has to be typed in; the rest are one tap each.
- A reporter makes outbound requests to other tailnet devices, but only when a phone asks, only to peers Tailscale lists, and only `GET /ping`. D12 holds: nothing leaves the tailnet.
- Reporters on a non-default port find only peers on that same port.

## Not in scope

Discovery without any registered machine (the phone would need tailnet credentials), QR onboarding, and registering a machine without the user's tap.
