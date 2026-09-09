# ADR 0003: Database-global cloud sync revision

Status: **implemented** · Corrects D5 · 2026-09-09

## Problem

`usage_events.revision` is local to an environment. Every reporter starts at
revision 1, but the phone used one watermark for all environments. A busy
machine could therefore move that watermark past every revision on a newly
connected or quieter machine, permanently omitting its rows.

## Decision

Cloud rows retain their environment revision for provenance, and additionally
receive a monotonic database-global `sync_revision` on insert and update. The
cloud delta RPC pages on this global value and identifies the response as
cursor contract v2. The phone uses a new v2 watermark key, forcing one safe
replay after migration 0008. It rejects v1 responses rather than advancing a
cursor with incomplete multi-machine semantics.

Direct mode is unchanged: it has one time cursor per machine and merges stable
event ids locally. All app range queries aggregate every environment in the
mirror; `All` is truly unbounded rather than an arbitrary 100-year window.

## Rollout

Apply `supabase/migrations/0008_global_sync_revision.sql` before installing the
updated phone app. Then open or refresh the app; the first cloud pull replays
the table idempotently, after which pulls are incremental again.
