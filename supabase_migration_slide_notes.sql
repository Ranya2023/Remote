-- Run this once in your Supabase project's SQL editor. Safe/idempotent to
-- re-run.
--
-- Presenter-typed notes per slide, edited from the phone remote (separate
-- from any speaker notes auto-extracted from the file itself). Keyed by
-- (file_id, slide_number) - file_id is the lesson/presentation's own URL
-- identifier, slide_number is the global flat slide number within it, so
-- this works the same way for both a single uploaded file and a multi-item
-- lesson.
--
-- "Saved permanently until you remove this lesson": Account.tsx's
-- deleteItem() cleans up the matching rows here when a saved lesson is
-- deleted, so nothing is orphaned - see that function's comment.
--
-- Same "wide open, anon-key" policy as sessions/pptx_meta/lessons/etc -
-- this app has no server-side auth.

create table if not exists slide_notes (
  file_id text not null,
  slide_number integer not null,
  note text not null default '',
  updated_at timestamptz not null default now(),
  primary key (file_id, slide_number)
);
alter table slide_notes enable row level security;
drop policy if exists "public access" on slide_notes;
create policy "public access" on slide_notes for all using (true) with check (true);
