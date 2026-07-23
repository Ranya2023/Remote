-- Run this once in your Supabase project's SQL editor, AFTER
-- supabase_migration.sql (and supabase_migration_auth.sql, if you've
-- upgraded to real accounts) have already been run.
-- (Project -> SQL Editor -> New query -> paste -> Run)
--
-- Adds what the animated PPTX renderer needs:
--
--   1. pptx_meta.render_data - each slide's parsed shapes/text/images/
--      build order (see pptxParse.ts), saved once at upload time so the
--      presentation can be redrawn later without needing the original
--      PPTX file bytes again.
--   2. sessions.current_build - which build (bullet/shape reveal step) is
--      showing on the current slide, alongside the existing current_slide.
--
-- Both are simple additive columns - safe and idempotent to re-run.

alter table pptx_meta add column if not exists render_data jsonb not null default '{}'::jsonb;

alter table sessions add column if not exists current_build integer not null default 0;
