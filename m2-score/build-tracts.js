// m2 / join raw data → scored tracts. Writes m3-map/data/tracts.geojson + summary.json
import {
  config, readJSON, readJSONIfExists, writeJSON, raw, out, log, warn, round, activeCounties,
} from '../lib/util.js';
import { pointInFeatureCollection, roundGeometry, shareInside } from '../lib/geo.js';
import { tractMetrics, scoreTract, incomeBand, dacFor2020, lotUtility } from './score.js';

const scoring = config('scoring.json');
const util = config('utilities.json');
const boundary = config('turf_boundary.geojson');
const areas = config('areas.json');
const active = new Map(activeCounties().map((c) => [c.fips, c]));

for (const f of ['acs_tracts.json', 'tracts_geo.json']) {
  if (!readJSONIfExists(raw(f))) { console.error(`[turfscope] Missing data/raw/${f} — run npm run ingest first.`); process.exit(1); }
}
const acs = readJSON(raw('acs_tracts.json'));
const geo = readJSON(raw('tracts_geo.json'));
const lots = readJSONIfExists(raw('pluto_lots.json')) || [];
const dac10 = readJSONIfExists(raw('dac_2010.json'));
const rel = readJSONIfExists(raw('tract_rel.json'));
if (!dac10) warn('No DAC data — incentive factor will be 0 for DAC-based utilities.');
const muniCfg = util.municipal_electric || { places: [] };
const muniPlaces = (readJSONIfExists(raw('muni_places.json'))?.features || [])
  .map((f) => ({ geometry: f.geometry, label: muniCfg.places.find((p) => p.name === f.properties?.NAME)?.label || f.properties?.NAME }))
  .filter((p) => p.geometry);
if (muniCfg.places.length && !muniPlaces.length) warn('No village boundaries (data/raw/muni_places.json) — municipal electric villages will show as PSEG LI.');

// Which municipal-electric village (if any) covers this tract, and how much of it.
function muniFor(geom) {
  let best = null;
  for (const p of muniPlaces) {
    const share = shareInside(geom, p.geometry);
    if (share > 0 && (!best || share > best.share)) best = { label: p.label, share: round(share) };
  }
  return best;
}

const acsBy = new Map(acs.rows.map((r) => [r.geoid, r]));
let relIndex = null;
if (rel) {
  relIndex = new Map();
  for (const p of rel) {
    if (!relIndex.has(p.g20)) relIndex.set(p.g20, []);
    relIndex.get(p.g20).push(p);
  }
}

// NYC lot aggregates per tract
const lotAgg = new Map();
for (const l of lots) {
  if (!l.tract) continue;
  const a = lotAgg.get(l.tract) || { homes: 0, mf: 0, util: {} };
  if (l.units >= 1 && l.units <= 4) {
    a.homes++;
    const u = lotUtility(l.zip, l.tract.slice(2, 5), util);
    a.util[u] = (a.util[u] || 0) + 1;
  } else if (l.units >= 5) a.mf++;
  lotAgg.set(l.tract, a);
}

// Internal point + land area for every polygon that has ACS data, so tracts the ACS
// doesn't publish (a handful of 2020 tract splits in Suffolk) can borrow from the
// nearest one in the same county instead of vanishing from the map.
const acsPoints = geo.features
  .map((f) => f.properties || {})
  .filter((p) => acsBy.has(String(p.GEOID)))
  .map((p) => ({ geoid: String(p.GEOID), lon: Number(p.INTPTLON), lat: Number(p.INTPTLAT), land: Number(p.AREALAND) || 0 }));
