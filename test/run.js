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
import { incomeBand, dacFor2020, lotUtility, lotScore, ownerAgeShares, sizeBand, homeAgeBand, lotBusiness } from '../m2-score/score.js';
import { addrKey, compareLots, packWalk, unpackWalk, tractLocator } from '../m4-walklists/build.js';
import { fuelKey, parcelToLot } from '../m1-ingest/li_parcels.js';
import { pointInFeatureCollection, shareInside } from '../lib/geo.js';
import { checkSupabase, buildAppConfig } from '../scripts/app-config.js';
import vm from 'node:vm';
import { fakeSupabase, memoryStorage } from './fake-supabase.js';

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
t('homeowner age shares by band', () => {
  const bands = readCfg('scoring.json').targeting.owner_age_bands;
  const v = { B25007_002E: 100, B25007_003E: 5, B25007_004E: 10, B25007_005E: 15, B25007_006E: 20, B25007_007E: 10, B25007_008E: 10, B25007_009E: 20, B25007_010E: 8, B25007_011E: 2 };
  assert.deepEqual(ownerAgeShares(v, bands), { u45: 0.3, '45_64': 0.4, '65p': 0.3 });
  assert.equal(ownerAgeShares({ B25007_002E: 0 }, bands), null);
});
t('house size bands', () => {
  const bands = readCfg('scoring.json').targeting.size_bands;
  assert.equal(sizeBand(1200, 'sqft', bands), 'small');
  assert.equal(sizeBand(2500, 'sqft', bands), 'medium');
  assert.equal(sizeBand(4000, 'sqft', bands), 'large');
  assert.equal(sizeBand(5, 'rooms', bands), 'small');
  assert.equal(sizeBand(7.5, 'rooms', bands), 'large');
  assert.equal(sizeBand(null, 'sqft', bands), null);
});
t('home age bands', () => {
  const bands = readCfg('scoring.json').targeting.home_age_bands;
  assert.equal(homeAgeBand(1925, bands), 'pre1940');
  assert.equal(homeAgeBand(1939, bands), 'pre1940'); // ACS "1939 or earlier"
  assert.equal(homeAgeBand(1979, bands), '1940_79');
  assert.equal(homeAgeBand(1985, bands), '1980_99');
  assert.equal(homeAgeBand(2012, bands), '2000p');
  assert.equal(homeAgeBand(0, bands), null);
});
t('business at a home', () => {
  assert.equal(lotBusiness({ cls: 'A1', comarea: 0 }, ['Home Improvement Contractor']), 'Home Improvement Contractor');
  assert.equal(lotBusiness({ cls: 'A1' }, ['A', 'B', 'C']), 'A, B +1');
  assert.equal(lotBusiness({ cls: 'S1', comarea: 0 }, null), 'Store/office on site');
  assert.equal(lotBusiness({ cls: 'B2', comarea: 600 }, []), 'Store/office on site');
  assert.equal(lotBusiness({ cls: 'A1', comarea: 0 }, undefined), null);
});
t('Long Island parcels: fuel words, home types, never owner data', () => {
  assert.equal(fuelKey('Oil'), 'oil');
  assert.equal(fuelKey('Gas'), 'gas');
  assert.equal(fuelKey('Propane/LPG'), 'propane');
  assert.equal(fuelKey('Unknown'), null);
  assert.equal(fuelKey(null), null);
  const classes = readCfg('scoring.json').li_property_classes;
  const rec = { SWIS_PRINT_KEY_ID: '472089 0100-012.000-0001-005.000', PARCEL_ADDR: ' 57  SUNSET AV ', LOC_ZIP: '11701', CITYTOWN_NAME: 'Babylon',
    PROP_CLASS: '220', YR_BLT: 1952, SQFT_LIVING: 1640.4, FUEL_TYPE_DESC: 'Oil', HEAT_TYPE_DESC: 'Hot wtr/stm', PRIMARY_OWNER: 'SHOULD NOT APPEAR', MAIL_ADDR: 'NOPE' };
  const lot = parcelToLot(rec, { x: -73.425113, y: 40.688404 }, classes);
  assert.deepEqual({ ...lot }, { id: '472089 0100-012.000-0001-005.000', address: '57 SUNSET AV', zip: '11701', town: 'Babylon', cls: '220', units: 2,
    year: 1952, sqft: 1640, fuel: 'oil', heat: 'Hot wtr/stm', biz: false, lat: 40.688404, lon: -73.425113 });
  assert.ok(!JSON.stringify(lot).includes('SHOULD NOT') && !JSON.stringify(lot).includes('NOPE'));
  assert.equal(parcelToLot({ ...rec, PROP_CLASS: '270' }, { x: -73.4, y: 40.7 }, classes), null);   // mobile home: skipped
  assert.equal(parcelToLot({ ...rec, PARCEL_ADDR: '' }, { x: -73.4, y: 40.7 }, classes), null);     // no address: skipped
  assert.equal(parcelToLot({ ...rec, PROP_CLASS: '283' }, { x: -73.4, y: 40.7 }, classes).biz, true);
  const sqlCfg = readCfg('sources.json').li_parcels.fields;
  assert.ok(!sqlCfg.some((f) => /OWNER|MAIL/.test(f)), 'owner and mailing fields are never requested');
});
t('walk-list files: compact format round-trips', () => {
  const rows = [{ address: '1 A ST', zip: '11375', units: 2, rental: true, biz: null, fuel: 'oil', lat: 40.123456789, lon: -73.987654321, score: 80 },
                { address: '3 A ST', units: 1, rental: false, lat: 40.1, lon: -73.9, score: 70 }];
  const back = unpackWalk(JSON.parse(JSON.stringify(packWalk(rows))));
  assert.equal(back[0].rental, true);
  assert.equal(back[1].rental, false);
  assert.equal(back[0].fuel, 'oil');
  assert.equal(back[0].lat, 40.12346);
  assert.equal(back[1].fuel, null);
  assert.deepEqual(unpackWalk([{ address: 'old' }]), [{ address: 'old' }]);   // old files still read
  const find = tractLocator([{ type: 'Feature', properties: { geoid: 'X' }, geometry: { type: 'Polygon', coordinates: [[[-73.5, 40.6], [-73.4, 40.6], [-73.4, 40.7], [-73.5, 40.7], [-73.5, 40.6]]] } }]);
  assert.equal(find(-73.45, 40.65).geoid, 'X');
  assert.equal(find(-73.2, 40.65), null);
});
t('lot score bounds', () => {
  const c = readCfg('scoring.json').lot;
  assert.equal(lotScore({ units: 1, year: 1950 }, 95, c), 100);
  assert.equal(lotScore({ units: 4, year: 2005 }, 5, c), 0);
  assert.equal(lotScore({ units: 1, year: 2005, fuel: 'oil' }, 50, c), 70);  // +10 small, +10 oil on record
  assert.equal(lotScore({ units: 1, year: 2005, fuel: 'gas' }, 50, c), 60);
});
t('Queens address walk order', () => {
  assert.deepEqual(addrKey('123-45 88 AVENUE'), { street: '88 AVENUE', side: 1, num: 1230045 });
  assert.deepEqual(addrKey('111-30 1/2 145 STREET'), { street: '145 STREET', side: 0, num: 1110030.5 });
  const rows = ['123-46 88 AVENUE', '123-45 88 AVENUE', '123-47 88 AVENUE', '10 ARCH ST'].map((address) => ({ address }));
  assert.deepEqual(rows.sort(compareLots).map((r) => r.address), ['123-46 88 AVENUE', '123-45 88 AVENUE', '123-47 88 AVENUE', '10 ARCH ST']);
});
t('boundary: in vs out', () => {
  const b = readCfg('turf_boundary.geojson');
  assert.equal(pointInFeatureCollection([-73.80, 40.72], b), true);  // Queens
  assert.equal(pointInFeatureCollection([-73.60, 40.70], b), true);  // Nassau
  assert.equal(pointInFeatureCollection([-73.76, 41.03], b), false); // White Plains
  assert.equal(pointInFeatureCollection([-73.54, 41.05], b), false); // Stamford CT
  // All of PSEG Long Island's territory is in
  assert.equal(pointInFeatureCollection([-72.66, 40.92], b), true);  // Riverhead
  assert.equal(pointInFeatureCollection([-71.95, 41.03], b), true);  // Montauk
  assert.equal(pointInFeatureCollection([-72.28, 41.14], b), true);  // Orient
  assert.equal(pointInFeatureCollection([-72.34, 41.07], b), true);  // Shelter Island
  assert.equal(pointInFeatureCollection([-72.39, 40.88], b), true);  // Southampton
  assert.equal(pointInFeatureCollection([-73.13, 40.73], b), true);  // Islip
  assert.equal(pointInFeatureCollection([-73.25, 40.63], b), true);  // Fire Island
  assert.equal(pointInFeatureCollection([-73.92, 40.56], b), true);  // Breezy Point (Rockaways)
  assert.equal(pointInFeatureCollection([-72.00, 41.27], b), false); // Fishers Island (not PSEG LI)
  assert.equal(pointInFeatureCollection([-72.37, 41.29], b), false); // Old Saybrook CT
  assert.equal(pointInFeatureCollection([-72.92, 41.30], b), false); // New Haven CT
  assert.equal(pointInFeatureCollection([-74.15, 40.58], b), false); // Staten Island interior
});

