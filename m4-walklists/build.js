// m4 / house-by-house walk lists for every tract that has address data.
//   NYC:          PLUTO lots (data/raw/pluto_lots.json), already tagged with their tract
//   Long Island:  NYS assessment roll (data/raw/li_parcels.json), placed in tracts here by location
//   → m3-map/data/walklists/<geoid>.json (compact), m3-map/data/walklists/index.json, exports/walklists_all.csv
import fs from 'node:fs';
import path from 'node:path';
import { config, readJSON, readJSONIfExists, writeJSON, writeText, raw, out, log, toCSV, EXPORT_DIR, isMain } from '../lib/util.js';
import { pointInFeatureCollection, pointInGeometry, bbox } from '../lib/geo.js';
import { lotScore, lotUtility, sizeBand, homeAgeBand, lotBusiness } from '../m2-score/score.js';

// Sort key for addresses, including Queens hyphenated numbers ("123-45 88 AVENUE").
// Walk order: street → one side of the street → house number.
export function addrKey(address) {
  const a = String(address || '').trim().toUpperCase().replace(/\s+/g, ' ');
  // Optional " 1/2" after the number ("111-30 1/2 145 STREET") belongs to the house number, not the street.
  const m = a.match(/^(\d+)(?:-(\d+))?[A-Z]?(\s+1\/2)?\s+(.+)$/);
  if (!m) return { street: a, side: 0, num: 0 };
  const hi = Number(m[1]);
  const lo = m[2] != null ? Number(m[2]) : null;
  return { street: m[4], side: (lo ?? hi) % 2, num: hi * 10000 + (lo ?? 0) + (m[3] ? 0.5 : 0) };
}

export function compareLots(x, y) {
  const a = addrKey(x.address), b = addrKey(y.address);
  return a.street.localeCompare(b.street) || a.side - b.side || a.num - b.num;
}

// Walk-list files are a column list plus rows of values, about 3x smaller than one object per house.
// The map turns them back into objects (m3-map/index.html → unpackWalk).
export const WALK_COLS = ['address', 'zip', 'town', 'units', 'year', 'sqft', 'size', 'age', 'rental', 'biz', 'fuel', 'heat',
  'cls', 'bbl', 'utility', 'score', 'lat', 'lon'];
export function packWalk(rows) {
  return { v: 1, cols: WALK_COLS, rows: rows.map((r) => WALK_COLS.map((c) => {
    const v = r[c];
    if (v === undefined || v === '' || v === false) return null;
    if (v === true) return 1;
    if ((c === 'lat' || c === 'lon') && typeof v === 'number') return Math.round(v * 1e5) / 1e5; // ~1 m
    return v;
  })) };
}
const YES_NO = new Set(['rental']);        // stored as 1 / null
export function unpackWalk(file) {
  if (Array.isArray(file)) return file; // old format: one object per house
  return file.rows.map((r) => Object.fromEntries(file.cols.map((c, i) => [c, YES_NO.has(c) ? r[i] === 1 : r[i]])));
}