function nearestAcs(geoid, lon, lat) {
  let best = null, bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const q of acsPoints) {
    if (q.geoid.slice(2, 5) !== geoid.slice(2, 5)) continue;
    const d = ((q.lon - lon) * k) ** 2 + (q.lat - lat) ** 2;
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

const features = [];
let dropped = { county: 0, boundary: 0, small: 0, noacs: 0, noutil: 0 };
const droppedIds = { boundary: [], noacs: [] };
const borrowed = [];

for (const f of geo.features) {
  const p = f.properties || {};
  const geoid = String(p.GEOID);
  const county = geoid.slice(2, 5);
  const c = active.get(county);
  if (!c) { dropped.county++; continue; }

  const pt = [Number(p.INTPTLON), Number(p.INTPTLAT)];
  if (!pointInFeatureCollection(pt, boundary)) { dropped.boundary++; droppedIds.boundary.push(geoid); continue; }

  let a = acsBy.get(geoid);
  let estimatedFrom = null;
  let landRatio = 1;
  if (!a) {
    const near = nearestAcs(geoid, pt[0], pt[1]);
    if (!near) { dropped.noacs++; droppedIds.noacs.push(geoid); continue; }
    a = acsBy.get(near.geoid);
    estimatedFrom = near.geoid;
    landRatio = near.land > 0 && Number(p.AREALAND) > 0 ? Number(p.AREALAND) / near.land : 1;
    borrowed.push(`${geoid}←${near.geoid}`);
  }

  const m = tractMetrics(a.v, acs.pre1980_codes, scoring);
  if (estimatedFrom) m.homes_est = Math.round(m.homes_est * landRatio);
  const agg = lotAgg.get(geoid);

  // Homes: real building counts from PLUTO in NYC, ACS estimate elsewhere.
  const usePluto = c.nyc && agg && agg.homes > 0;
  m.homes = usePluto ? agg.homes : m.homes_est;
  if (m.homes < scoring.min_homes_to_show) { dropped.small++; continue; }

  // Utility: majority of lots in NYC, county rule elsewhere.
  let utility = util.county_default[county] || null;
  let utility_split = false;
  if (usePluto) {
    const ranked = Object.entries(agg.util).sort((x, y) => y[1] - x[1]);
    utility = ranked[0][0];
    const minority = ranked.slice(1).reduce((s, [, n]) => s + n, 0);
    utility_split = minority / agg.homes > util.split_threshold;
  }
  // Villages with their own electric utility (Freeport, Rockville Centre, Greenport).
  const muni = muniPlaces.length ? muniFor(f.geometry) : null;
  if (muni && muni.share >= muniCfg.majority_share) utility = muniCfg.utility;
  if (!utility || !util.utilities[utility]) { dropped.noutil++; warn(`No utility for ${geoid}`); continue; }

  Object.assign(m, dacFor2020(geoid, relIndex, dac10));
  const s = scoreTract(m, utility, scoring);

  features.push({
    type: 'Feature',
    geometry: roundGeometry(f.geometry, 5),
    properties: {
      geoid,
      county,
      county_name: c.name,
      utility,
      utility_split,
      muni,
      homes: m.homes,
      homes_source: usePluto ? 'pluto' : 'acs_est',
      estimated_from: estimatedFrom,
      multifamily_5plus_lots: usePluto ? agg.mf : null,
      median_income: m.median_income,
      income_band: incomeBand(m.median_income, scoring.income_bands),
      low_income_share: round(m.low_income_share),
      median_year_built: m.median_year_built,
      pre1980: round(m.pre1980_share),
      owner: round(m.owner_share),
      fuel: m.fuel ? Object.fromEntries(Object.entries(m.fuel).map(([k, v]) => [k, round(v)])) : null,
      dac: m.dac,
      dac_share: m.dac_share,
      score: s.score,
      parts: s.parts,
      gaps: s.gaps,
    },
  });
}

features.sort((x, y) => y.properties.score - x.properties.score);
writeJSON(out('tracts.geojson'), { type: 'FeatureCollection', features });

const byUtil = {};
for (const f of features) {
  const u = f.properties.utility;
  byUtil[u] = byUtil[u] || { tracts: 0, homes: 0 };
  byUtil[u].tracts++;
  byUtil[u].homes += f.properties.homes;
}
writeJSON(out('summary.json'), {
  generated_at: new Date().toISOString(),
  acs_year: acs.year,
  active_phase: areas.active_phase,
  weights: scoring.weights,
  counties: [...active.values()].map((c) => c.name),
  utilities: Object.fromEntries(Object.entries(util.utilities).map(([k, v]) => [k, { ...v, ...(byUtil[k] || { tracts: 0, homes: 0 }) }])),
  tracts: features.length,
  estimated_from_neighbor: borrowed.length,
  dropped,
});

const geoIds = new Set(geo.features.map((f) => String(f.properties?.GEOID)));
const acsOnly = acs.rows.filter((r) => active.has(r.geoid.slice(2, 5)) && !geoIds.has(r.geoid));
if (acsOnly.length) warn(`ACS tracts with no polygon: ${acsOnly.map((r) => `${r.geoid} (${r.name})`).join('; ')}`);
const muniTracts = features.filter((x) => x.properties.muni);
if (muniTracts.length) log(`Village electric · ${muniTracts.map((x) => `${x.properties.geoid} ${x.properties.muni.label} ${Math.round(x.properties.muni.share * 100)}%`).join(', ')}`);
if (borrowed.length) warn(`No ACS data for ${borrowed.length} tracts — estimated from nearest tract: ${borrowed.join(', ')}`);
for (const [k, ids] of Object.entries(droppedIds)) if (ids.length) log(`Dropped (${k}): ${ids.join(', ')}`);
log(`Scored ${features.length} tracts →`, JSON.stringify(byUtil), '· dropped', JSON.stringify(dropped));
