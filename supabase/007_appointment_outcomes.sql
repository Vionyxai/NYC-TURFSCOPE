-- TurfScope NYC — appointment outcomes: what happened after an appointment was pinned
-- (Sat, Closed, Delayed to a new time, Canceled, Installed). Paste into Supabase → SQL Editor → Run, once.
--
-- Same idea as house knocks and turf: every change is a new row stamped with the rep who made it
-- (nothing is edited in place, so the history stays), the newest change wins, any rep can update
-- any appointment, and you can undo only your own change (Gio, the admin, any).
-- The statuses must match config/team.json → appointment_statuses (npm test checks).

create table public.appointment_updates (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  appt       uuid not null references public.appointments (client_id) on delete cascade,
  status     text not null check (status in ('scheduled', 'sat', 'closed', 'delayed', 'canceled', 'installed')),
  appt_at    timestamptz,                                         -- the new time, when delayed / rescheduled
  note       text check (note is null or (char_length(btrim(note)) between 1 and 280 and public.clean_note(note))),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  set_at     timestamptz not null default now()
);
create index appointment_updates_appt on public.appointment_updates (appt, set_at desc, id desc);

alter table public.appointment_updates enable row level security;
create policy "team can see appointment updates" on public.appointment_updates
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps update appointments as themselves" on public.appointment_updates
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps undo their own updates, admin any" on public.appointment_updates
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

-- Every change, with names (for the history on the appointment).
create view public.appointment_history with (security_invoker = true) as
  select u.client_id, u.appt, u.status, u.appt_at, u.note, u.set_at, r.name as rep
  from public.appointment_updates u
  join public.reps r on r.id = u.rep_id;

-- The appointments the app reads, now with where each one stands. New columns go at the end
-- so the existing view can be replaced in place.
create or replace view public.team_appointments with (security_invoker = true) as
  select a.client_id, a.tract, a.bbl, a.address, a.lat, a.lon, a.appt_at, a.note, a.created_at, r.name as rep,
         coalesce(lu.status, 'scheduled')                                   as status,
         lu.set_at                                                          as status_at,
         lu.rep                                                             as status_rep,
         coalesce(lt.appt_at, a.appt_at)                                    as when_at   -- current time (after any delay)
  from public.appointments a
  join public.reps r on r.id = a.rep_id
  left join lateral (
    select u.status, u.set_at, ur.name as rep from public.appointment_updates u join public.reps ur on ur.id = u.rep_id
    where u.appt = a.client_id order by u.set_at desc, u.id desc limit 1
  ) lu on true
  left join lateral (
    select u.appt_at from public.appointment_updates u
    where u.appt = a.client_id and u.appt_at is not null order by u.set_at desc, u.id desc limit 1
  ) lt on true;

revoke all on public.appointment_updates, public.appointment_history from anon, authenticated;
grant select, insert, delete on public.appointment_updates to authenticated;
grant select on public.appointment_history, public.team_appointments to authenticated;
