-- Run this once in your Supabase project's SQL editor. Safe/idempotent to
-- re-run.
--
-- Caches Google Slides deck metadata (slide count + speaker notes) fetched
-- once via GAS's SlidesApp service, so re-opening the same deck's link
-- doesn't need to re-fetch from Google every time. No PDF, no file
-- conversion, no new Drive file - the deck is shown natively via Google's
-- own embed viewer at present-time (see Present.tsx), this table only
-- holds the small bits of metadata needed to know how many slides there
-- are and what their notes say. Same "wide open, anon-key" policy as
-- sessions/pptx_meta/video_links/lessons - this app has no server-side auth.

create table if not exists google_slides_decks (
  presentation_id text primary key,
  slide_count integer not null,
  notes_by_page jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table google_slides_decks enable row level security;
drop policy if exists "public access" on google_slides_decks;
create policy "public access" on google_slides_decks for all using (true) with check (true);
