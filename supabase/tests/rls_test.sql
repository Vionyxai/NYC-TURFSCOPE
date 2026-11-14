-- Checks every security rule in 001_team_tracking.sql. Test-only: run by scripts/test-sql.sh
-- against a throwaway local Postgres, never against the real Supabase project.
\set ON_ERROR_STOP 1
\o /dev/null

create function pg_temp.as_user(email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', email)::text, false);
  execute 'set role authenticated';
end $$;

create function pg_temp.fails(q text, why text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', why;
end $$;

update reps set email = 'ash@x.com' where name = 'Ash';
update reps set email = 'matt@x.com'  where name = 'Matt';
update reps set email = 'gio@x.com'   where name = 'Gio';

do $$ begin
  assert (select count(*) from reps) = 6, 'four seeded + Kai + Ash';
  assert (select string_agg(name, ',' order by id) from reps where active) = 'Matt,Gio,Kai,Ash', 'active reps after 004 and 009';
  assert (select not active from reps where name = 'Issac'), 'Issac deactivated, row kept so his login stays locked out';
  assert (select not active from reps where name = 'Cody'), 'Cody deactivated, row kept for history';
  assert (select name from reps where is_admin) = 'Gio', 'Gio is the only admin';
end $$;

-- Logged out: nothing
set role anon;
select pg_temp.fails('select 1 from knocks', 'anon read knocks');
select pg_temp.fails('select 1 from latest_knocks', 'anon read latest_knocks');
select pg_temp.fails('select 1 from team_notes', 'anon read notes');
select pg_temp.fails('select 1 from turf_status', 'anon read turf');
reset role;

-- Logged in but not on the team: nothing
select pg_temp.as_user('stranger@x.com');
do $$ begin assert (select count(*) from reps) = 0, 'stranger sees no reps'; end $$;
select pg_temp.fails($q$insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4012345678','36081019400','booked')$q$, 'stranger knock');
reset role;

-- Matt knocks (email case doesn't matter)
select pg_temp.as_user('MATT@x.com');
insert into knocks (client_id,bbl,tract,status,knocked_at) values ('11111111-1111-1111-1111-111111111111','4012345678','36081019400','no_answer', now() - interval '2 hours');
insert into knocks (client_id,bbl,tract,status,followup) values ('22222222-2222-2222-2222-222222222222','4012345678','36081019400','come_back','after_5pm');
insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4012345679','36081019400','booked');
insert into knocks (client_id,bbl,tract,status) values ('22222222-2222-2222-2222-222222222222','4012345678','36081019400','come_back') on conflict (client_id) do nothing;
select pg_temp.fails($q$insert into knocks (client_id,bbl,tract,status,rep_id) values (gen_random_uuid(),'4012345680','36081019400','booked',1)$q$, 'knock as someone else');
select pg_temp.fails($q$insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4012345680','36081019400','maybe')$q$, 'bad status');
select pg_temp.fails($q$insert into knocks (client_id,bbl,tract,status,followup) values (gen_random_uuid(),'4012345680','36081019400','come_back','call me at 555')$q$, 'free-text followup');
select pg_temp.fails($q$insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'12','36081019400','booked')$q$, 'bad bbl');
select pg_temp.fails($q$insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4012345678''; drop table knocks;--','36081019400','booked')$q$, 'junk lot id');
-- Long Island parcel IDs (002_long_island_ids.sql)
insert into knocks (client_id,bbl,tract,address,status) values (gen_random_uuid(),'472089 0100-012.000-0001-005.000','36103158506','57 SUNSET AV','booked');
insert into notes (client_id,tract,bbl,body) values (gen_random_uuid(),'36103158506','472089 0100-012.000-0001-005.000','Oil tank in the back yard');
delete from knocks where tract = '36103158506';
delete from notes where tract = '36103158506';
select pg_temp.fails($q$update knocks set status='booked'$q$, 'update');
select pg_temp.fails('truncate knocks', 'truncate');
select pg_temp.fails($q$update reps set is_admin = true where name = 'Matt'$q$, 'self-promote');
select pg_temp.fails($q$insert into reps (name) values ('Hacker')$q$, 'add rep');
do $$ begin
  assert (select count(*) from knocks) = 3, 'retry did not double-save';
  assert (select status from latest_knocks where bbl = '4012345678') = 'come_back', 'newest tap wins';
  assert (select rep from latest_knocks where bbl = '4012345678') = 'Matt', 'rep name on knock';
  assert (select knocked from tract_progress where tract = '36081019400') = 2, 'progress counts houses';
  assert (select booked from tract_progress where tract = '36081019400') = 1, 'progress counts booked';
end $$;
reset role;

-- Ash sees the team's knocks but can't undo Matt's
select pg_temp.as_user('ash@x.com');
delete from knocks where client_id = '22222222-2222-2222-2222-222222222222';
insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4012345678','36081019400','not_interested');
do $$ begin
  assert (select count(*) from knocks where client_id = '22222222-2222-2222-2222-222222222222') = 1, 'Ash cannot delete Matt''s knock';
  assert (select rep from latest_knocks where bbl = '4012345678') = 'Ash', 'Ash''s newer tap wins';
end $$;
reset role;

-- Kai has no login email yet: locked out
select pg_temp.as_user('kai@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'Kai locked out until email set'; end $$;
reset role;

-- Cody left (inactive): his old login sees nothing and can't post, even with his email still on file
update reps set email = 'cody@x.com' where name = 'Cody';
select pg_temp.as_user('cody@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'Cody (inactive) sees nothing'; end $$;
select pg_temp.fails($q$insert into knocks (client_id, tract, bbl, status) values (gen_random_uuid(), '36081000100', '4099999999', 'no_answer')$q$, 'inactive Cody posts a knock');
reset role;

-- Matt undoes his own
select pg_temp.as_user('matt@x.com');
delete from knocks where client_id = '22222222-2222-2222-2222-222222222222';
do $$ begin assert (select count(*) from knocks where client_id = '22222222-2222-2222-2222-222222222222') = 0, 'Matt undid his knock'; end $$;
reset role;

-- Gio (admin) can remove anyone's; scoreboard works
select pg_temp.as_user('gio@x.com');
delete from knocks where rep_id = (select id from reps where name = 'Ash');
do $$ begin
  assert (select count(*) from knocks where rep_id = (select id from reps where name = 'Ash')) = 0, 'admin removed Ash''s knock';
  assert (select booked from rep_stats where rep = 'Matt') = 1, 'rep_stats booked';
  assert (select count(*) from rep_stats) = 4, 'rep_stats lists the team';
end $$;
reset role;

-- ---------- Turf: who picked which tract; anyone can change any area's status ----------
select pg_temp.as_user('matt@x.com');
insert into turf_log (client_id,tract,status,set_at) values ('33333333-3333-3333-3333-333333333333','36081019400','claimed', now() - interval '1 hour');
select pg_temp.fails($q$insert into turf_log (client_id,tract,status,rep_id) values (gen_random_uuid(),'36081019400','claimed',(select id from reps where name='Gio'))$q$, 'claim as someone else');
select pg_temp.fails($q$insert into turf_log (client_id,tract,status) values (gen_random_uuid(),'36081019400','mine')$q$, 'bad turf status');
select pg_temp.fails($q$update turf_log set status='open'$q$, 'edit turf history');
do $$ begin
  assert (select rep from turf_status where tract = '36081019400') = 'Matt', 'Matt claimed it';
  assert (select turf_claimed from rep_stats where rep = 'Matt') = 1, 'rep_stats turf_claimed';
end $$;
reset role;
select pg_temp.as_user('ash@x.com');
insert into turf_log (client_id,tract,status) values (gen_random_uuid(),'36081019400','finished');   -- Ash can change Matt's area
delete from turf_log where client_id = '33333333-3333-3333-3333-333333333333';                       -- but can't erase Matt's claim
do $$ begin
  assert (select status from turf_status where tract = '36081019400') = 'finished', 'any rep can change area status';
  assert (select rep from turf_status where tract = '36081019400') = 'Ash', 'change credited to Ash';
  assert (select count(*) from turf_log where client_id = '33333333-3333-3333-3333-333333333333') = 1, 'Ash cannot erase Matt''s claim';
end $$;
reset role;

-- ---------- Notes and pins: team-visible, no contact details ----------
select pg_temp.as_user('matt@x.com');
insert into notes (client_id,tract,bbl,address,body) values ('44444444-4444-4444-4444-444444444444','36081019400','4012345678','138-04 109 AVENUE','Big dog, use side gate');
insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081019400','Block party Saturday, skip until Monday');
insert into notes (client_id,lat,lon,body) values (gen_random_uuid(),40.6870,-73.8071,'No soliciting sign at the corner');
select pg_temp.fails($q$insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081019400','call her at 718-555-1234')$q$, 'phone number in note');
select pg_temp.fails($q$insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081019400','call (718) 555 1234')$q$, 'phone number with parens');
select pg_temp.fails($q$insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081019400','email jo@gmail.com')$q$, 'email in note');
select pg_temp.fails($q$insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081019400',repeat('x',281))$q$, 'note too long');
select pg_temp.fails($q$insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081019400','   ')$q$, 'blank note');
select pg_temp.fails($q$insert into notes (client_id,body) values (gen_random_uuid(),'floating note')$q$, 'note attached to nothing');
select pg_temp.fails($q$insert into notes (client_id,lat,body) values (gen_random_uuid(),40.7,'half a pin')$q$, 'pin missing lon');
select pg_temp.fails($q$insert into notes (client_id,tract,body,rep_id) values (gen_random_uuid(),'36081019400','hi',(select id from reps where name='Gio'))$q$, 'note as someone else');
reset role;
select pg_temp.as_user('ash@x.com');
delete from notes where client_id = '44444444-4444-4444-4444-444444444444';
do $$ begin
  assert (select count(*) from team_notes) = 3, 'team sees all notes';
  assert (select rep from team_notes where bbl = '4012345678') = 'Matt', 'note shows who wrote it';
  assert (select count(*) from team_notes where lat is not null) = 1, 'pins visible';
  assert (select count(*) from notes where client_id = '44444444-4444-4444-4444-444444444444') = 1, 'Ash cannot delete Matt''s note';
end $$;
reset role;
select pg_temp.as_user('gio@x.com');
delete from notes where client_id = '44444444-4444-4444-4444-444444444444';
do $$ begin assert (select count(*) from notes where client_id = '44444444-4444-4444-4444-444444444444') = 0, 'admin removed Matt''s note'; end $$;
reset role;

-- ---------- Saved turfs (003) ----------
select pg_temp.as_user('matt@x.com');
insert into saved_turfs (client_id,tract,plan_date) values (gen_random_uuid(),'36081019400', current_date + 1);
insert into saved_turfs (client_id,tract) values (gen_random_uuid(),'36103158506');
-- saving again updates the date instead of duplicating
insert into saved_turfs (client_id,tract,plan_date) values (gen_random_uuid(),'36103158506', current_date + 7)
  on conflict (rep_id, tract) do update set plan_date = excluded.plan_date, client_id = excluded.client_id, saved_at = now();
select pg_temp.fails($q$insert into saved_turfs (client_id,tract,rep_id) values (gen_random_uuid(),'36081019400',(select id from reps where name='Gio'))$q$, 'save as someone else');
do $$ begin
  assert (select count(*) from team_saved_turfs where rep = 'Matt') = 2, 'Matt has two saved';
  assert (select plan_date from team_saved_turfs where tract = '36103158506') = current_date + 7, 'plan date updated';
  -- 019400 has team activity from the tests above (Matt's claim/Ash's finish, notes), 158506 has none
  assert (select count(*) from tract_activity where tract = '36081019400') = 1, 'activity for a worked tract';
  assert (select count(*) from tract_activity where tract = '36103158506') = 0, 'no activity for an untouched tract';
end $$;
reset role;
select pg_temp.as_user('ash@x.com');
update saved_turfs set plan_date = null;          -- can't touch Matt's (RLS: 0 rows)
delete from saved_turfs;                           -- can't remove Matt's
do $$ begin
  assert (select count(*) from team_saved_turfs where rep = 'Matt') = 2, 'Ash sees but cannot change Matt''s saved turfs';
  assert (select plan_date from team_saved_turfs where tract = '36103158506') is not null, 'Matt''s date untouched';
end $$;
reset role;
select pg_temp.as_user('matt@x.com');
delete from saved_turfs where tract = '36081019400';
do $$ begin assert (select count(*) from team_saved_turfs where rep = 'Matt') = 1, 'Matt removed his own'; end $$;
reset role;
set role anon;
select pg_temp.fails('select 1 from team_saved_turfs', 'anon read saved');
select pg_temp.fails('select 1 from tract_activity', 'anon read activity');
reset role;

-- Area tags: the team sees them with names; add only as yourself; remove own (admin any); no phone/email; short
select pg_temp.as_user('ash@x.com');
insert into area_tags (client_id, tract, label) values ('a1a1a1a1-0000-0000-0000-000000000001', '36047101200', 'Good weekend turf');
select pg_temp.fails($q$insert into area_tags (client_id, tract, label, rep_id) values (gen_random_uuid(), '36047101200', 'as Matt', (select id from reps where name = 'Matt'))$q$, 'tag as someone else');
select pg_temp.fails($q$insert into area_tags (client_id, tract, label) values (gen_random_uuid(), '36047101200', 'call 718-555-1234')$q$, 'phone in tag');
select pg_temp.fails($q$insert into area_tags (client_id, tract, label) values (gen_random_uuid(), '36047101200', repeat('x', 41))$q$, 'tag over 40 chars');
reset role;
select pg_temp.as_user('matt@x.com');
insert into area_tags (client_id, tract, label) values ('a1a1a1a1-0000-0000-0000-000000000002', '36047101200', 'Bring a Creole speaker');
delete from area_tags where client_id = 'a1a1a1a1-0000-0000-0000-000000000001';   -- not his: RLS removes 0 rows
do $$ begin
  assert (select string_agg(rep || ':' || label, ',' order by tagged_at, label) from team_tags where tract = '36047101200') like '%Ash:Good weekend turf%', 'Matt sees Ash''s tag with his name';
  assert (select count(*) from team_tags where tract = '36047101200') = 2, 'Matt could not remove Ash''s tag';
end $$;
reset role;
select pg_temp.as_user('gio@x.com');
delete from area_tags where client_id = 'a1a1a1a1-0000-0000-0000-000000000001';   -- admin may
do $$ begin assert (select count(*) from team_tags) = 1, 'admin removed a tag'; end $$;
reset role;
set role anon;
select pg_temp.fails('select 1 from team_tags', 'anon read tags');
reset role;

-- Appointments: team sees them with names; book only as yourself; remove own (admin any); no phone/email; LI parcel IDs ok
select pg_temp.as_user('matt@x.com');
insert into appointments (client_id, tract, bbl, address, lat, lon, appt_at, note)
  values ('b2b2b2b2-0000-0000-0000-000000000001', '36081019400', '4012345678', '138-04 109 AVENUE', 40.6871, -73.8072, now() + interval '2 days', 'Wants a quote for 3 heads');
insert into appointments (client_id, tract, bbl, address, lat, lon)
  values ('b2b2b2b2-0000-0000-0000-000000000002', '36103158506', '472089 0100-012.000-0001-005.000', '57 SUNSET AV', 40.6884, -73.4251);
select pg_temp.fails($q$insert into appointments (client_id, lat, lon, rep_id) values (gen_random_uuid(), 40.7, -73.8, (select id from reps where name = 'Ash'))$q$, 'appointment as someone else');
select pg_temp.fails($q$insert into appointments (client_id, lat, lon, note) values (gen_random_uuid(), 40.7, -73.8, 'call her 516 555 1234')$q$, 'phone in appointment note');
select pg_temp.fails($q$insert into appointments (client_id, lat, lon) values (gen_random_uuid(), 10, 10)$q$, 'appointment far outside NY');
reset role;
select pg_temp.as_user('ash@x.com');
delete from appointments;                                                    -- not his: RLS removes 0 rows
do $$ begin
  assert (select count(*) from team_appointments where rep = 'Matt') = 2, 'Ash sees Matt''s appointments and cannot remove them';
  assert (select note from team_appointments where bbl = '4012345678') = 'Wants a quote for 3 heads', 'note visible to the team';
end $$;
reset role;
-- Appointment outcomes: anyone on the team can update any appointment (stamped with them); newest wins;
-- delayed carries a new time; undo own (admin any); history kept; no phone/email in update notes
select pg_temp.as_user('ash@x.com');
insert into appointment_updates (client_id, appt, status, set_at) values ('c3c3c3c3-0000-0000-0000-000000000001', 'b2b2b2b2-0000-0000-0000-000000000001', 'sat', now() - interval '2 minutes');
reset role;
select pg_temp.as_user('matt@x.com');
insert into appointment_updates (client_id, appt, status, appt_at, note, set_at) values ('c3c3c3c3-0000-0000-0000-000000000002', 'b2b2b2b2-0000-0000-0000-000000000001', 'delayed', now() + interval '9 days', 'Wife wants to be there', now() - interval '1 minute');
select pg_temp.fails($q$insert into appointment_updates (client_id, appt, status) values (gen_random_uuid(), 'b2b2b2b2-0000-0000-0000-000000000001', 'maybe')$q$, 'unknown appointment status');
select pg_temp.fails($q$insert into appointment_updates (client_id, appt, status, note) values (gen_random_uuid(), 'b2b2b2b2-0000-0000-0000-000000000001', 'sat', 'text me 917 555 0000')$q$, 'phone in update note');
select pg_temp.fails($q$insert into appointment_updates (client_id, appt, status, rep_id) values (gen_random_uuid(), 'b2b2b2b2-0000-0000-0000-000000000001', 'closed', (select id from reps where name = 'Ash'))$q$, 'update as someone else');
delete from appointment_updates where client_id = 'c3c3c3c3-0000-0000-0000-000000000001';   -- Ash's: RLS removes 0 rows
do $$ begin
  assert (select status from team_appointments where client_id = 'b2b2b2b2-0000-0000-0000-000000000001') = 'delayed', 'newest change wins';
  assert (select status_rep from team_appointments where client_id = 'b2b2b2b2-0000-0000-0000-000000000001') = 'Matt', 'stamped with the rep';
  assert (select when_at > now() + interval '8 days' from team_appointments where client_id = 'b2b2b2b2-0000-0000-0000-000000000001'), 'delay moves the time';
  assert (select count(*) from appointment_history where appt = 'b2b2b2b2-0000-0000-0000-000000000001') = 2, 'history kept, Matt could not remove Ash''s update';
end $$;
delete from appointment_updates where client_id = 'c3c3c3c3-0000-0000-0000-000000000002';   -- undo own
do $$ begin assert (select status from team_appointments where client_id = 'b2b2b2b2-0000-0000-0000-000000000001') = 'sat', 'undo falls back to the previous status'; end $$;
reset role;
set role anon;
select pg_temp.fails('select 1 from appointment_history', 'anon read appointment history');
reset role;

select pg_temp.as_user('gio@x.com');
delete from appointments where client_id = 'b2b2b2b2-0000-0000-0000-000000000002';   -- admin may
do $$ begin assert (select count(*) from team_appointments) = 1, 'admin removed an appointment'; end $$;
reset role;
set role anon;
select pg_temp.fails('select 1 from team_appointments', 'anon read appointments');
reset role;

-- Results per rep per tract (008): doors count each house once, appointments with how far they got
select pg_temp.as_user('ash@x.com');
insert into knocks (client_id, bbl, tract, status) values
  (gen_random_uuid(), '3012340001', '36047101200', 'no_answer'),
  (gen_random_uuid(), '3012340001', '36047101200', 'interested'),
  (gen_random_uuid(), '3012340002', '36047101200', 'booked');
insert into appointments (client_id, tract, bbl, lat, lon) values ('d4d4d4d4-0000-0000-0000-000000000001', '36047101200', '3012340002', 40.65, -73.94);
insert into appointment_updates (client_id, appt, status) values (gen_random_uuid(), 'd4d4d4d4-0000-0000-0000-000000000001', 'closed');
do $$ begin
  assert (select doors from rep_tract_results where rep = 'Ash' and tract = '36047101200') = 2, 'doors = houses, not knocks';
  assert (select (appts, sat, closed, installed) = (1::bigint, 1::bigint, 1::bigint, 0::bigint) from rep_tract_results where rep = 'Ash' and tract = '36047101200'), 'closed counts as sat too';
  assert (select last_knock_at is not null from rep_tract_results where rep = 'Ash' and tract = '36047101200'), 'last knock time for the toes warning';
end $$;
reset role;
select pg_temp.as_user('matt@x.com');
do $$ begin assert (select count(*) from rep_tract_results where rep = 'Ash') >= 1, 'the team sees each other''s results'; end $$;
reset role;
set role anon;
select pg_temp.fails('select 1 from rep_tract_results', 'anon read rep results');
reset role;

-- 009: Issac leaves. Bring him back for a moment, let him enter one of everything, run 009 again
-- (it's safe to run twice) and check it's all gone and his areas are released.
update reps set active = true, email = 'issac@x.com' where name = 'Issac';
select pg_temp.as_user('matt@x.com');
insert into turf_log (client_id,tract,status,set_at) values (gen_random_uuid(),'36081000100','claimed', now() - interval '2 hours'), (gen_random_uuid(),'36081000400','claimed', now() - interval '2 hours');   -- Matt's, before Issac changes them
insert into appointments (client_id, tract, lat, lon) values ('9a9a9a9a-0000-0000-0000-000000000001','36081000100',40.70,-73.80);
insert into appointment_updates (client_id, appt, status, set_at) values (gen_random_uuid(),'9a9a9a9a-0000-0000-0000-000000000001','sat', now() - interval '1 hour');
reset role;
select pg_temp.as_user('issac@x.com');
insert into turf_log (client_id,tract,status) values (gen_random_uuid(),'36081000100','finished'), (gen_random_uuid(),'36081000200','claimed'), (gen_random_uuid(),'36081000300','avoid');
insert into turf_log (client_id,tract,status,set_at) values (gen_random_uuid(),'36081000400','open', now() + interval '1 minute');   -- releases Matt's claim (below)
insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4000100001','36081000200','booked');
insert into notes (client_id,tract,body) values (gen_random_uuid(),'36081000200','Area note from Issac');
insert into notes (client_id,lat,lon,body) values (gen_random_uuid(),40.71,-73.81,'Pin from Issac');
insert into area_tags (client_id, tract, label) values (gen_random_uuid(), '36081000200', 'Issac tag');
insert into saved_turfs (client_id,tract) values (gen_random_uuid(),'36081000200');
insert into appointments (client_id, tract, lat, lon) values ('9b9b9b9b-0000-0000-0000-000000000001','36081000200',40.70,-73.80);
insert into appointment_updates (client_id, appt, status) values (gen_random_uuid(),'9a9a9a9a-0000-0000-0000-000000000001','closed');   -- on Matt's appointment
reset role;
select pg_temp.as_user('matt@x.com');
insert into appointment_updates (client_id, appt, status) values (gen_random_uuid(),'9b9b9b9b-0000-0000-0000-000000000001','sat');      -- Matt's update on Issac's appointment
reset role;
do $$ begin
  assert (select count(*) from team_appointments where client_id = '9a9a9a9a-0000-0000-0000-000000000001' and status = 'closed') = 1, 'seed: Issac closed Matt''s appointment';
  assert (select count(*) from turf_log where rep_id = (select id from reps where name = 'Issac')) = 4, 'seed: Issac set 4 areas';
end $$;
\i supabase/009_replace_issac_with_ash.sql
do $$
declare iss smallint := (select id from reps where name = 'Issac');
begin
  assert (select count(*) from knocks where rep_id = iss) + (select count(*) from notes where rep_id = iss) + (select count(*) from area_tags where rep_id = iss)
       + (select count(*) from saved_turfs where rep_id = iss) + (select count(*) from appointments where rep_id = iss)
       + (select count(*) from appointment_updates where rep_id = iss) + (select count(*) from turf_log where rep_id = iss) = 0, 'nothing of Issac''s left';
  assert (select string_agg(tract || ':' || status || ':' || rep, ',' order by tract) from turf_status where tract in ('36081000100','36081000200','36081000300','36081000400'))
       = '36081000100:open:Gio,36081000200:open:Gio,36081000300:open:Gio,36081000400:open:Gio', 'his areas released to Open (not back to a claim he had finished or released)';
  assert (select count(*) from appointment_updates where appt = '9b9b9b9b-0000-0000-0000-000000000001') = 0, 'his appointment''s outcomes went with it';
  assert (select status from team_appointments where client_id = '9a9a9a9a-0000-0000-0000-000000000001') = 'sat', 'Matt''s appointment back to Matt''s own outcome';
  assert (select count(*) from turf_log where rep_id = (select id from reps where name = 'Matt') and tract in ('36081000100','36081000400')) = 2, 'Matt''s own rows untouched';
  assert (select not active from reps where name = 'Issac') and (select active from reps where name = 'Ash'), 'Issac out, Ash in';
end $$;
select pg_temp.as_user('issac@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'Issac locked out'; end $$;
reset role;

-- Someone leaves the team
update reps set active = false where name = 'Matt';
select pg_temp.as_user('matt@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'inactive rep locked out'; end $$;
reset role;

\o
\echo RLS tests passed: 4 active reps (Cody out, Kai in, Issac out and his entries removed, Ash in); logged-out/stranger blocked; knocks, turf and notes posted only as yourself; anyone can change any status; no edits; retries safe; undo own; admin override; no phone/email in notes or tags; area tags, appointments and their outcomes shared; per-rep results; inactive locked out
