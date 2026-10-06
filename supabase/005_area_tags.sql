-- TurfScope NYC — area tags: short labels reps put on a tract for the team
-- ("Good weekend turf", "Bring a Creole speaker", "Lots of dogs"). Field knowledge, not Census data.
-- Paste into Supabase → SQL Editor → Run, once.
--
-- Same rules as notes: the team sees every tag with who added it; you add tags only as
-- yourself; you remove only your own (Gio, the admin, can remove any). Tags can't hold
-- phone numbers or emails (clean_note), and stay short (40 characters).

create table public.area_tags (
  id         bigint generated always as identity primary key,
  client_id  uuid not null unique,
  tract      text not null check (tract ~ '^[0-9]{11}$'),
  label      text not null check (char_length(btrim(label)) between 1 and 40 and public.clean_note(label)),
  rep_id     smallint not null default public.my_rep_id() references public.reps (id),
  tagged_at  timestamptz not null default now()
);
create index area_tags_tract on public.area_tags (tract, tagged_at);

alter table public.area_tags enable row level security;
create policy "team can see area tags" on public.area_tags
  for select to authenticated using (public.my_rep_id() is not null);
create policy "reps tag areas as themselves" on public.area_tags
  for insert to authenticated with check (rep_id = public.my_rep_id());
create policy "reps remove their own tags, admin any" on public.area_tags
  for delete to authenticated using (rep_id = public.my_rep_id() or public.i_am_admin());

create view public.team_tags with (security_invoker = true) as
  select t.client_id, t.tract, t.label, t.tagged_at, r.name as rep
  from public.area_tags t
  join public.reps r on r.id = t.rep_id;

revoke all on public.area_tags, public.team_tags from anon, authenticated;
grant select, insert, delete on public.area_tags to authenticated;
grant select on public.team_tags to authenticated;
