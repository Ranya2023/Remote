-- Run this once in your Supabase project's SQL editor
-- (Project -> SQL Editor -> New query -> paste -> Run).
--
-- Adds three tables used by this update:
--   1. pptx_meta    - speaker notes + transitions extracted from uploaded .pptx files
--   2. accounts     - the "unique code + name" login accounts
--   3. saved_items  - lessons/quizzes saved to an account, shown on /account
--
-- These use the same "wide open, anon-key read/write" policy your existing
-- `sessions` table already relies on (this app has no server-side auth -
-- the Supabase anon key is used directly from the browser everywhere).
-- If you've locked down RLS elsewhere, adjust the policies below to match.

create table if not exists pptx_meta (
  file_id text primary key,
  notes jsonb not null default '{}'::jsonb,
  transitions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table pptx_meta enable row level security;
drop policy if exists "public access" on pptx_meta;
create policy "public access" on pptx_meta for all using (true) with check (true);

create table if not exists accounts (
  code text primary key,
  name text not null,
  created_at timestamptz not null default now()
);
alter table accounts enable row level security;
drop policy if exists "public access" on accounts;
create policy "public access" on accounts for all using (true) with check (true);

create table if not exists saved_items (
  id text primary key,
  account_code text not null references accounts(code) on delete cascade,
  kind text not null check (kind in ('lesson', 'quiz')),
  title text not null,
  file_id text,
  file_type text,
  questions jsonb,
  created_at timestamptz not null default now()
);
alter table saved_items enable row level security;
drop policy if exists "public access" on saved_items;
create policy "public access" on saved_items for all using (true) with check (true);

create index if not exists saved_items_account_code_idx on saved_items(account_code);
