# TurfScope NYC — Build Spec v0.2

Turf intelligence for door-to-door heat pump sales under NY Clean Heat.
For any piece of turf it answers four questions: where the homes are, how many, what income, how old. Every tract is tagged Con Edison or PSEG Long Island.

## What changed from v0.1

1. **The DAC list uses old tract lines.** It's published on 2010 census tracts; everything else uses 2020 tracts. We convert with the official Census 2020↔2010 tract relationship file. A 2020 tract counts as DAC when most of its land came from DAC tracts.
2. **"Electric" heat can't be split.** ACS lumps heat pumps and resistance heat together, so electric gets half weight instead of being treated as a top target.
3. **ACS counts apartments, not buildings.** Outside NYC, 1–4 unit buildings are estimated (a 2-unit building counts once, not twice). NYC uses actual lot counts from PLUTO.
4. **Utility tagging is rule-based.** County default, then Rockaway ZIPs flip to PSEG LI lot by lot. There's no dependency on a territory map we couldn't verify.
5. **DAC matters for PSEG LI too**, not just Con Ed.
6. **v1 is tract-level only.** Block groups, homeowner-exemption flags and DOB permit suppression move to v2.

---

## 1. Scope

- **Phase 1 (build now):** Queens and Brooklyn (address-level, Con Ed) + all of PSEG Long Island's territory: Nassau and Suffolk (tract-level) and the Rockaways
- **Phase 2:** Manhattan, Bronx, southern Westchester Sound shore (Yonkers → Port Chester)
- **Out:** Staten Island (for now), upstate, Connecticut

Two files control scope:
- `config/areas.json` — which counties, which phase
- `config/turf_boundary.geojson` — the hand-drawn edge. Covers all of Long Island out to Montauk and Orient Point (Fishers Island excluded — it has its own utility); White Plains is excluded.

**Utilities:**
- Con Edison: NYC except the Rockaways, plus Westchester
- PSEG LI: Nassau, Suffolk, and the Rockaway ZIPs (11691–11695, 11697)
- Village electric (not PSEG LI): Freeport, Rockville Centre and Greenport run their own electric utilities. Their boundaries come from TIGERweb Incorporated Places; a tract that's mostly inside one is tagged `muni`, and a partial overlap is flagged on the card. PSEG LI rebates may not apply there. List lives in `config/utilities.json → municipal_electric`.

**Target unit:** 1–4 family homes. 5+ unit buildings go through a separate multifamily program with a different buyer. They're counted on the card but never put on walk lists.

## 2. Outputs

**Tract heat map** (`m3-map/`, mobile-first, deploys to Vercel as static files)
- Fill color = TurfScore; border color = utility
- Filters: utility, DAC only, minimum score; a "Best turf" ranked list
- Oil focus: one tap = PSEG LI + 40%+ of homes heated with oil (ACS B25040), map colored by oil share, Best turf sorted by most oil. A Heating oil target group (25% / 40% / 60%+) and a "Color the map by: TurfScore / Oil %" switch are in the Target sheet. Thresholds live in `config/scoring.json → targeting` (`oil_bands`, `oil_focus`, `oil_color_breaks`).
- Target (rep picks any mix; none picked in a group = any): income band (tract median), home age (Before 1940 / 1940–79 / 1980–99 / 2000+: median year built of 1–4 family lots in NYC, ACS B25035 elsewhere; walk lists filter each house by its own year), homeowner age (rough estimate) (tracts where owners in the picked ages — Under 45 / 45–64 / 65+, ACS B25007 — are more common than turf-wide), house size (Small / Medium / Large: median building sq ft of 1–4 family lots from PLUTO in NYC, ACS median rooms B25018 elsewhere). Bands live in `config/scoring.json → targeting`.
- Live location: the locate button follows your GPS position and shows the tract you're standing in (score, utility). The position stays on the phone; nothing is sent or stored.
- Renters: every card shows owners / renters; tracts with ≥ 50% renter households get a renter-heavy badge. In NYC the card also counts 2–4 family homes (which have rental units) and homes with a business.
- Who lives here (tract card, Census ACS, neighborhood level only): languages spoken at home (B16001, falls back to C16001) with the share who speak English less than very well, share born abroad with the top countries of birth (B05006), and the race / Hispanic mix (B03002). Target has a **Language at home** group: tracts where a picked language is spoken by 15%+ of residents. The race mix is background only: never in the TurfScore, never a filter. No individual-level inference (e.g. guessing race from surnames) — that needs owner names, which the app never stores. Settings: `config/scoring.json → targeting.people`.
- Retired households and voting (tract card + Target): share of households with retirement income (25/35/45%+) and 2020 presidential Democratic share (50/60/70%+), bands in `config/scoring.json → targeting`. Both are neighborhood-level public statistics; nothing about any household or voter is stored (no voter files).
- Tapping a tract opens a card: homes, median income plus band, median year built, % pre-1980, % owner-occupied, heating fuel mix, DAC, and the score breakdown

