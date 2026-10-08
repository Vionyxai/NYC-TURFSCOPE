-- TurfScope NYC — appointments: a pin on the map for every appointment a rep books, so the
-- whole team sees where appointments come from (and can count them by tract).
-- Paste into Supabase → SQL Editor → Run, once.
--
-- Same rules as notes and pins: the team sees every appointment with who booked it; you add
-- only as yourself; you remove only your own (Gio, the admin, can remove any). The note is
-- optional free text (280 characters) with no phone numbers or emails (clean_note). Don't put
-- the homeowner's name in it either: the address and time are enough.

create table public.appointments (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  tract      text check (tract ~ '^[0-9]{11}$'),                          -- the tract it's in (null outside scored tracts)
  bbl        text check (bbl ~ '^[0-9A-Za-z][0-9A-Za-z ./-]{3,39}$'),     -- the house, when booked from a walk list (NYC lot or LI parcel ID)
  address    text check (char_length(address) <= 100),
  lat        double precision not null check (lat between 40 and 42),
  lon        double precision not null check (lon between -75 and -71),
  appt_at    timestamptz,                                                -- when the appointment is (optional)
  note       text check (note is null or (char_length(btrim(note)) between 1 and 280 and public.clean_note(note))),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  created_at timestamptz not null default now()
);
create index appointments_tract on public.appointments (tract, created_at desc);

alter table public.appointments enable row level security;
create policy "team can see appointments" on public.appointments
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps book appointments as themselves" on public.appointments
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps remove their own appointments, admin any" on public.appointments
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

create view public.team_appointments with (security_invoker = true) as
  select a.client_id, a.tract, a.bbl, a.address, a.lat, a.lon, a.appt_at, a.note, a.created_at, r.name as rep
  from public.appointments a
  join public.reps r on r.id = a.rep_id;

revoke all on public.appointments, public.team_appointments from anon, authenticated;
grant select, insert, delete on public.appointments to authenticated;
grant select on public.team_appointments to authenticated;
