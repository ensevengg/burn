# ADR 0003 — Tailscale-connected machines are the sole backend

Status: accepted, implemented · 2026-10-02 · Supersedes [ADR 0001](0001-tailscale-direct-pull.md) and [ADR 0002](0002-direct-mode-supabase-demoted.md).

The owner found the Supabase path slower and less dependable for timely machine metrics, and explicitly chose its complete removal. burn now reads validated events and quotas directly from resident machine reporters over Tailscale, with an offline SQLite mirror on the phone. Remove the cloud adapter, database migrations/seed, scoped-token setup, push/index/rendezvous paths, cloud UI and their dependencies; Tailscale is the sole real backend, with bundled demo mode retained.

Preserve the branch's cached snapshots, independent quota refreshes, paging/gzip/ETags, scan-start cursors, resumable continuations, daily full reconciliation, stable event identities and generation-protected mirror writes. Machine content always replaces changed cached content. Backend revision fields and authority guards have no role in the new contracts.

Upgrades preserve cached real history/preferences and existing machine registrations. Saved endpoint advertisements become direct registrations; missing addresses require manual addition. Reporter configs are rewritten through the machine-only schema, removing obsolete destination credentials and generated setup SQL. New initialization needs only a slug/name. Legacy `init --direct` remains accepted for command compatibility; removed upload options/commands fail explicitly.

History durability now depends on machine source files and the phone mirror. A new phone rebuilds from reachable source machines; an offline OS installation contributes when it next boots. This trade-off is accepted. Removing the backend from the repository does not delete or contact any user's existing external project. The owner may retire that infrastructure separately.
