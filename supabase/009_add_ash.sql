-- 009: Ash joins the team (purple on the map).
-- Run once in the Supabase SQL Editor. Safe to run twice.

insert into public.reps (name, is_admin) values ('Ash', false)
on conflict (name) do update set active = true;

select name, email, is_admin, active from public.reps order by id;
