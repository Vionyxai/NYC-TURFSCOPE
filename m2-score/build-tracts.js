// m2 / join raw data → scored tracts. Writes m3-map/data/tracts.geojson + summary.json
import {
  config, readJSON, readJSONIfExists, writeJSON, raw, out, log, warn, round, activeCounties,
} from '../lib/util.js';
import { pointInFeatureCollection, roundGeometry } from '../lib/geo.js';
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

const features = [];
let dropped = { county: 0, boundary: 0, small: 0, noacs: 0, noutil: 0 };
const droppedIds = { boundary: [], noacs: [] };

for (const f of geo.features) {
  const p = f.properties || {};
  const geoid = String(p.GEOID);
  const county = geoid.slice(2, 5);
  const c = active.get(county);
  if (!c) { dropped.county++; continue; }

  const pt = [Number(p.INTPTLON), Number(p.INTPTLAT)];
  if (!pointInFeatureCollection(pt, boundary)) { dropped.boundary++; droppedIds.boundary.push(geoid); continue; }

  const a = acsBy.get(geoid);
  if (!a) { dropped.noacs++; droppedIds.noacs.push(`${geoid} (land ${p.AREALAND ?? '?'} m²)`); continue; }

  const m = tractMetrics(a.v, acs.pre1980_codes, scoring);
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
      homes: m.homes,
      homes_source: usePluto ? 'pluto' : 'acs_est',
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
  dropped,
});

const geoIds = new Set(geo.features.map((f) => String(f.properties?.GEOID)));
const acsOnly = acs.rows.filter((r) => active.has(r.geoid.slice(2, 5)) && !geoIds.has(r.geoid));
if (acsOnly.length) warn(`ACS tracts with no polygon: ${acsOnly.map((r) => `${r.geoid} (${r.name})`).join('; ')}`);
for (const [k, ids] of Object.entries(droppedIds)) if (ids.length) log(`Dropped (${k}): ${ids.join(', ')}`);
log(`Scored ${features.length} tracts →`, JSON.stringify(byUtil), '· dropped', JSON.stringify(dropped));
