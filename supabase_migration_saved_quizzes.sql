-- Run this once in your Supabase project's SQL editor. Safe/idempotent to
-- re-run.
--
-- Saved quizzes used to live only in sessions.audience_state, which is
-- keyed by a sessionId stored in localStorage per browser - so a saved
-- quiz only reliably showed up again on the exact same device/browser that
-- created it. This adds a table keyed by the lesson's own file_id instead,
-- so a saved quiz shows up no matter which device opens that lesson's
-- link. Same "wide open, anon-key" policy as sessions/pptx_meta - this app
-- has no server-side auth.

create table if not exists saved_quizzes_by_file (
  file_id text primary key,
  quizzes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table saved_quizzes_by_file enable row level security;
drop policy if exists "public access" on saved_quizzes_by_file;
create policy "public access" on saved_quizzes_by_file for all using (true) with check (true);
