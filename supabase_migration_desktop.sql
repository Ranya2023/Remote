-- Run this once in your Supabase project's SQL editor. Safe/idempotent to
-- re-run. Adds one column: sessions.pointer_state - a small JSON blob
-- holding the latest laser/spotlight position, saved a few times a second
-- from the phone remote. Nothing in the existing web app reads this (it
-- still uses the instant live broadcast) - this column exists purely so the
-- desktop controller script (nextslide_desktop.py) can find out where the
-- laser/spotlight currently is via plain polling, without needing a
-- WebSocket connection.

alter table sessions add column if not exists pointer_state jsonb not null default '{}'::jsonb;
