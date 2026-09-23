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

- **Phase 1 (build now):** Queens (address-level) + all of PSEG Long Island's territory: Nassau and Suffolk (tract-level) and the Rockaways
- **Phase 2:** Brooklyn, Manhattan, Bronx, southern Westchester Sound shore (Yonkers → Port Chester)
- **Out:** Staten Island (for now), upstate, Connecticut

Two files control scope:
- `config/areas.json` — which counties, which phase
- `config/turf_boundary.geojson` — the hand-drawn edge. Covers all of Long Island out to Montauk and Orient Point (Fishers Island excluded — it has its own utility); White Plains is excluded.

**Utilities:**
- Con Edison: NYC except the Rockaways, plus Westchester
- PSEG LI: Nassau, Suffolk, and the Rockaway ZIPs (11691–11695, 11697)

**Target unit:** 1–4 family homes. 5+ unit buildings go through a separate multifamily program with a different buyer. They're counted on the card but never put on walk lists.

## 2. Outputs

**Tract heat map** (`m3-map/`, mobile-first, deploys to Vercel as static files)
- Fill color = TurfScore; border color = utility
- Filters: utility, DAC only, income band, minimum score; a "Best turf" ranked list
- Tapping a tract opens a card: homes, median income plus band, median year built, % pre-1980, % owner-occupied, heating fuel mix, DAC, and the score breakdown

**Walk lists** (NYC only in v1)
- Every 1–4 unit lot in the tract with a lot score
- Walking order: street, then one side of the street, then house number (handles Queens hyphenated addresses)
- On phone: list view, a map link per address, CSV download
- Office copy: `exports/walklists_all.csv`

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
| DAC | data.ny.gov `2e6c-s6fp` (2010 tracts) | |
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

- **Nassau/Suffolk parcel data.** Is it public? That decides whether LI ever gets address-level lists.
- **Broad Channel (11693).** Confirm it's PSEG LI; the whole ZIP is treated that way now.
- **Licensing.** NYC requires a Home Improvement Salesperson license (DCWP) for door-to-door home improvement sales; Nassau/Suffolk have their own rules and some towns require solicitor permits. Confirm with the shop.
- **Program numbers.** Reference only, in `config/utilities.json` with `last_verified`. Never shown as fixed amounts in the UI.