t('share of a polygon inside another', () => {
  const box = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
  assert.equal(shareInside(box(0, 0, 1, 1), box(-1, -1, 2, 2)), 1);
  assert.equal(shareInside(box(0, 0, 1, 1), box(0.5, 0, 2, 1)), 0.5);
  assert.equal(shareInside(box(0, 0, 1, 1), box(5, 5, 6, 6)), 0);
});

t('Supabase SQL matches config/team.json (reps, statuses, follow-ups)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', '001_team_tracking.sql'), 'utf8');
  const team = readCfg('team.json');
  const seeded = [...sql.match(/insert into public\.reps \(name, is_admin\) values (.+);/)[1].matchAll(/\('([^']+)', (true|false)\)/g)]
    .map(([, name, admin]) => ({ name, admin: admin === 'true' }));
  assert.deepEqual(seeded, team.reps.map(({ name, admin }) => ({ name, admin })));
  assert.deepEqual(team.reps.map((r) => r.name), ['Issac', 'Matt', 'Cody', 'Gio']);
  const lists = (col) => [...sql.matchAll(new RegExp(`${col} in \\(([^)]+)\\)`, 'g'))].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  assert.deepEqual(lists('status'), [team.knock_statuses.map((x) => x.key), team.turf_statuses.map((x) => x.key)]);
  assert.deepEqual(lists('followup'), [team.followups.map((x) => x.key)]);
  assert.match(sql, new RegExp(`char_length\\(t\\) <= ${team.note_max}`));
});
t('app config: publishable key accepted, secret keys refused', () => {
  const team = readCfg('team.json');
  const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`;
  assert.equal(checkSupabase({ url: '', anon_key: '' }).ok, false);
  assert.equal(checkSupabase({ url: 'https://abcd1234.supabase.co/', anon_key: 'sb_publishable_xyz' }).url, 'https://abcd1234.supabase.co');
  assert.equal(checkSupabase({ url: 'https://abcd1234.supabase.co', anon_key: jwt('anon') }).ok, true);
  assert.equal(checkSupabase({ url: 'https://abcd1234.supabase.co', anon_key: jwt('service_role') }).secret, true);
  assert.equal(checkSupabase({ url: 'https://abcd1234.supabase.co', anon_key: 'sb_secret_abc' }).secret, true);
  assert.equal(checkSupabase({ url: 'http://evil.example.com', anon_key: 'sb_publishable_x' }).ok, false);
  const app = buildAppConfig({ url: 'https://abcd1234.supabase.co', anon_key: 'sb_publishable_x' }, team);
  assert.equal(app.supabase.key, 'sb_publishable_x');
  assert.equal(app.statuses.length, 5);
  assert.equal(buildAppConfig({}, team).supabase, null);
});

// ---------- end-to-end on fixtures ----------
console.log('pipeline');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turfscope-'));
const RAW = path.join(tmp, 'raw'), OUT = path.join(tmp, 'out'), EXP = path.join(tmp, 'exports');
fs.mkdirSync(RAW, { recursive: true });

const sq = (lon, lat, d = 0.01) => ({ type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] });
const tract = (geoid, lon, lat) => ({ type: 'Feature', geometry: sq(lon, lat), properties: { GEOID: geoid, INTPTLON: String(lon), INTPTLAT: `+${lat}` } });
const T = { queens: '36081000100', rock: '36081000200', nassau: '36059000300', suffolk: '36103000600', suffolkSplit: '36103000601', outside: '36103000400', manhattan: '36061000500' };

fs.writeFileSync(path.join(RAW, 'tracts_geo.json'), JSON.stringify({ type: 'FeatureCollection', features: [
  tract(T.queens, -73.80, 40.72), tract(T.rock, -73.80, 40.59), tract(T.nassau, -73.60, 40.70),
  tract(T.suffolk, -71.95, 41.03), tract(T.suffolkSplit, -71.93, 41.03), tract(T.outside, -72.00, 41.27), tract(T.manhattan, -73.98, 40.76),
] }));

const acsV = (o) => ({
  B19013_001E: 95000, B19001_001E: 1000, B19001_012E: 200, B19001_013E: 150, B19001_014E: 650,
  B25040_001E: 1000, B25040_002E: 400, B25040_003E: 50, B25040_004E: 100, B25040_005E: 450, B25040_010E: 0,
  B25035_001E: 1955, B25024_001E: 1200, B25024_002E: 600, B25024_003E: 100, B25024_004E: 200, B25024_005E: 70,
  B25003_001E: 1000, B25003_002E: 700, B25034_001E: 1000, B25034_007E: 300, B25034_011E: 400,
  B25007_002E: 700, B25007_004E: 70, B25007_006E: 210, B25007_008E: 140, B25007_009E: 280, B25018_001E: 6.2, ...o,
});
fs.writeFileSync(path.join(RAW, 'acs_tracts.json'), JSON.stringify({
  year: 2024, pre1980_codes: ['B25034_007E', 'B25034_011E'],
  rows: Object.values(T).filter((g) => g !== T.suffolkSplit).map((g) => ({ geoid: g, name: g, v: acsV(g === T.nassau ? { B19013_001E: 140000, B25007_009E: 0, B25007_004E: 350 } : {}) })),
}));

const lot = (tract, address, zip, units, year, lon, lat) => ({ bbl: address, boro: 'QN', block: 1, address, zip, cls: units <= 1 ? 'A1' : units === 2 ? 'B1' : 'C0', units, year, sqft: units <= 1 ? 1400 : 2800, lat, lon, tract });
const lots = [];
for (let i = 0; i < 30; i++) lots.push(lot(T.queens, `${100 + i} 88 AVENUE`, '11375', i % 3 === 0 ? 3 : 1, 1940, -73.80, 40.72));
lots.push(lot(T.queens, '1 BIG TOWER', '11375', 40, 1965, -73.80, 40.72)); // 5+ units: counted, not listed
for (let i = 0; i < 20; i++) lots.push(lot(T.rock, `${200 + i} BEACH 90 STREET`, '11693', 2, 1925, -73.80, 40.59));
lots[1].cls = 'S1'; // one-family with a store
fs.writeFileSync(path.join(RAW, 'pluto_lots.json'), JSON.stringify(lots));
// Long Island homes from the state roll: two in the Nassau tract (one oil), one outside every tract.
fs.writeFileSync(path.join(RAW, 'li_parcels.json'), JSON.stringify([
  { id: 'LI-1', address: '12 ELM ST', zip: '11758', town: 'Oyster Bay', cls: '210', units: 1, year: 1955, sqft: 1500, fuel: 'oil', heat: 'Hot air', biz: false, lat: 40.70, lon: -73.60 },
  { id: 'LI-2', address: '14 ELM ST', zip: '11758', town: 'Oyster Bay', cls: '220', units: 2, year: null, sqft: null, fuel: null, heat: null, biz: false, lat: 40.701, lon: -73.592 },
  { id: 'LI-3', address: '9 FAR RD', zip: '11901', town: 'Riverhead', cls: '210', units: 1, year: null, sqft: null, fuel: null, heat: null, biz: false, lat: 40.95, lon: -72.66 },
]));
fs.writeFileSync(path.join(RAW, 'business_by_bbl.json'), JSON.stringify({ '103 88 AVENUE': ['Home Improvement Contractor'] }));
// Villages with their own electric utility: one covers the whole Suffolk tract, one a quarter of Nassau's.
const vbox = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
fs.writeFileSync(path.join(RAW, 'muni_places.json'), JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { NAME: 'Greenport village' }, geometry: vbox(-71.97, 41.01, -71.94, 41.05) },
  { type: 'Feature', properties: { NAME: 'Freeport village' }, geometry: vbox(-73.595, 40.68, -73.58, 40.72) },
] }));
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
  assert.deepEqual(Object.keys(by).sort(), [T.queens, T.rock, T.nassau, T.suffolk, T.suffolkSplit].sort());
});
t('utility split: Queens=Con Ed, Rockaway/Nassau/Suffolk=PSEG LI', () => {
  assert.equal(by[T.suffolkSplit].utility, 'psegli');
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
t('tract with no ACS data borrows from the nearest tract in the same county', () => {
  const s = by[T.suffolkSplit];
  assert.equal(s.estimated_from, T.suffolk);
  assert.equal(s.homes, by[T.suffolk].homes); // same land area in the fixture
  assert.equal(s.median_income, by[T.suffolk].median_income);
  assert.equal(by[T.suffolk].estimated_from, null);
});
t('municipal electric villages: majority → own utility, partial → flagged', () => {
  assert.equal(by[T.suffolk].utility, 'muni');
  assert.deepEqual(by[T.suffolk].muni, { label: 'Greenport Electric', share: 1 });
  assert.equal(by[T.nassau].utility, 'psegli');
  assert.equal(by[T.nassau].muni.label, 'Freeport Electric');
  assert.ok(by[T.nassau].muni.share > 0.2 && by[T.nassau].muni.share < 0.3);
  assert.equal(by[T.queens].muni, null);
});
t('targeting: homeowner age, house size, turf-wide age average', () => {
  assert.deepEqual(by[T.queens].owner_age, { u45: 0.1, '45_64': 0.5, '65p': 0.4 });
  assert.equal(by[T.queens].size_basis, 'sqft');
  assert.equal(by[T.queens].size_value, 1400);      // 20 one-family (1,400 sq ft) vs 10 three-family lots
  assert.equal(by[T.queens].size_band, 'small');
  assert.equal(by[T.nassau].size_basis, 'rooms');
  assert.equal(by[T.nassau].size_band, 'medium');   // 6.2 median rooms
  const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.targeting.income_bands, ['<60k', '60–100k', '100–150k', '150k+']);
  assert.deepEqual(summary.targeting.oil_bands.map((b) => b.min), [0.25, 0.4, 0.6]);
  assert.equal(summary.targeting.oil_focus.utility, 'psegli');
  assert.ok(summary.targeting.oil_bands.some((b) => b.key === summary.targeting.oil_focus.oil_band), 'oil focus points at a real band');
  assert.equal(summary.targeting.oil_color_breaks.length, 4);
  assert.ok(summary.targeting.owner_age_avg['65p'] > 0 && summary.targeting.owner_age_avg['65p'] < 0.4);
});
t('home age, renters and home businesses on tracts', () => {
  const q = by[T.queens];
  assert.equal(q.year_built, 1940);          // median of the lots (PLUTO)
  assert.equal(q.home_age_band, '1940_79');
  assert.equal(q.renter, 0.3);
  assert.equal(q.renter_heavy, false);
  assert.equal(q.rental_unit_lots, 10);      // the 3-family lots
  assert.equal(q.business_lots, 2);          // one licensed, one mixed-use class
  assert.equal(by[T.nassau].year_built, 1955); // ACS median
  assert.equal(by[T.nassau].rental_unit_lots, null);
});
t('summary carries scoring weights for the map card', () => {
  const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.weights, readCfg('scoring.json').weights);
});
t('walk lists: 1–4 units only, ordered, CSV written', () => {
  const q = unpackWalk(JSON.parse(fs.readFileSync(path.join(OUT, 'walklists', `${T.queens}.json`), 'utf8')));
  assert.equal(q.length, 30);
  assert.ok(!q.some((r) => r.units >= 5));
  assert.equal(q[0].address, '100 88 AVENUE'); // even side first
  assert.equal(q[1].sqft, 1400);
  assert.equal(q[0].rental, true);                         // 3-family
  assert.equal(q[1].rental, false);
  assert.equal(q.find((r) => r.address === '101 88 AVENUE').biz, 'Store/office on site');
  assert.equal(q[1].biz, null);
  assert.equal(q.find((r) => r.address === '103 88 AVENUE').biz, 'Home Improvement Contractor');
  assert.equal(q[1].age, '1940_79');
  assert.equal(q[1].size, 'small');
  const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'walklists', 'index.json'), 'utf8'));
  assert.equal(idx[T.rock], 20);
  assert.ok(fs.readFileSync(path.join(EXP, 'walklists_all.csv'), 'utf8').startsWith('tract,address'));
});
t('Long Island walk list from the state roll: placed by location, oil on record first-class', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(OUT, 'walklists', 'index.json'), 'utf8'));
  assert.equal(idx[T.nassau], 2);                         // the Riverhead house is outside every fixture tract
  const n = unpackWalk(JSON.parse(fs.readFileSync(path.join(OUT, 'walklists', `${T.nassau}.json`), 'utf8')));
  assert.deepEqual(n.map((r) => r.address), ['12 ELM ST', '14 ELM ST']);
  assert.equal(n[0].fuel, 'oil');
  assert.equal(n[0].bbl, 'LI-1');
  assert.equal(n[0].heat, 'Hot air');
  assert.equal(n[1].rental, true);                        // two-family
  assert.equal(n[1].utility, 'muni');                     // inside the fixture's Freeport village box
  assert.equal(n[0].score - n[1].score >= 10, true);      // oil on record + pre-1980 lift the first house
});

fs.rmSync(tmp, { recursive: true, force: true });

// ---------- team sync (m3-map/team.js) against a fake Supabase ----------
console.log('team');
const at = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'm3-map', 'team.js'), 'utf8'), { window: ctx });
const team = readCfg('team.json');
const makeTeam = () => fakeSupabase({
  users: { 'gio@x.com': 'pw-gio', 'matt@x.com': 'pw-matt', 'stranger@x.com': 'pw-s' },
  reps: [
    { id: 1, name: 'Issac', email: null, is_admin: false },
    { id: 2, name: 'Matt', email: 'matt@x.com', is_admin: false },
    { id: 3, name: 'Cody', email: null, is_admin: false },
    { id: 4, name: 'Gio', email: 'Gio@x.com', is_admin: true },
  ],
  statuses: team.knock_statuses.map((s) => s.key),
});
let clock = Date.parse('2026-09-24T15:00:00Z');
let ids = 0;
const app = (sb, storage) => ctx.TurfTeam.createTeam({
  supabase: { url: 'https://abcd1234.supabase.co', key: 'sb_publishable_x' },
  storage, fetch: sb.fetch, now: () => clock, uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
});
const TR = '36081019400';

await at('not set up → disabled, no network calls', async () => {
  const k = ctx.TurfTeam.createTeam({ supabase: null, storage: memoryStorage(), fetch: () => { throw new Error('no'); }, uuid: () => 'x' });
  assert.equal(k.enabled, false);
  assert.equal(k.signedIn(), false);
});
await at('sign in: wrong password refused, right one confirms the rep', async () => {
  const sb = makeTeam(); const k = app(sb, memoryStorage());
  await assert.rejects(k.signIn('gio@x.com', 'nope'), /Invalid login/);
  const me = await k.signIn(' gio@x.com ', 'pw-gio');
  assert.deepEqual({ ...me }, { name: 'Gio', is_admin: true });
});
await at('login that is not on the team cannot record', async () => {
  const sb = makeTeam(); const k = app(sb, memoryStorage());
  assert.equal(await k.signIn('stranger@x.com', 'pw-s'), null);
  assert.throws(() => k.record('4012345678', TR, 'booked'), /Sign in/);
});
await at('knock saves to the database and shows as latest', async () => {
  const sb = makeTeam(); const k = app(sb, memoryStorage());
  await k.signIn('matt@x.com', 'pw-matt');
  k.record('4012345678', TR, 'come_back', 'after_5pm');
  await k.flush();
  assert.equal(sb.knocks.length, 1);
  assert.equal(sb.knocks[0].followup, 'after_5pm');
  assert.equal(k.pendingCount(), 0);
  assert.equal(k.latest('4012345678').status, 'come_back');
  assert.equal(k.latest('4012345678').pending, false);
});
await at('no signal: knock waits on the phone, survives a reload, syncs later', async () => {
  const sb = makeTeam(); const storage = memoryStorage(); const k = app(sb, storage);
  await k.signIn('matt@x.com', 'pw-matt');
  sb.state.offline = true;
  k.record('4012345678', TR, 'booked');
  await k.flush();
  assert.equal(k.pendingCount(), 1);
  assert.equal(k.latest('4012345678').pending, true);
  const again = app(sb, storage);                         // phone closed the app and reopened it
  assert.equal(again.pendingCount(), 1);
  assert.equal(again.latest('4012345678').status, 'booked');
  sb.state.offline = false;
  await again.flush();
  assert.equal(again.pendingCount(), 0);
  assert.equal(sb.knocks.length, 1);
});
await at('signal drops after the save: retry does not double-save', async () => {
  const sb = makeTeam(); const k = app(sb, memoryStorage());
  await k.signIn('matt@x.com', 'pw-matt');
  sb.state.loseResponses = 1;                             // saved, but the phone never hears back
  k.record('4012345678', TR, 'interested');
  await k.flush();                                        // so it sends again
  assert.equal(sb.state.calls.filter((c) => c.startsWith('POST /rest/v1/knocks')).length, 2);
  assert.equal(k.pendingCount(), 0);
  assert.equal(sb.knocks.length, 1);                      // still only one row
});
await at('undo: unsent knock never reaches the server; saved knock is deleted', async () => {
  const sb = makeTeam(); const k = app(sb, memoryStorage());
  await k.signIn('matt@x.com', 'pw-matt');
  sb.state.offline = true;
  k.record('4012345678', TR, 'no_answer');
  await k.undo('4012345678');
  sb.state.offline = false;
  await k.flush();
  assert.equal(sb.knocks.length, 0);
  k.record('4012345679', TR, 'booked');
  await k.flush();
  assert.equal(sb.knocks.length, 1);
  await k.undo('4012345679');
  assert.equal(sb.knocks.length, 0);
  assert.equal(k.latest('4012345679'), null);
});
await at("team sync: Gio sees Matt's knock with his name; newest wins", async () => {
  const sb = makeTeam();
  const matt = app(sb, memoryStorage()); await matt.signIn('matt@x.com', 'pw-matt');
  matt.record('4012345678', TR, 'no_answer'); await matt.flush();
  clock += 60000;
  matt.record('4012345678', TR, 'booked'); await matt.flush();
  const gio = app(sb, memoryStorage()); await gio.signIn('gio@x.com', 'pw-gio');
  assert.equal(await gio.loadTract(TR), 1);
  assert.equal(gio.latest('4012345678').status, 'booked');
  assert.equal(gio.latest('4012345678').rep, 'Matt');
  assert.equal(gio.latest('4012345678').mine, false);
  assert.equal((await gio.tractProgress(TR)).booked, 1);
});
await at('expired login refreshes itself; sign-out blocked while knocks are unsynced', async () => {
  const sb = makeTeam(); const storage = memoryStorage(); const k = app(sb, storage);
  await k.signIn('matt@x.com', 'pw-matt');
  const tok = JSON.parse(storage.getItem('ts.session')).access_token;
  sb.state.expire.add(tok);
  assert.equal(await k.loadTract(TR), 0);
  assert.notEqual(JSON.parse(storage.getItem('ts.session')).access_token, tok);
  sb.state.offline = true;
  k.record('4012345678', TR, 'booked');
  await assert.rejects(k.signOut(), /haven't synced/);
  sb.state.offline = false;
  await k.flush();
  await k.signOut();
  assert.equal(k.signedIn(), false);
  assert.equal(storage.getItem('ts.session'), null);
});

await at('turf: Matt claims, the team sees it, anyone can change it (credited to them)', async () => {
  const sb = makeTeam();
  const matt = app(sb, memoryStorage()); await matt.signIn('matt@x.com', 'pw-matt');
  matt.setTurf(TR, 'claimed'); await matt.flush();
  const gio = app(sb, memoryStorage()); await gio.signIn('gio@x.com', 'pw-gio');
  await gio.loadTeam();
  assert.equal(gio.turf(TR).status, 'claimed');
  assert.equal(gio.turf(TR).rep, 'Matt');
  clock += 60000;
  gio.setTurf(TR, 'finished'); await gio.flush();
  await matt.loadTeam();
  assert.equal(matt.turf(TR).status, 'finished');
  assert.equal(matt.turf(TR).rep, 'Gio');
  assert.equal(sb.tables.turf_log.length, 2);            // history kept: Matt's claim is still on record
  await gio.undoTurf(TR);                                 // Gio takes back his change → Matt's claim shows again
  await gio.loadTeam();
  assert.equal(gio.turf(TR).rep, 'Matt');
  assert.equal(gio.turf(TR).status, 'claimed');
});
await at('notes: house, area and map pins shared with the team; no phone numbers or emails', async () => {
  const sb = makeTeam();
  const matt = app(sb, memoryStorage()); await matt.signIn('matt@x.com', 'pw-matt');
  assert.throws(() => matt.addNote({ tract: TR, bbl: '4012345678', body: 'call 718-555-1234' }), /phone/);
  assert.throws(() => matt.addNote({ tract: TR, body: 'jo@gmail.com' }), /email/);
  assert.throws(() => matt.addNote({ tract: TR, body: '   ' }), /Write something/);
  assert.throws(() => matt.addNote({ tract: TR, body: 'x'.repeat(281) }), /280/);
  sb.state.offline = true;                                 // notes work with no signal too
  matt.addNote({ tract: TR, bbl: '4012345678', address: '138-04 109 AVENUE', body: 'Big dog, use side gate' });
  matt.addNote({ tract: TR, body: 'Block party Saturday, skip until Monday' });
  matt.addNote({ tract: TR, lat: 40.687085, lon: -73.807189, body: 'No soliciting sign at the corner' });
  assert.equal(matt.pendingCount(), 3);
  assert.equal(matt.notesFor({ bbl: '4012345678' })[0].pending, true);
  sb.state.offline = false; await matt.flush();
  assert.equal(sb.tables.notes.length, 3);
  const gio = app(sb, memoryStorage()); await gio.signIn('gio@x.com', 'pw-gio');
  await gio.loadTract(TR); await gio.loadTeam();
  assert.equal(gio.notesFor({ bbl: '4012345678' })[0].body, 'Big dog, use side gate');
  assert.equal(gio.notesFor({ bbl: '4012345678' })[0].rep, 'Matt');
  assert.equal(gio.notesFor({ tract: TR }).length, 1);    // area note only, not the house note or the pin
  assert.equal(gio.houseNotesInTract(TR).length, 1);
  assert.equal(gio.pins().length, 1);
  assert.equal(gio.pins()[0].lat, 40.687085);
  const pinId = matt.pins()[0].client_id;
  await matt.deleteNote(pinId);
  await gio.loadTeam();
  assert.equal(gio.pins().length, 0);
});
await at('mixed offline queue (knock, claim, note) syncs in order after a reload', async () => {
  const sb = makeTeam(); const storage = memoryStorage();
  const k = app(sb, storage); await k.signIn('matt@x.com', 'pw-matt');
  sb.state.offline = true;
  k.setTurf(TR, 'claimed');
  k.record('4012345678', TR, 'come_back', 'weekend', '138-04 109 AVENUE');
  k.addNote({ tract: TR, bbl: '4012345678', body: 'Owner works nights' });
  const again = app(sb, storage);
  assert.equal(again.pendingCount(), 3);
  assert.equal(again.turf(TR).pending, true);
  sb.state.offline = false; await again.flush();
  assert.equal(again.pendingCount(), 0);
  assert.deepEqual([sb.tables.turf_log.length, sb.tables.knocks.length, sb.tables.notes.length], [1, 1, 1]);
  assert.equal(sb.tables.knocks[0].address, '138-04 109 AVENUE');
  const mine = await again.myFollowups();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].followup, 'weekend');
  const stats = await again.repStats();
  assert.equal(stats.find((r) => r.rep === 'Matt').turf_claimed, 1);
});
await at('note rule in the app matches the database rule', async () => {
  const cases = { 'call 718-555-1234': 1, 'call (718) 555 1234': 1, '7185551234': 1, 'jo@gmail.com': 1, 'house 138-04, 2 dogs': 0, 'come back after 5:30pm': 0, 'Ring 3 times': 0 };
  for (const [text, bad] of Object.entries(cases)) assert.equal(!!ctx.TurfTeam.noteProblem(text), !!bad, text);
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', '001_team_tracking.sql'), 'utf8');
  assert.ok(sql.includes("t !~ '[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{4}'"));
  assert.ok(fs.readFileSync(path.join(ROOT, 'm3-map', 'team.js'), 'utf8').includes('/[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{4}/'));
});

console.log(`\n${passed} checks passed`);
