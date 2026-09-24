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

update reps set email = 'issac@x.com' where name = 'Issac';
update reps set email = 'matt@x.com'  where name = 'Matt';
update reps set email = 'gio@x.com'   where name = 'Gio';

do $$ begin
  assert (select count(*) from reps) = 4, 'four reps seeded';
  assert (select string_agg(name, ',' order by id) from reps) = 'Issac,Matt,Cody,Gio', 'rep names';
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

-- Issac sees the team's knocks but can't undo Matt's
select pg_temp.as_user('issac@x.com');
delete from knocks where client_id = '22222222-2222-2222-2222-222222222222';
insert into knocks (client_id,bbl,tract,status) values (gen_random_uuid(),'4012345678','36081019400','not_interested');
do $$ begin
  assert (select count(*) from knocks where client_id = '22222222-2222-2222-2222-222222222222') = 1, 'Issac cannot delete Matt''s knock';
  assert (select rep from latest_knocks where bbl = '4012345678') = 'Issac', 'Issac''s newer tap wins';
end $$;
reset role;

-- Cody has no login email yet: locked out
select pg_temp.as_user('cody@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'Cody locked out until email set'; end $$;
reset role;

-- Matt undoes his own
select pg_temp.as_user('matt@x.com');
delete from knocks where client_id = '22222222-2222-2222-2222-222222222222';
do $$ begin assert (select count(*) from knocks where client_id = '22222222-2222-2222-2222-222222222222') = 0, 'Matt undid his knock'; end $$;
reset role;

-- Gio (admin) can remove anyone's; scoreboard works
select pg_temp.as_user('gio@x.com');
delete from knocks where rep_id = (select id from reps where name = 'Issac');
do $$ begin
  assert (select count(*) from knocks where rep_id = (select id from reps where name = 'Issac')) = 0, 'admin removed Issac''s knock';
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
select pg_temp.as_user('issac@x.com');
insert into turf_log (client_id,tract,status) values (gen_random_uuid(),'36081019400','finished');   -- Issac can change Matt's area
delete from turf_log where client_id = '33333333-3333-3333-3333-333333333333';                       -- but can't erase Matt's claim
do $$ begin
  assert (select status from turf_status where tract = '36081019400') = 'finished', 'any rep can change area status';
  assert (select rep from turf_status where tract = '36081019400') = 'Issac', 'change credited to Issac';
  assert (select count(*) from turf_log where client_id = '33333333-3333-3333-3333-333333333333') = 1, 'Issac cannot erase Matt''s claim';
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
select pg_temp.as_user('issac@x.com');
delete from notes where client_id = '44444444-4444-4444-4444-444444444444';
do $$ begin
  assert (select count(*) from team_notes) = 3, 'team sees all notes';
  assert (select rep from team_notes where bbl = '4012345678') = 'Matt', 'note shows who wrote it';
  assert (select count(*) from team_notes where lat is not null) = 1, 'pins visible';
  assert (select count(*) from notes where client_id = '44444444-4444-4444-4444-444444444444') = 1, 'Issac cannot delete Matt''s note';
end $$;
reset role;
select pg_temp.as_user('gio@x.com');
delete from notes where client_id = '44444444-4444-4444-4444-444444444444';
do $$ begin assert (select count(*) from notes where client_id = '44444444-4444-4444-4444-444444444444') = 0, 'admin removed Matt''s note'; end $$;
reset role;

-- Someone leaves the team
update reps set active = false where name = 'Matt';
select pg_temp.as_user('matt@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'inactive rep locked out'; end $$;
reset role;

\o
\echo RLS tests passed: 4 reps; logged-out/stranger blocked; knocks, turf and notes posted only as yourself; anyone can change any status; no edits; retries safe; undo own; admin override; no phone/email in notes; inactive locked out
