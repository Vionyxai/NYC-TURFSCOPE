// m4 / NYC lot-level walk lists from PLUTO + scored tracts.
//   → m3-map/data/walklists/<geoid>.json, m3-map/data/walklists/index.json, exports/walklists_all.csv
import fs from 'node:fs';
import path from 'node:path';
import { config, readJSON, readJSONIfExists, writeJSON, writeText, raw, out, log, toCSV, EXPORT_DIR, isMain } from '../lib/util.js';
import { pointInFeatureCollection } from '../lib/geo.js';
import { lotScore, lotUtility } from '../m2-score/score.js';

// Sort key for NYC addresses, including Queens hyphenated numbers ("123-45 88 AVENUE").
// Walk order: street → one side of the street → house number.
export function addrKey(address) {
  const a = String(address || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const m = a.match(/^(\d+)(?:-(\d+))?[A-Z]?\s+(.+)$/);
  if (!m) return { street: a, side: 0, num: 0 };
  const hi = Number(m[1]);
  const lo = m[2] != null ? Number(m[2]) : null;
  return { street: m[3], side: (lo ?? hi) % 2, num: hi * 10000 + (lo ?? 0) };
}

export function compareLots(x, y) {
  const a = addrKey(x.address), b = addrKey(y.address);
  return a.street.localeCompare(b.street) || a.side - b.side || a.num - b.num;
}

function main() {
  const scoring = config('scoring.json');
  const util = config('utilities.json');
  const boundary = config('turf_boundary.geojson');
  const lots = readJSONIfExists(raw('pluto_lots.json'));
  if (!lots) { log('No PLUTO lots — skipping walk lists.'); return; }
  const tracts = readJSON(out('tracts.geojson'));
  const tractBy = new Map(tracts.features.map((f) => [f.properties.geoid, f.properties]));

  const groups = new Map();
  for (const l of lots) {
    if (l.units < 1 || l.units > 4) continue;
    const t = tractBy.get(l.tract);
    if (!t) continue;
    if (l.lat == null || l.lon == null || !pointInFeatureCollection([l.lon, l.lat], boundary)) continue;
    const row = {
      address: l.address,
      zip: l.zip,
      units: l.units,
      year: l.year,
      cls: l.cls,
      block: l.block,
      bbl: l.bbl,
      utility: lotUtility(l.zip, l.tract.slice(2, 5), util),
      score: lotScore(l, t.score, scoring.lot),
      lat: l.lat,
      lon: l.lon,
    };
    if (!groups.has(l.tract)) groups.set(l.tract, []);
    groups.get(l.tract).push(row);
  }

  const dir = out('walklists');
  fs.rmSync(dir, { recursive: true, force: true });
  const index = {};
  const all = [];
  for (const [geoid, rows] of groups) {
    rows.sort(compareLots);
    writeJSON(path.join(dir, `${geoid}.json`), rows);
    index[geoid] = rows.length;
    for (const r of rows) all.push({ tract: geoid, ...r });
  }
  writeJSON(path.join(dir, 'index.json'), index);
  writeText(
    path.join(EXPORT_DIR, 'walklists_all.csv'),
    toCSV(all, ['tract', 'address', 'zip', 'units', 'year', 'cls', 'block', 'bbl', 'utility', 'score', 'lat', 'lon']),
  );
  log(`Walk lists · ${groups.size} tracts · ${all.length} lots → m3-map/data/walklists/ + exports/walklists_all.csv`);
}

if (isMain(import.meta.url)) main();
export { main };
