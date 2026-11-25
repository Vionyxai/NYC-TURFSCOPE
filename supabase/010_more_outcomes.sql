-- 010: two more appointment outcomes: "Sat, didn't sign" and "Credit fail".
-- Both mean the appointment sat, so they count as sits in the per-rep results (008) that feed My fit.
-- The statuses must match config/team.json → appointment_statuses (npm test checks).
-- Run once in the Supabase SQL Editor. Safe to run twice. Nothing is deleted.

alter table public.appointment_updates drop constraint if exists appointment_updates_status_check;
alter table public.appointment_updates add constraint appointment_updates_status_check
  check (status in ('scheduled', 'sat', 'sat_no_sign', 'credit_fail', 'closed', 'delayed', 'canceled', 'installed'));

create or replace view public.rep_tract_results with (security_invoker = true) as
  with k as (
    select r.name as rep, kn.tract, count(distinct kn.bbl) as doors, max(kn.knocked_at) as last_knock_at
    from public.knocks kn
    join public.reps r on r.id = kn.rep_id
    group by r.name, kn.tract
  ), a as (
    select ta.rep, ta.tract,
           count(*)                                                                                            as appts,
           count(*) filter (where ta.status in ('sat', 'sat_no_sign', 'credit_fail', 'closed', 'installed'))  as sat,
           count(*) filter (where ta.status in ('closed', 'installed'))                                       as closed,
           count(*) filter (where ta.status = 'installed')                                                    as installed
    from public.team_appointments ta
    where ta.tract is not null
    group by ta.rep, ta.tract
  )
  select coalesce(k.rep, a.rep)     as rep,
         coalesce(k.tract, a.tract) as tract,
         coalesce(k.doors, 0)       as doors,
         k.last_knock_at,
         coalesce(a.appts, 0)       as appts,
         coalesce(a.sat, 0)         as sat,
         coalesce(a.closed, 0)      as closed,
         coalesce(a.installed, 0)   as installed
  from k
  full join a on a.rep = k.rep and a.tract = k.tract;

revoke all on public.rep_tract_results from anon, authenticated;
grant select on public.rep_tract_results to authenticated;
