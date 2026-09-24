-- TurfScope NYC — team tracking for the field team: knocks, turf, notes and pins.
-- Paste this whole file into Supabase → SQL Editor → Run. Run it once on a new project.
--
-- How it's organized (plain version):
--   reps       one row per rep. A rep's login is matched to their row by email.
--   knocks     every tap on a door (house status), stamped with the rep who made it.
--   turf_log   every change to an area's status: claimed / finished / avoid / open, stamped with the rep.
--   notes      team notes: on a house, on a whole tract, or a pin dropped on the map.
--   Nothing is ever edited. A new tap simply becomes the latest; undo deletes your own entry.
--
--   latest_knocks   current status of each house (newest tap wins, whoever made it)
--   turf_status     current status of each tract (newest change wins, whoever made it)
--   tract_progress  per-tract counts for the map card
--   rep_stats       per-rep scoreboard
--
-- Security (row-level security, RLS): the app's public key can't read or write anything by
-- itself. Only a login whose email is listed in reps sees the team's data. Every rep can see
-- and change every house's and every tract's status, but each change is recorded under the
-- rep who made it (nobody can post as someone else). Reps undo only their own entries; the
-- admin (Gio) can remove anyone's.
--
-- Personal data: houses are identified by BBL (NYC's lot ID) plus the public street address.
-- Notes are free text for team coordination, capped at 280 characters, and the database
-- refuses any note that contains a phone number or an email address. Don't write names.

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

-- Notes must not carry contact details: no phone numbers (10 digits, any punctuation) or emails.
create or replace function public.clean_note(t text) returns boolean
language sql immutable as $$
  select t is null or (
    char_length(t) <= 280
    and t !~ '[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{4}'
    and t !~* '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
  )
$$;

-- ---------- Knocks (house status) ----------
create table public.knocks (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,           -- made on the phone, so a retry after bad signal never double-saves
  bbl        text not null check (bbl ~ '^[0-9]{10}$'),
  tract      text not null check (tract ~ '^[0-9]{11}$'),
  address    text check (char_length(address) <= 100),  -- public street address, for readable exports
  status     text not null check (status in ('no_answer', 'come_back', 'not_interested', 'interested', 'booked')),
  followup   text check (followup is null or followup in ('after_5pm', 'weekend', 'owner_away', 'call_first')),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  knocked_at timestamptz not null default now(),  -- when the rep tapped (the phone's clock; may have been offline)
  created_at timestamptz not null default now()   -- when it reached the database
);
create index knocks_tract_bbl_time on public.knocks (tract, bbl, knocked_at desc, id desc);
create index knocks_rep_time on public.knocks (rep_id, knocked_at desc);

-- ---------- Turf (area status: who picked which tract) ----------
create table public.turf_log (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  tract      text not null check (tract ~ '^[0-9]{11}$'),
  status     text not null check (status in ('claimed', 'finished', 'avoid', 'open')),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  set_at     timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index turf_log_tract_time on public.turf_log (tract, set_at desc, id desc);

-- ---------- Notes and pins ----------
create table public.notes (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  tract      text check (tract ~ '^[0-9]{11}$'),                 -- the tract it belongs to (null for a pin outside scored tracts)
  bbl        text check (bbl ~ '^[0-9]{10}$'),                   -- set for a note on a house
  address    text check (char_length(address) <= 100),
  lat        double precision check (lat between 40 and 42),     -- set for a pin
  lon        double precision check (lon between -75 and -71),
  body       text not null check (char_length(btrim(body)) between 1 and 280 and public.clean_note(body)),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  noted_at   timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (bbl is not null or tract is not null or (lat is not null and lon is not null)),
  check ((lat is null) = (lon is null))
);
create index notes_tract_time on public.notes (tract, noted_at desc);
create index notes_pins on public.notes (noted_at desc) where lat is not null;

-- ---------- Row-level security ----------
alter table public.reps enable row level security;
alter table public.knocks enable row level security;
alter table public.turf_log enable row level security;
alter table public.notes enable row level security;

-- Team members can see the team list. Nobody changes reps from the app; Gio edits that table
-- in the Supabase dashboard.
create policy "team can see reps" on public.reps
  for select to authenticated using (public.my_rep_id() is not null);

-- Same three rules on every team table: the team sees everything; you add entries only as
-- yourself; you undo only your own (the admin can undo anyone's).
create policy "team can see knocks" on public.knocks
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps add knocks as themselves" on public.knocks
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps undo their own knocks, admin any" on public.knocks
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

create policy "team can see turf" on public.turf_log
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps set turf as themselves" on public.turf_log
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps undo their own turf changes, admin any" on public.turf_log
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

create policy "team can see notes" on public.notes
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps write notes as themselves" on public.notes
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps delete their own notes, admin any" on public.notes
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

-- No update policies on purpose: everything is a log. A new entry replaces; undo deletes.

-- ---------- Views the app reads ----------
-- security_invoker makes the views obey the RLS rules above.
create view public.latest_knocks with (security_invoker = true) as
  select distinct on (k.bbl)
         k.bbl, k.tract, k.address, k.status, k.followup, k.knocked_at, k.client_id, r.name as rep
  from public.knocks k
  join public.reps r on r.id = k.rep_id
  order by k.bbl, k.knocked_at desc, k.id desc;

create view public.turf_status with (security_invoker = true) as
  select distinct on (t.tract)
         t.tract, t.status, t.set_at, t.client_id, r.name as rep
  from public.turf_log t
  join public.reps r on r.id = t.rep_id
  order by t.tract, t.set_at desc, t.id desc;

create view public.team_notes with (security_invoker = true) as
  select n.client_id, n.tract, n.bbl, n.address, n.lat, n.lon, n.body, n.noted_at, r.name as rep
  from public.notes n
  join public.reps r on r.id = n.rep_id;

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

-- Per-rep scoreboard (today and all time), for the team and the office.
create view public.rep_stats with (security_invoker = true) as
  with today as (select date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York' as t0)
  select r.name as rep,
         count(k.id)                                                         as knocks,
         count(k.id) filter (where k.status = 'booked')                      as booked,
         count(k.id) filter (where k.knocked_at >= today.t0)                 as knocks_today,
         count(k.id) filter (where k.status = 'booked' and k.knocked_at >= today.t0) as booked_today,
         (select count(*) from public.turf_status ts where ts.rep = r.name and ts.status = 'claimed') as turf_claimed
  from public.reps r
  cross join today
  left join public.knocks k on k.rep_id = r.id
  where r.active
  group by r.id, r.name, today.t0
  order by r.id;

-- ---------- Permissions ----------
-- Supabase grants broad default rights on new tables; strip them and grant only what the app needs.
-- Logged-out visitors (the anon key) get nothing. Logged-in users go through the RLS rules above.
revoke all on public.reps, public.knocks, public.turf_log, public.notes,
              public.latest_knocks, public.turf_status, public.team_notes, public.tract_progress, public.rep_stats
  from anon, authenticated;
grant select on public.reps to authenticated;
grant select, insert, delete on public.knocks, public.turf_log, public.notes to authenticated;
grant select on public.latest_knocks, public.turf_status, public.team_notes, public.tract_progress, public.rep_stats to authenticated;
revoke execute on function public.my_rep_id(), public.i_am_admin() from anon, public;
grant execute on function public.my_rep_id(), public.i_am_admin() to authenticated;
