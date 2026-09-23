// Offline end-to-end test: builds fake raw data, runs m2 + m4, checks outputs.
// No network. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../lib/util.js';
import { pre1980Codes } from '../m1-ingest/acs.js';
import { plutoTractGeoid } from '../m1-ingest/pluto.js';
import { isDac, detectDacFields, parseRelationship } from '../m1-ingest/dac.js';
import { incomeBand, dacFor2020, lotUtility, lotScore } from '../m2-score/score.js';
import { addrKey, compareLots } from '../m4-walklists/build.js';
import { pointInFeatureCollection } from '../lib/geo.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };
const readCfg = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', n), 'utf8'));

console.log('unit');
t('pre1980 codes from labels', () => {
  const vars = {
    B25034_001E: { label: 'Estimate!!Total:' },
    B25034_002E: { label: 'Estimate!!Total:!!Built 2020 or later' },
    B25034_006E: { label: 'Estimate!!Total:!!Built 1980 to 1989' },
    B25034_007E: { label: 'Estimate!!Total:!!Built 1970 to 1979' },
    B25034_011E: { label: 'Estimate!!Total:!!Built 1939 or earlier' },
    B25034_007M: { label: 'Margin of Error' },
  };
  assert.deepEqual(pre1980Codes(vars), ['B25034_007E', 'B25034_011E']);
});
t('PLUTO bct2020 → GEOID', () => {
  assert.equal(plutoTractGeoid('4012300'), '36081012300');
  assert.equal(plutoTractGeoid('4000100.0'), '36081000100');
  assert.equal(plutoTractGeoid(null), null);
});
t('DAC value parsing', () => {
  assert.equal(isDac('Designated as DAC'), true);
  assert.equal(isDac('Not Designated as DAC'), false);
  assert.equal(isDac('Yes'), true);
  assert.equal(isDac(''), false);
  assert.deepEqual(detectDacFields({ geoid: 'x', dac_designation: 'y' }, {}), { geoid: 'geoid', dac: 'dac_designation' });
});
t('relationship file parsing', () => {
  const txt = 'OID_TRACT_20|GEOID_TRACT_20|X|OID_TRACT_10|GEOID_TRACT_10|AREALAND_PART|AREAWATER_PART\n1|36081000100|a|2|36081000100|900|0\n1|36061000100|a|2|36061000100|900|0\n';
  assert.deepEqual(parseRelationship(txt, ['36081']), [{ g20: '36081000100', g10: '36081000100', land: 900 }]);
});
t('DAC crosswalk majority by land', () => {
  const rel = new Map([['A', [{ g20: 'A', g10: 'x', land: 70 }, { g20: 'A', g10: 'y', land: 30 }]]]);
  assert.equal(dacFor2020('A', rel, { x: true, y: false }).dac, true);
  assert.equal(dacFor2020('A', rel, { x: false, y: true }).dac, false);
  assert.equal(dacFor2020('A', null, null).dac, null);
});
t('utility rules', () => {
  const u = readCfg('utilities.json');
  assert.equal(lotUtility('11691', '081', u), 'psegli');
  assert.equal(lotUtility('11375', '081', u), 'coned');
  assert.equal(lotUtility('', '059', u), 'psegli');
});
t('income bands', () => {
  const b = readCfg('scoring.json').income_bands;
  assert.equal(incomeBand(45000, b), '<60k');
  assert.equal(incomeBand(100000, b), '100–150k');
  assert.equal(incomeBand(300000, b), '150k+');
  assert.equal(incomeBand(null, b), null);
});
t('lot score bounds', () => {
  const c = readCfg('scoring.json').lot;
  assert.equal(lotScore({ units: 1, year: 1950 }, 95, c), 100);
  assert.equal(lotScore({ units: 4, year: 2005 }, 5, c), 0);
});
t('Queens address walk order', () => {
  assert.deepEqual(addrKey('123-45 88 AVENUE'), { street: '88 AVENUE', side: 1, num: 1230045 });
  const rows = ['123-46 88 AVENUE', '123-45 88 AVENUE', '123-47 88 AVENUE', '10 ARCH ST'].map((address) => ({ address }));
  assert.deepEqual(rows.sort(compareLots).map((r) => r.address), ['123-46 88 AVENUE', '123-45 88 AVENUE', '123-47 88 AVENUE', '10 ARCH ST']);
});
t('boundary: in vs out', () => {
  const b = readCfg('turf_boundary.geojson');
  assert.equal(pointInFeatureCollection([-73.80, 40.72], b), true);  // Queens
  assert.equal(pointInFeatureCollection([-73.60, 40.70], b), true);  // Nassau
  assert.equal(pointInFeatureCollection([-73.76, 41.03], b), false); // White Plains
  assert.equal(pointInFeatureCollection([-73.54, 41.05], b), false); // Stamford CT
  assert.equal(pointInFeatureCollection([-72.60, 40.90], b), false); // Riverhead
  assert.equal(pointInFeatureCollection([-74.15, 40.58], b), false); // Staten Island interior
});

// ---------- end-to-end on fixtures ----------
console.log('pipeline');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turfscope-'));
const RAW = path.join(tmp, 'raw'), OUT = path.join(tmp, 'out'), EXP = path.join(tmp, 'exports');
fs.mkdirSync(RAW, { recursive: true });

const sq = (lon, lat, d = 0.01) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const tract = (geoid, lon, lat) => ({ type: 'Feature', geometry: sq(lon, lat), properties: { GEOID: geoid, INTPTLON: String(lon), INTPTLAT: `+${lat}` } });
const T = { queens: '36081000100', rock: '36081000200', nassau: '36059000300', outside: '36059000400', manhattan: '36061000500' };

