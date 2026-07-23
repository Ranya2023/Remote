-- Run this once in your Supabase project's SQL editor. Safe/idempotent to
-- re-run.
--
-- Moves video links and lessons out of Google Apps Script's
-- PropertiesService (global, ever-growing key/value storage with real size
-- limits and no query ability) into real Supabase tables - the same reason
-- everything else "session-ish" (sessions, pptx_meta) already lives here
-- instead of in GAS. Google Apps Script is still used for actual Drive/
-- Slides operations (uploads, PDF conversion) - nothing here touches
-- Drive, so it never needed to go through GAS in the first place.
--
-- Same policy as pptx_meta/sessions: wide open, anon-key read/write - this
-- app has no server-side auth, and a video link or lesson's contents (just
-- a list of already-public fileIds) aren't sensitive, unlike saved_items/
-- profiles which are properly per-user.

create table if not exists video_links (
  id text primary key,
  platform text not null,
  embed_url text not null,
  original_url text,
  created_at timestamptz not null default now()
);
alter table video_links enable row level security;
drop policy if exists "public access" on video_links;
create policy "public access" on video_links for all using (true) with check (true);

create table if not exists lessons (
  id text primary key,
  slides jsonb not null,
  created_at timestamptz not null default now()
);
alter table lessons enable row level security;
drop policy if exists "public access" on lessons;
create policy "public access" on lessons for all using (true) with check (true);
