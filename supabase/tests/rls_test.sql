-- Checks every security rule in 001_knock_tracking.sql. Test-only: run by scripts/test-sql.sh
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

-- Someone leaves the team
update reps set active = false where name = 'Matt';
select pg_temp.as_user('matt@x.com');
do $$ begin assert (select count(*) from knocks) = 0, 'inactive rep locked out'; end $$;
reset role;

\o
\echo RLS tests passed: 4 reps, logged-out/stranger blocked, own-name knocks only, no edits, retries safe, undo own, admin override, inactive locked out