fs.writeFileSync(path.join(RAW, 'tracts_geo.json'), JSON.stringify({ type: 'FeatureCollection', features: [
  tract(T.queens, -73.80, 40.72), tract(T.rock, -73.80, 40.59), tract(T.nassau, -73.60, 40.70),
  tract(T.outside, -72.50, 40.80), tract(T.manhattan, -73.98, 40.76),
] }));

const acsV = (o) => ({
  B19013_001E: 95000, B19001_001E: 1000, B19001_012E: 200, B19001_013E: 150, B19001_014E: 650,
  B25040_001E: 1000, B25040_002E: 400, B25040_003E: 50, B25040_004E: 100, B25040_005E: 450, B25040_010E: 0,
  B25035_001E: 1955, B25024_001E: 1200, B25024_002E: 600, B25024_003E: 100, B25024_004E: 200, B25024_005E: 70,
  B25003_001E: 1000, B25003_002E: 700, B25034_001E: 1000, B25034_007E: 300, B25034_011E: 400, ...o,
});
fs.writeFileSync(path.join(RAW, 'acs_tracts.json'), JSON.stringify({
  year: 2024, pre1980_codes: ['B25034_007E', 'B25034_011E'],
  rows: Object.values(T).map((g) => ({ geoid: g, name: g, v: acsV(g === T.nassau ? { B19013_001E: 140000 } : {}) })),
}));

const lot = (tract, address, zip, units, year, lon, lat) => ({ bbl: address, boro: 'QN', block: 1, address, zip, cls: units <= 1 ? 'A1' : units === 2 ? 'B1' : 'C0', units, year, lat, lon, tract });
const lots = [];
for (let i = 0; i < 30; i++) lots.push(lot(T.queens, `${100 + i} 88 AVENUE`, '11375', i % 3 === 0 ? 3 : 1, 1940, -73.80, 40.72));
lots.push(lot(T.queens, '1 BIG TOWER', '11375', 40, 1965, -73.80, 40.72)); // 5+ units: counted, not listed
for (let i = 0; i < 20; i++) lots.push(lot(T.rock, `${200 + i} BEACH 90 STREET`, '11693', 2, 1925, -73.80, 40.59));
fs.writeFileSync(path.join(RAW, 'pluto_lots.json'), JSON.stringify(lots));
fs.writeFileSync(path.join(RAW, 'dac_2010.json'), JSON.stringify({ '36081000150': true, '36081000200': false }));
fs.writeFileSync(path.join(RAW, 'tract_rel.json'), JSON.stringify([
  { g20: T.queens, g10: '36081000150', land: 800 }, { g20: T.queens, g10: '36081000160', land: 200 },
]));

const env = { ...process.env, RAW_DIR: RAW, OUT_DIR: OUT, EXPORT_DIR: EXP };
execFileSync(process.execPath, [path.join(ROOT, 'm2-score/build-tracts.js')], { env, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(ROOT, 'm4-walklists/build.js')], { env, stdio: 'inherit' });

const fc = JSON.parse(fs.readFileSync(path.join(OUT, 'tracts.geojson'), 'utf8'));
const by = Object.fromEntries(fc.features.map((f) => [f.properties.geoid, f.properties]));

t('only active counties inside the boundary are kept', () => {
  assert.deepEqual(Object.keys(by).sort(), [T.queens, T.rock, T.nassau].sort());
});
t('utility split: Queens=Con Ed, Rockaway=PSEG LI, Nassau=PSEG LI', () => {
  assert.equal(by[T.queens].utility, 'coned');
  assert.equal(by[T.rock].utility, 'psegli');
  assert.equal(by[T.nassau].utility, 'psegli');
});
t('NYC homes from PLUTO, Nassau from ACS estimate', () => {
  assert.equal(by[T.queens].homes, 30);
  assert.equal(by[T.queens].homes_source, 'pluto');
  assert.equal(by[T.queens].multifamily_5plus_lots, 1);
  assert.equal(by[T.nassau].homes_source, 'acs_est');
  assert.equal(by[T.nassau].homes, 820); // 600 + 100 + 200/2 + 70/3.5
});
t('DAC via 2010→2020 crosswalk', () => {
  assert.equal(by[T.queens].dac, true);
  assert.equal(by[T.queens].dac_share, 0.8);
  assert.equal(by[T.rock].dac, false);
});
t('scores are 0–100 and sorted', () => {
  const s = fc.features.map((f) => f.properties.score);
  s.forEach((x) => assert.ok(x >= 0 && x <= 100));
  assert.deepEqual(s, [...s].sort((a, b) => b - a));
  assert.equal(by[T.nassau].income_band, '100–150k');
});
t('summary carries scoring weights for the map card', () => {
  const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.weights, readCfg('scoring.json').weights);
});
t('walk lists: 1–4 units only, ordered, CSV written', () => {
  const q = JSON.parse(fs.readFileSync(path.join(OUT, 'walklists', `${T.queens}.json`), 'utf8'));
  assert.equal(q.length, 30);
  assert.ok(!q.some((r) => r.units >= 5));
  assert.equal(q[0].address, '100 88 AVENUE'); // even side first
  const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'walklists', 'index.json'), 'utf8'));
  assert.equal(idx[T.rock], 20);
  assert.ok(fs.readFileSync(path.join(EXP, 'walklists_all.csv'), 'utf8').startsWith('tract,address'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