// Finds which scored tract a point is in, using a coarse grid so 800k houses stay fast.
export function tractLocator(features, cell = 0.02) {
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const f of features) {
    const [x0, y0, x1, y1] = bbox(f.geometry);
    for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) {
      for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) {
        const k = `${x},${y}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(f);
      }
    }
  }
  return (lon, lat) => {
    for (const f of grid.get(key(lon, lat)) || []) if (pointInGeometry([lon, lat], f.geometry)) return f.properties;
    return null;
  };
}

function main() {
  const scoring = config('scoring.json');
  const util = config('utilities.json');
  const boundary = config('turf_boundary.geojson');
  const tracts = readJSON(out('tracts.geojson'));
  const tractBy = new Map(tracts.features.map((f) => [f.properties.geoid, f.properties]));
  const bizByBbl = readJSONIfExists(raw('business_by_bbl.json')) || {};
  const tg = scoring.targeting || {};
  const groups = new Map();
  const add = (geoid, row) => { if (!groups.has(geoid)) groups.set(geoid, []); groups.get(geoid).push(row); };

  // ---------- NYC (PLUTO) ----------
  const lots = readJSONIfExists(raw('pluto_lots.json')) || [];
  for (const l of lots) {
    if (l.units < 1 || l.units > 4) continue;
    const t = tractBy.get(l.tract);
    if (!t) continue;
    if (l.lat == null || l.lon == null || !pointInFeatureCollection([l.lon, l.lat], boundary)) continue;
    add(l.tract, {
      address: l.address,
      zip: l.zip,
      units: l.units,
      year: l.year,
      sqft: l.sqft ?? null,
      size: sizeBand(l.sqft, 'sqft', tg.size_bands),
      age: homeAgeBand(l.year, tg.home_age_bands),
      rental: l.units >= 2, // 2–4 family: owner usually lives in one unit and rents the others
      biz: lotBusiness(l, bizByBbl[l.bbl]),
      cls: l.cls,
      bbl: l.bbl,
      utility: lotUtility(l.zip, l.tract.slice(2, 5), util),
      score: lotScore(l, t.score, scoring.lot),
      lat: l.lat,
      lon: l.lon,
    });
  }

  // ---------- Long Island (NYS assessment roll) ----------
  const li = readJSONIfExists(raw('li_parcels.json')) || [];
  let liKept = 0, liOil = 0;
  if (li.length) {
    const liFeatures = tracts.features.filter((f) => ['059', '103'].includes(f.properties.county));
    const locate = tractLocator(liFeatures);
    const muniCfg = util.municipal_electric || { places: [] };
    const villages = (readJSONIfExists(raw('muni_places.json'))?.features || []).filter((f) => f.geometry);
    for (const l of li) {
      const t = locate(l.lon, l.lat);
      if (!t) continue;                     // outside every scored tract (parks, water, tiny tracts)
      const inVillage = villages.some((v) => pointInGeometry([l.lon, l.lat], v.geometry));
      add(t.geoid, {
        address: l.address,
        zip: l.zip,
        town: l.town,
        units: l.units,
        year: l.year,
        sqft: l.sqft,
        size: sizeBand(l.sqft, 'sqft', tg.size_bands),
        age: homeAgeBand(l.year, tg.home_age_bands),
        rental: l.units >= 2,
        biz: l.biz ? 'Store/office on site' : null,
        fuel: l.fuel,
        heat: l.heat,
        cls: l.cls,
        bbl: l.id,                          // the state's parcel ID; used as the house key for knocks and notes
        utility: inVillage ? muniCfg.utility : util.county_default[t.county],
        score: lotScore(l, t.score, scoring.lot),
        lat: l.lat,
        lon: l.lon,
      });
      liKept++;
      if (l.fuel === 'oil') liOil++;
    }
  }

  if (!groups.size) { log('No lot data — skipping walk lists.'); return; }
  const dir = out('walklists');
  fs.rmSync(dir, { recursive: true, force: true });
  const index = {};
  const all = [];
  for (const [geoid, rows] of groups) {
    rows.sort(compareLots);
    writeJSON(path.join(dir, `${geoid}.json`), packWalk(rows));
    index[geoid] = rows.length;
    for (const r of rows) all.push({ tract: geoid, ...r });
  }
  writeJSON(path.join(dir, 'index.json'), index);
  writeText(
    path.join(EXPORT_DIR, 'walklists_all.csv'),
    toCSV(all, ['tract', 'address', 'zip', 'town', 'units', 'rental', 'biz', 'fuel', 'heat', 'year', 'age', 'sqft', 'size', 'cls', 'bbl', 'utility', 'score', 'lat', 'lon']),
  );
  log(`Walk lists · ${groups.size} tracts · ${all.length} homes (Long Island ${liKept}, oil on record ${liOil}) → m3-map/data/walklists/ + exports/walklists_all.csv`);
}

if (isMain(import.meta.url)) main();
export { main };
