// m1 / Elections, NYC: official 2024 presidential results by election district (NYC Board of Elections)
// joined to the city's election district map (NYC Planning) → data/raw/precincts_nyc.json
// Long Island stays on the statewide 2020 file (elections.js) until Nassau/Suffolk 2024 district data is wired in.
import { config, fetchWithRetry, writeJSON, raw, log, warn, activeCounties, isMain } from '../lib/util.js';
import { roundGeometry } from '../lib/geo.js';

const BOROUGH_COUNTY = { 'New York': '061', Bronx: '005', Kings: '047', Queens: '081', Richmond: '085' };

// One CSV line → fields (handles quotes and commas inside quotes, e.g. "1,149").
export function csvFields(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// The BOE "EDLevel" file: every line repeats the 11 column names, then the 11 values.
// Candidate lines name the party in brackets ("Kamala D. Harris / Tim Walz (Democratic)");
// ballot-count lines (Public Counter, Absentee / Military, Affidavit, ...) are not votes and are skipped.
// Returns Map(ElectDist = AD*1000 + ED → { county, dem, rep, total }).
export function parseEdResults(text, { dem_parties, rep_parties }, counties) {
  const dem = new Set(dem_parties), rep = new Set(rep_parties);
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = csvFields(line);
    const v = f.length >= 22 ? f.slice(11) : f;
    if (v[0] === 'AD' || v.length < 11) continue;
    const county = BOROUGH_COUNTY[v[2]];
    if (!counties.has(county)) continue;
    const unit = v[9] || '';
    const n = Number(String(v[10]).replace(/,/g, '')) || 0;
    const party = (unit.match(/\(([^)]+)\)\s*$/) || [])[1];
    if (!party && !/^Scattered/i.test(unit)) continue;   // ballot counts, not votes
    const key = Number(v[0]) * 1000 + Number(v[1]);
    const cur = out.get(key) || { county, dem: 0, rep: 0, total: 0 };
    cur.total += n;
    if (dem.has(party)) cur.dem += n;
    else if (rep.has(party)) cur.rep += n;
    out.set(key, cur);
  }
  return out;
}

async function edShapes(src) {
  const shapes = [];
  for (let offset = 0; ; offset += src.page_size) {
    const params = new URLSearchParams({ where: '1=1', outFields: 'ElectDist', outSR: '4326', f: 'geojson', resultOffset: String(offset), resultRecordCount: String(src.page_size) });
    const page = await (await fetchWithRetry(`${src.shapes_url}?${params}`)).json();
    if (page.error) throw new Error(`election district map: ${page.error.message}`);
    shapes.push(...(page.features || []));
    if ((page.features || []).length < src.page_size) break;
  }
  return shapes;
}

export async function runElectionsNyc() {
  const src = config('sources.json').elections_nyc;
  const counties = new Set(activeCounties().filter((c) => c.nyc).map((c) => c.fips));
  if (!src || !counties.size) { log('Elections NYC · not configured or no NYC boroughs, skipping'); return 0; }
  const text = await (await fetchWithRetry(src.url, { headers: { 'User-Agent': 'Mozilla/5.0 TurfScope' } })).text();
  const results = parseEdResults(text, src, counties);
  const shapes = await edShapes(src);
  const precincts = [];
  const matched = new Set();
  for (const f of shapes) {
    const key = Number(f.properties && f.properties.ElectDist);
    const r = results.get(key);
    if (!r || !f.geometry || r.total <= 0) continue;
    matched.add(key);
    precincts.push({ id: `ED ${key}`, county: r.county, dem: r.dem, rep: r.rep, total: r.total, geometry: roundGeometry(f.geometry, 5) });
  }
  const missing = [...results].filter(([k, r]) => !matched.has(k) && r.total > 0);
  const lost = missing.reduce((s, [, r]) => s + r.total, 0), all = [...results.values()].reduce((s, r) => s + r.total, 0);
  log(`Elections NYC · ${src.year} president · ${results.size} districts with results, ${shapes.length} on the map, ${precincts.length} joined`);
  if (missing.length) warn(`Elections NYC · ${missing.length} districts with votes had no shape on the current map (${Math.round((lost / all) * 1000) / 10}% of votes)`);
  if (!precincts.length) throw new Error('no election districts joined');
  writeJSON(raw('precincts_nyc.json'), { year: src.year, source: src.credit, precincts });
  return precincts.length;
}

if (isMain(import.meta.url)) runElectionsNyc().catch((e) => { console.error(e); process.exit(1); });