**Walk lists** (Queens from NYC PLUTO; Nassau and Suffolk from the NYS assessment roll)
- Every 1–4 unit lot in the tract with a lot score
- Walking order: street, then one side of the street, then house number (handles Queens hyphenated addresses)
- Each house is tagged "rental unit" when it's a 2–4 family (owner usually rents the other units) and with the business type when a business operates there: an active NYC DCWP premises license on the lot (category only, no names), or a store/office recorded in the building (PLUTO class S*, commercial floor area). Single-family rentals can't be told apart from public data.
- On phone: list view, a map link per address, CSV download; distance to each home from your live location and a Nearest sort that re-sorts as you walk; the house size target filters lots by their own square footage
- Office copy: `exports/walklists_all.csv`

**Team tracking** (Supabase, `supabase/`)
- Logins: one Supabase account per rep, matched to the `reps` row by email
- Turf: any rep can Claim / Finish / Avoid / Open a tract; the map outlines claimed turf in the rep's color with their name; history kept in `turf_log`
- Notes: free-text team notes (≤ 280 chars) on a house, an area, or as a map pin; the whole team sees them with name and time; phone numbers and emails are refused
- Saved turfs: each rep saves tracts to their own list with an optional date (Today / Tomorrow / This week / a date / no date). The ★ Saved list splits them into Working turf (anyone has knocked, noted, pinned or claimed there) and Queued turf (untouched, sorted by planned date). Resume opens the walk list at the first un-knocked house after your own last knock. Mine / Team views. Stored in Supabase `saved_turfs` (`supabase/003_saved_turfs.sql`).
- My stuff: my claimed turf, my come-backs / interested houses, team numbers today; a Mine filter on the map
- Address search: 🔍 map button → NYS ITS address locator (official, free, no key; `config/sources.json → geocoder`). Picks a match, flies there, opens the tract card, and jumps to the nearest walk-list house (within `near_house_metres`). Needs signal; the typed address goes to the state locator only.
- Area tags (`supabase/005`): short team labels on a tract (≤ 40 chars, same no-phone/no-email rule as notes), one-tap suggestions in `config/team.json → tag_suggestions`. Field knowledge only, never Census-derived profiling.
- Team: Issac, Matt, Gio (admin), Kai (Kai Johnson replaced Cody: `supabase/004`) in `config/team.json` and the `reps` table
- Tap a house on a walk list → No answer / Come back (+ when: after 5pm, weekend, owner not home, wants info first) / Not interested / Interested / Booked; undo for 6 s from the toast, later from the house sheet
- Every knock is stamped with the rep; the team sees each other's so nobody double-knocks; "Hide done" hides Booked / Not interested
- Offline first: knocks save on the phone and sync when signal returns; a retry never double-saves (client-generated id)
- Tract cards show team progress; the account sheet shows today's scoreboard; the walk list CSV includes status, rep, time
- Security is in the database (RLS), not the app: logged-out or non-team logins see nothing; reps add knocks only as themselves, can't edit history, undo only their own; the admin can undo anyone's
- iPhone first: add to home screen (full screen, green pin icon), 16px inputs, 56px knock buttons, Apple Maps walking directions, screen stays awake while location tracking

## 3. Data sources

