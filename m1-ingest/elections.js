// m1 / Elections: 2020 presidential results by voting precinct for the active counties → data/raw/precincts.json
// Source: The New York Times' precinct map (MIT license). New York precincts and results are
// official (compiled by Benjamin Rosenblatt). The file covers the whole country, so it is streamed:
// features are cut out one at a time and only our counties' precincts are kept.
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { config, writeJSON, raw, log, activeCounties, isMain } from '../lib/util.js';
import { roundGeometry } from '../lib/geo.js';

// Splits the text of a GeoJSON FeatureCollection into one string per feature, without
// holding the whole file in memory. Feed it chunks; it calls onFeature(text) for each.
export function featureSplitter(onFeature) {
  let buf = '', depth = 0, inStr = false, esc = false, start = -1, inFeatures = false, pos = 0;
  return (chunk) => {
    buf += chunk;
    if (!inFeatures) {
      const i = buf.indexOf('"features"');
      if (i < 0) { buf = buf.slice(-20); return; }
      const j = buf.indexOf('[', i);
      if (j < 0) return;
      buf = buf.slice(j + 1); inFeatures = true; pos = 0;
    }
    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth++ === 0) start = pos; }
      else if (c === '}') { if (--depth === 0) { onFeature(buf.slice(start, pos + 1)); buf = buf.slice(pos + 1); pos = -1; start = -1; } }
    }
    if (depth === 0) { buf = ''; pos = 0; }   // between features: nothing worth keeping
  };
}

// One precinct, trimmed to what the map needs. Null for precincts outside our counties or with no votes.
export function precinctFromFeature(f, counties) {
  const p = f.properties || {};
  const fips = String(p.GEOID || '').slice(0, 5);
  if (!counties.has(fips) || !f.geometry) return null;
  const total = Number(p.votes_total) || 0;
  if (total <= 0) return null;
  return { id: String(p.GEOID), county: fips.slice(2), dem: Number(p.votes_dem) || 0, rep: Number(p.votes_rep) || 0, total, geometry: roundGeometry(f.geometry, 5) };
}

export async function runElections() {
  const src = config('sources.json').elections;
  if (!src || !src.url) { log('Elections · not configured, skipping'); return 0; }
  const { state_fips } = config('areas.json');
  const counties = new Set(activeCounties().map((c) => `${state_fips}${c.fips}`));
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${src.url}`);
  const kept = [];
  let seen = 0;
  const split = featureSplitter((text) => {
    seen++;
    // Cheap check before parsing: only New York features can be ours.
    if (!text.includes(`"GEOID":"${state_fips}`) && !text.includes(`"GEOID": "${state_fips}`)) return;
    const pr = precinctFromFeature(JSON.parse(text), counties);
    if (pr) kept.push(pr);
  });
  const gunzip = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  gunzip.setEncoding('utf8');
  for await (const chunk of gunzip) split(chunk);
  const byCounty = {};
  for (const p of kept) byCounty[p.county] = (byCounty[p.county] || 0) + 1;
  log(`Elections · ${src.year} president · ${seen} precincts nationwide · kept ${kept.length}: ${activeCounties().map((c) => `${c.name} ${byCounty[c.fips] || 0}`).join(', ')}`);
  if (!kept.length) throw new Error('no precincts found for the active counties');
  writeJSON(raw('precincts.json'), { year: src.year, source: src.credit, precincts: kept });
  return kept.length;
}

if (isMain(import.meta.url)) runElections().catch((e) => { console.error(e); process.exit(1); });
