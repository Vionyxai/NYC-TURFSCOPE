-- TurfScope NYC — knock tracking for the field team.
-- Paste this whole file into Supabase → SQL Editor → Run. Safe to run once on a new project.
--
-- How it's organized (plain version):
--   reps    one row per rep. A rep's login is matched to their row by email.
--   knocks  every tap on a door, stamped with the rep who made it. Nothing is ever edited;
--           a new tap on the same house simply becomes its latest status.
--   latest_knocks   the current status of each house (newest tap wins).
--   tract_progress  per-tract counts for the map card.
--
-- Security (row-level security, RLS): the app's public key can't read or write anything by
-- itself. Only someone logged in with an email listed in reps can see the team's knocks,
-- and a rep can only add knocks under their own name. Reps can undo their own knocks;
-- the admin (Gio) can remove anyone's.
--
-- No personal data: houses are identified by BBL (NYC's lot ID) only. No names, phone
-- numbers or free-text notes; follow-ups are preset choices.

-- ---------- Reps ----------
create table public.reps (
  id         smallint generated always as identity primary key,
  name       text not null unique,
  email      text unique,                    -- the rep's login email; filled in after creating their account
  is_admin   boolean not null default false,
  active     boolean not null default true,  -- set false when someone leaves the team
  created_at timestamptz not null default now()
);

-- The four-man team (same list as config/team.json).
insert into public.reps (name, is_admin) values ('Issac', false), ('Matt', false), ('Cody', false), ('Gio', true);

-- Who is calling? Matches the logged-in email to an active rep. Returns null for anyone else.
create or replace function public.my_rep_id() returns smallint
language sql stable security definer set search_path = public as $$
  select id from public.reps
  where active and email is not null and lower(email) = lower(auth.jwt() ->> 'email')
$$;

create or replace function public.i_am_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.reps where id = public.my_rep_id()), false)
$$;

-- ---------- Knocks ----------
create table public.knocks (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,           -- made on the phone, so a retry after bad signal never double-saves
  bbl        text not null check (bbl ~ '^[0-9]{10}$'),
  tract      text not null check (tract ~ '^[0-9]{11}$'),
  status     text not null check (status in ('no_answer', 'come_back', 'not_interested', 'interested', 'booked')),
  followup   text check (followup is null or followup in ('after_5pm', 'weekend', 'owner_away', 'call_first')),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  knocked_at timestamptz not null default now(),  -- when the rep tapped (the phone's clock; may have been offline)
  created_at timestamptz not null default now()   -- when it reached the database
);

create index knocks_tract_bbl_time on public.knocks (tract, bbl, knocked_at desc, id desc);
create index knocks_rep_time on public.knocks (rep_id, knocked_at desc);

-- ---------- Row-level security ----------
alter table public.reps enable row level security;
alter table public.knocks enable row level security;

-- Team members can see the team list (for names on knocks). Nobody changes reps from the app;
-- Gio edits that table in the Supabase dashboard.
create policy "team can see reps" on public.reps
  for select to authenticated using (public.my_rep_id() is not null);

create policy "team can see knocks" on public.knocks
  for select to authenticated using (public.my_rep_id() is not null);

create policy "reps add their own knocks" on public.knocks
  for insert to authenticated with check (rep_id = public.my_rep_id());

create policy "reps undo their own knocks, admin any" on public.knocks
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

-- No update policy on purpose: knocks are a log. A new tap replaces the status; undo deletes.

-- ---------- Views the app reads ----------
-- security_invoker makes the views obey the RLS rules above.
create view public.latest_knocks with (security_invoker = true) as
  select distinct on (k.bbl)
         k.bbl, k.tract, k.status, k.followup, k.knocked_at, k.client_id, r.name as rep
  from public.knocks k
  join public.reps r on r.id = k.rep_id
  order by k.bbl, k.knocked_at desc, k.id desc;

create view public.tract_progress with (security_invoker = true) as
  select tract,
         count(*)                                          as knocked,
         count(*) filter (where status = 'booked')         as booked,
         count(*) filter (where status = 'interested')     as interested,
         count(*) filter (where status = 'come_back')      as come_back,
         count(*) filter (where status = 'not_interested') as not_interested,
         count(*) filter (where status = 'no_answer')      as no_answer
  from public.latest_knocks
  group by tract;

-- Per-rep scoreboard (today and all time), for the office.
create view public.rep_stats with (security_invoker = true) as
  select r.name as rep,
         count(k.id)                                                          as knocks,
         count(k.id) filter (where k.status = 'booked')                       as booked,
         count(k.id) filter (where k.knocked_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York') as knocks_today,
         count(k.id) filter (where k.status = 'booked'
                               and k.knocked_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York') as booked_today
  from public.reps r
  left join public.knocks k on k.rep_id = r.id
  where r.active
  group by r.id, r.name
  order by r.id;

-- ---------- Permissions ----------
-- Supabase grants broad default rights on new tables; strip them and grant only what the app needs.
-- Logged-out visitors (the anon key) get nothing. Logged-in users go through the RLS rules above.
revoke all on public.reps, public.knocks, public.latest_knocks, public.tract_progress, public.rep_stats from anon, authenticated;
grant select on public.reps to authenticated;
grant select, insert, delete on public.knocks to authenticated;
grant select on public.latest_knocks, public.tract_progress, public.rep_stats to authenticated;
revoke execute on function public.my_rep_id(), public.i_am_admin() from anon, public;
grant execute on function public.my_rep_id(), public.i_am_admin() to authenticated;