| Layer | Source | Notes |
|---|---|---|
| Lots | NYC PLUTO via NYC Open Data (`64uk-42ks`) | NYC only |
| Tract polygons | Census TIGERweb (current = 2020 tracts) | Layer found by name |
| Income | ACS 5-yr B19013 (median), B19001 (distribution) | |
| Heating fuel | ACS 5-yr B25040 | Electric = heat pump + resistance |
| Year built | ACS 5-yr B25034 (distribution), B25035 (median) | Pre-1980 decades detected from labels |
| Units in structure | ACS 5-yr B25024 | For home estimates outside NYC |
| Tenure | ACS 5-yr B25003 | |
| Homeowner age | ACS 5-yr B25007 | Owner households by age of householder |
| Languages at home | ACS 5-yr B16001 (or C16001) | Tract card + Language target |
| Born abroad / country of birth | ACS 5-yr B05006 | Tract card |
| Race / Hispanic origin | ACS 5-yr B03002 | Tract card only (background) |
| Retired households | ACS 5-yr B19059 (retirement income), B19055 (Social Security) | Tract card + Target filter (share of households with retirement income) |
| Voting, NYC | Official 2024 presidential results by election district (NYC BOE ED-level CSV) + NYC Planning election district map | Brooklyn and Queens. Harris = Democratic + Working Families, Trump = Republican + Conservative |
| Voting, Suffolk | Official 2024 presidential results by election district (Suffolk BOE fixed-width results file via OpenElections) + Suffolk County election district map (PRECINCTID) | All 1,070 districts match; decoded columns checked against the county totals in the file |
| Voting, Nassau | 2020 presidential results by precinct, NYT Upshot precinct map (MIT; official NY precincts) | Until Nassau/Suffolk 2024 district results + maps are wired in. The 2024 NYT file is non-commercial, so not used. Each tract uses the newest year covering its county; the card shows the year |
| Rooms | ACS 5-yr B25018 | Median rooms; house size outside NYC |
| DAC | data.ny.gov `2e6c-s6fp` (2010 tracts) | |
| Long Island homes | NYS ITS Tax Parcel Centroid Points (2025 roll) | Address + home type for every 1–3 family property; year built, sq ft and heating fuel where the town assessor reports them (parts of Suffolk). Owner names and mailing addresses are never requested |
| Home businesses | NYC DCWP licenses `w7w3-xahh` | Active Premises licenses only; category kept, nothing personal |
| Tract crosswalk | Census `tab20_tract20_tract10_st36.txt` | |

## 4. Scoring

**Tract TurfScore (0–100).** Each factor is scored 0–1 and multiplied by its weight. Weights live in `config/scoring.json`.

| Factor | Weight | Signal |
|---|---|---|
| Volume | 25 | log-scaled count of 1–4 unit homes (full marks at 800) |
| Fuel | 25 | weighted heating mix: oil / propane 1.0, electric 0.5, gas 0.25 |
| Age | 20 | share built before 1980 |
| Owner | 15 | owner-occupied share |
| Incentive | 15 | Con Ed: DAC. PSEG LI: half DAC, half share of households under $100k |

Income is shown as a band but deliberately not scored. Tune it once you know which bands actually close.

**Lot score** starts from the tract score, then:
- +10 for 1–2 family homes
- −10 for 3–4 family homes
- +10 if built before 1980
- Clamped to 0–100

## 5. Architecture

```
config/        areas · utilities · scoring · sources · turf_boundary.geojson
lib/           util.js (I/O, fetch+retry, CSV) · geo.js (point-in-polygon)
m1-ingest/     acs · tiger · pluto · dac → data/raw/          (network)
m2-score/      score.js (pure) · build-tracts.js → m3-map/data/tracts.geojson, summary.json
m3-map/        index.html (Leaflet, static) + data/
m4-walklists/  build.js → m3-map/data/walklists/*.json, exports/walklists_all.csv
m5-freshness/  planned n8n jobs (README only)
test/          offline end-to-end test on fixture data
```

Each module talks to the others only through files. Zero dependencies (Node ≥ 18.17). No database in v1; Supabase comes in v2 for knock tracking.

## 6. Build order

1. Phase 1 pipeline live: Queens + Nassau → map → Queens walk lists ✅ code written, needs first live run
2. Tune weights from real knocks
3. Phase 2 counties (flip `active_phase` to 2)
4. v2: block groups for Nassau/Suffolk; DOF homeowner-exemption flag; DOB permit suppression; Supabase knock status
5. m5 freshness jobs

## 7. Open questions

- ~~Nassau/Suffolk parcel data~~ answered: the NYS assessment roll is public statewide (see Data sources). Nassau has no year built or fuel; Suffolk has them for about 1 in 6 homes.
- **Broad Channel (11693).** Confirm it's PSEG LI; the whole ZIP is treated that way now.
- **Licensing.** NYC requires a Home Improvement Salesperson license (DCWP) for door-to-door home improvement sales; Nassau/Suffolk have their own rules and some towns require solicitor permits. Confirm with the shop.
- **Program numbers.** Reference only, in `config/utilities.json` with `last_verified`. Never shown as fixed amounts in the UI.
