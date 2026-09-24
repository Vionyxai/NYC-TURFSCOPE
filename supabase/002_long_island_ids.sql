-- TurfScope NYC — let knocks and notes use Long Island parcel IDs.
-- NYC houses use a 10-digit BBL; Long Island houses use the state's parcel ID
-- (e.g. "472089 0100-012.000-0001-005.000"). Paste into Supabase → SQL Editor → Run, once.
alter table public.knocks drop constraint knocks_bbl_check;
alter table public.knocks add constraint knocks_bbl_check
  check (bbl ~ '^[0-9A-Za-z][0-9A-Za-z ./-]{3,39}$');

alter table public.notes drop constraint notes_bbl_check;
alter table public.notes add constraint notes_bbl_check
  check (bbl is null or bbl ~ '^[0-9A-Za-z][0-9A-Za-z ./-]{3,39}$');
