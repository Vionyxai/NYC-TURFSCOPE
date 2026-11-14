-- 009: Issac leaves the team; Ash joins (and takes Issac's purple on the map).
-- Unlike Cody (004), everything Issac entered is removed, and every area he had is released
-- back to Open so the team can claim and save it:
--   turf     every area where he made the last change (claimed / finished / avoid / open) → Open, stamped by Gio
--   gone     his knocks, house and area notes, pins, area tags, saved turfs, appointments
--            (with their outcomes) and the outcome updates he made on teammates' appointments
-- His rep row stays, inactive, so his login is locked out (every rule checks reps.active).
-- Run once in the Supabase SQL Editor. Safe to run twice. This can't be undone.

begin;

-- Release his areas first, so an area doesn't fall back to an older claim (one he may have released) once his rows are gone.
insert into public.turf_log (client_id, tract, status, rep_id)
select gen_random_uuid(), t.tract, 'open', (select id from public.reps where name = 'Gio')
from (select distinct on (tract) tract, status, rep_id from public.turf_log order by tract, set_at desc, id desc) t
where t.rep_id = (select id from public.reps where name = 'Issac');

delete from public.turf_log           where rep_id = (select id from public.reps where name = 'Issac');
delete from public.appointments       where rep_id = (select id from public.reps where name = 'Issac');   -- their outcomes go with them
delete from public.appointment_updates where rep_id = (select id from public.reps where name = 'Issac'); -- his updates on teammates' appointments
delete from public.knocks             where rep_id = (select id from public.reps where name = 'Issac');
delete from public.notes              where rep_id = (select id from public.reps where name = 'Issac');   -- house notes, area notes and pins
delete from public.area_tags          where rep_id = (select id from public.reps where name = 'Issac');
delete from public.saved_turfs        where rep_id = (select id from public.reps where name = 'Issac');

update public.reps set active = false where name = 'Issac';

insert into public.reps (name, is_admin) values ('Ash', false)
on conflict (name) do update set active = true;

commit;

select name, email, is_admin, active from public.reps order by id;
