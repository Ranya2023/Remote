-- Run this once in your Supabase project's SQL editor, after the other
-- NextSlide migrations. (Project -> SQL Editor -> New query -> paste -> Run)
--
-- WHY THIS EXISTS: this Supabase project turned out to already have a
-- `profiles` table from another one of your apps (teacher/student portal or
-- EngHub, going by the "Admins full access" / "Teachers read own profile"
-- policy names). Two real problems came from that:
--
--   1. That table's own "Admins full access" policy checks the current
--      user's role by querying `profiles` from *inside a policy on
--      profiles* - Postgres has to apply RLS to that inner query too,
--      which means re-evaluating the same policy again, and again. It
--      detects this and throws "infinite recursion detected in policy for
--      relation profiles" - a real database error, not an access denial -
--      for every single query against that table, from any user. That's
--      what was causing NextSlide's "Database error saving new user" /
--      500-on-load-profile symptoms - nothing to do with NextSlide's own
--      migration, this bug was already sitting in that shared table.
--
--   2. supabase_migration_auth.sql created a function named
--      handle_new_user() and a trigger named on_auth_user_created on
--      auth.users - both extremely common names (they're the exact names
--      Supabase's own docs use), so if your other app was built the same
--      way, it may have used the same names, and running that migration
--      could have silently replaced its original logic. This migration
--      does NOT touch handle_new_user() or on_auth_user_created at all -
--      if that turns out to need restoring, that's a separate, deliberate
--      fix using whatever that other app's original migration script had.
--
-- THE FIX: give NextSlide its own dedicated table, function, and trigger,
-- all under names that can't collide with anything else in this project,
-- ever. This runs *alongside* whatever's on auth.users already - multiple
-- AFTER INSERT triggers on the same table coexist fine in Postgres.

create table if not exists nextslide_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
alter table nextslide_profiles enable row level security;

drop policy if exists "users can view own profile" on nextslide_profiles;
create policy "users can view own profile" on nextslide_profiles
  for select using (auth.uid() = id);

drop policy if exists "users can update own profile" on nextslide_profiles;
create policy "users can update own profile" on nextslide_profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "trigger can insert profiles" on nextslide_profiles;
create policy "trigger can insert profiles" on nextslide_profiles
  for insert
  to supabase_auth_admin, postgres, service_role
  with check (true);

grant usage on schema public to supabase_auth_admin;
grant insert, select, update on public.nextslide_profiles to supabase_auth_admin, postgres;

create or replace function handle_new_user_nextslide()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  begin
    insert into public.nextslide_profiles (id, display_name)
    values (
      new.id,
      coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
    )
    on conflict (id) do nothing;
  exception when others then
    raise warning 'handle_new_user_nextslide(): could not create profile row for %: % (%)', new.id, SQLERRM, SQLSTATE;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_nextslide on auth.users;
create trigger on_auth_user_created_nextslide
  after insert on auth.users
  for each row execute function handle_new_user_nextslide();
