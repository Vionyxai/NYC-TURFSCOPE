-- TurfScope NYC — saved turfs: each rep's own queue of tracts to work, with an optional planned date.
-- Paste into Supabase → SQL Editor → Run, once.
--
--   saved_turfs    one row per rep per saved tract (saving again just updates the planned date)
--   tract_activity per tract: how much the team has done there (knocks, notes, pins, claim) and when last.
--                  The app calls a saved tract "working" when anything shows up here, else "queued".
--
-- Security: the team can see everyone's saved list (so you know what Matt has lined up);
-- you add, change and remove only your own.

create table public.saved_turfs (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  tract      text not null check (tract ~ '^[0-9]{11}$'),
  plan_date  date,                                   -- when the rep plans to work it (optional)
  saved_at   timestamptz not null default now(),
  unique (rep_id, tract)
);
create index saved_turfs_rep on public.saved_turfs (rep_id, plan_date);

alter table public.saved_turfs enable row level security;
create policy "team can see saved turfs" on public.saved_turfs
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps save turfs as themselves" on public.saved_turfs
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps change their own saved turfs" on public.saved_turfs
  for update to authenticated using (rep_id = public.my_rep_id()) with check (rep_id = public.my_rep_id());
create policy "reps remove their own saved turfs" on public.saved_turfs
  for delete to authenticated using (rep_id = public.my_rep_id());

create view public.team_saved_turfs with (security_invoker = true) as
  select s.client_id, s.tract, s.plan_date, s.saved_at, r.name as rep
  from public.saved_turfs s
  join public.reps r on r.id = s.rep_id;

-- Everything the team has done in each tract.
create view public.tract_activity with (security_invoker = true) as
  with k as (
    select tract, count(*) as knocked, max(knocked_at) as last_at
    from public.latest_knocks group by tract
  ), last_knock as (
    select distinct on (tract) tract, rep from public.latest_knocks order by tract, knocked_at desc
  ), n as (
    select tract, count(*) filter (where lat is null) as notes, count(*) filter (where lat is not null) as pins, max(noted_at) as last_at
    from public.team_notes where tract is not null group by tract
  ), last_note as (
    select distinct on (tract) tract, rep from public.team_notes where tract is not null order by tract, noted_at desc
  )
  select t.tract,
         coalesce(k.knocked, 0) as knocked,
         coalesce(n.notes, 0)   as notes,
         coalesce(n.pins, 0)    as pins,
         ts.status              as turf_status,
         ts.rep                 as turf_rep,
         greatest(k.last_at, n.last_at, case when ts.status <> 'open' then ts.set_at end) as last_at,
         case
           when k.last_at is not null and (n.last_at is null or k.last_at >= n.last_at) then lk.rep
           when n.last_at is not null then ln.rep
           else ts.rep
         end as last_rep
  from (select tract from k union select tract from n union select tract from public.turf_status where status <> 'open') t
  left join k on k.tract = t.tract
  left join last_knock lk on lk.tract = t.tract
  left join n on n.tract = t.tract
  left join last_note ln on ln.tract = t.tract
  left join public.turf_status ts on ts.tract = t.tract;

revoke all on public.saved_turfs, public.team_saved_turfs, public.tract_activity from anon, authenticated;
grant select, insert, update, delete on public.saved_turfs to authenticated;
grant select on public.team_saved_turfs, public.tract_activity to authenticated;
