-- TurfScope NYC — results per rep per tract, for each rep's personal turf map ("My fit").
-- Paste into Supabase → SQL Editor → Run, once. Needs 006 and 007 first.
--
--   rep_tract_results  one row per rep per tract they've worked: doors they knocked (each house
--                      once), their last knock there, and the appointments they booked there with
--                      how far each got (sat / closed / installed).
--
-- The app learns from these which kinds of turf work for each rep, and uses last_knock_at to warn
-- reps before they work turf a teammate knocked recently. Like everything else, the whole team
-- can read it; nobody can read it logged out.

create view public.rep_tract_results with (security_invoker = true) as
  with k as (
    select r.name as rep, kn.tract, count(distinct kn.bbl) as doors, max(kn.knocked_at) as last_knock_at
    from public.knocks kn
    join public.reps r on r.id = kn.rep_id
    group by r.name, kn.tract
  ), a as (
    select ta.rep, ta.tract,
           count(*)                                                        as appts,
           count(*) filter (where ta.status in ('sat', 'closed', 'installed')) as sat,
           count(*) filter (where ta.status in ('closed', 'installed'))      as closed,
           count(*) filter (where ta.status = 'installed')                  as installed
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
