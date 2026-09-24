# CLAUDE.md — TurfScope NYC

You're working on TurfScope NYC: a turf-mapping tool for door-to-door heat pump sales under NY Clean Heat. The owner is Giovani, a self-taught builder who knocks doors himself. He wants to understand what's being built, not just have it built. Explain decisions in plain language, keep changes modular, and show full files when you change something substantial.

Read `SPEC.md` before making product decisions. This file covers how to work in the repo.

## Commands

```bash
npm test            # offline end-to-end test on fixture data — run after every change
npm run ingest      # m1: pull ACS, TIGER, PLUTO, DAC → data/raw/   (needs network)
npm run score       # m2: data/raw → m3-map/data/tracts.geojson + summary.json
npm run walklists   # m4: NYC lot walk lists → m3-map/data/walklists/ + exports/
npm run pipeline    # all three in order
npm run dev         # serve the map at http://localhost:3000
npm run app-config  # config/supabase.json + team.json → m3-map/data/app.json (knock tracking on/off)
npm run test:sql    # Supabase migration + RLS security tests on a throwaway local Postgres
```

Keys go in `.env` (see `.env.example`). `CENSUS_API_KEY` is required (the Census data API rejects keyless requests); `NYC_APP_TOKEN` is optional. Node doesn't read `.env` on its own, so either export the variables in the shell or run with `node --env-file=.env` (Node 20.6+).

## Rules

- **Zero dependencies.** Node ≥ 18.17 built-ins only (global `fetch`, `node:fs`, `node:assert`). The map loads Leaflet from cdnjs. Don't add npm packages without asking Giovani first.
- **Modules only talk through files.** m1 writes `data/raw/`. m2 reads raw and writes `m3-map/data/`. m4 reads raw + m2 output. m3 is static HTML reading `m3-map/data/`. Don't import across modules, except the pure functions in `m2-score/score.js` and `lib/`.
- **Tunable numbers belong in `config/`**, never in code: weights, thresholds, ZIPs, counties, endpoints, the boundary.
- **Never hardcode rebate dollar amounts in the UI.** They change. Reference notes live in `config/utilities.json` with `last_verified`.
- **Keep scoring pure.** `m2-score/score.js` has no I/O. Add a test in `test/run.js` for any scoring change.
- **Mobile first.** Every map change must work one-handed on a phone. Test at 390px wide.
- **Don't store personal data.** Walk lists are addresses and building facts only. Don't add owner names or phone numbers. Team notes are free text (≤ 280 chars) because Giovani wants reps to coordinate; the database (`clean_note`) and the app (`noteProblem` in `m3-map/team.js`) both refuse phone numbers and emails. Keep those two rules identical (`npm test` checks).
- **iPhone first.** The team runs this as a home-screen app in iPhone Safari. Inputs ≥ 16px (smaller zooms the page), tap targets ≥ 44px, respect safe areas, test at 375px (SE) and 393px (iPhone 15).
- **Team tracking.** `config/team.json` (reps + map colors, knock statuses, follow-ups, turf statuses) must match `supabase/001_team_tracking.sql`; `npm test` checks. Every rep sees everything and can change any house or area status; entries are stamped with the rep; undo only your own (admin: any). Schema changes go in a new numbered SQL file in `supabase/` with tests in `supabase/tests/rls_test.sql`. The app only ever gets the publishable key; never the service_role/secret key.

## First live run — verify these (they couldn't be checked when the repo was generated)

Run `npm run ingest` and work through any failures in this order:

1. **ACS vintage.** `config/sources.json → acs.years_to_try` starts at 2024. If the 2024 5-year isn't live, it falls back to 2023 automatically. Check the log line `ACS <year> 5-year`.
2. **TIGERweb layer.** The code finds the layer named `Census Tracts` in `tigerWMS_ACS<year>` (same year as the ACS data, so tract lines match), falling back to `tigerWMS_Current`. Check the log line `TIGER · using …`. If it errors, the message lists the available layer names; update `tract_layer_name`. Also confirm `f=geojson` and pagination work on that service. If they don't, switch to `f=json` and convert the rings.
3. **PLUTO fields.** The Socrata query selects `bct2020`. If the API returns 400 "no such column", check the current field list for dataset `64uk-42ks` and update `sources.json → pluto.fields` and `plutoTractGeoid()` in `m1-ingest/pluto.js`. Also confirm `bct2020` is borough digit + 6-digit tract (e.g. `4012300`). The unit test assumes that.
4. **DAC fields.** Auto-detects a `geoid` column and a designation column. Check the log line `DAC · N tracts (M DAC) · fields X / Y`. NY has 1,736 DAC tracts statewide; if M is 0 or ~4,900, detection is wrong — set `dac.geoid_field` / `dac.dac_field` explicitly.
5. **Tract crosswalk.** Confirm the Census relationship file URL downloads. If it doesn't, DAC only matches tracts whose GEOID didn't change (you'll see a warning).
6. **Sanity check the output.**
   - `m3-map/data/summary.json` should show Queens ≈ 700 tracts, Nassau ≈ 280 and Suffolk ≈ 320 (roughly — confirm, don't force).
   - The Rockaways should show as PSEG LI.
   - Spot-check 3 tracts you know against the NYSERDA DAC map.

Report what you changed and why after the first run.

## Deploying (GitHub → Vercel)

- `vercel.json` serves `m3-map/` as a static site. There's no build step on Vercel; the data is generated locally and committed.
- Commit `m3-map/data/` (the generated map data). `data/raw/` and `exports/` are gitignored.
- If `m3-map/data/walklists/` gets too big for comfort (>50 MB), switch to one JSON per borough-block or move lots to Supabase (planned for v2). Ask first.
- The deployed map is public to anyone with the URL. If Giovani wants it private, add Vercel password protection or a simple auth gate — ask which.

## Backlog (in order)

1. First live run + verification above
2. Tune `config/scoring.json` from real knock results (Giovani will supply)
3. Phase 2: set `areas.json → active_phase: 2` (Brooklyn, Manhattan, Bronx, southern Westchester). Suffolk moved into phase 1 so all PSEG LI territory is covered.
4. Nassau/Suffolk block-group scoring (ACS supports it; TIGERweb has a block group layer)
5. ~~Knock tracking~~ built, plus turf claims, notes and pins: `supabase/` (SQL + setup guide), `m3-map/team.js`. Needs the Supabase project URL + publishable key in `config/supabase.json`.
6. `m5-freshness/` n8n jobs (see its README)

## Glossary

- **Clean Heat:** NY's utility-run heat pump incentive program. Con Ed and PSEG LI each run their own version.
- **DAC:** Disadvantaged Community census tract (NY Climate Justice Working Group). Higher incentives there.
- **PLUTO:** NYC's tax lot dataset. One row per lot, with year built, units, building class, coordinates.
- **BBL:** borough-block-lot, NYC's unique lot ID.
- **ACS:** American Community Survey 5-year estimates from the Census.
