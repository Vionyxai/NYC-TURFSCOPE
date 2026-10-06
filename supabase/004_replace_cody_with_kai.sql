-- 004: Cody leaves the team; Kai Johnson joins.
-- Cody's row stays (inactive) so his past knocks, claims and notes keep his name.
-- Inactive reps can't sign in to anything: every rule checks reps.active.
-- Run once in the Supabase SQL Editor. Safe to run twice.

update public.reps set active = false where name = 'Cody';

insert into public.reps (name, is_admin) values ('Kai', false)
on conflict (name) do update set active = true;

select name, email, is_admin, active from public.reps order by id;
