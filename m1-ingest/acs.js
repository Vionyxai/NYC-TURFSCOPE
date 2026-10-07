// m1 / ACS: tract-level Census data for active counties → data/raw/acs_tracts.json
import { config, fetchJSON, writeJSON, raw, log, warn, activeCounties, num, isMain } from '../lib/util.js';

// B19001 household income brackets: [variable suffix, upper bound of bracket]
export const B19001_BRACKETS = [
  ['002', 10000], ['003', 15000], ['004', 20000], ['005', 25000], ['006', 30000],
  ['007', 35000], ['008', 40000], ['009', 45000], ['010', 50000], ['011', 60000],
  ['012', 75000], ['013', 100000], ['014', 125000], ['015', 150000], ['016', 200000],
  ['017', Infinity],
];

const pad3 = (n) => String(n).padStart(3, '0');
const series = (table, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${table}_${pad3(from + i)}E`);

// B03002 Hispanic or Latino origin by race: total, then the groups shown on the tract card.
// Display only. Race is never used in the TurfScore or in any filter.
export const RACE_GROUPS = {
  hispanic: ['012'],            // Hispanic or Latino, any race
  white: ['003'],               // not Hispanic: White alone
  black: ['004'],               // not Hispanic: Black alone
  asian: ['006'],               // not Hispanic: Asian alone
  other: ['005', '007', '008', '009'], // not Hispanic: Native American, Pacific Islander, other, two or more
};
export const RACE_VARS = ['B03002_001E', ...Object.values(RACE_GROUPS).flat().map((c) => `B03002_${c}E`)];
// Retired households: households with retirement income (pension, 401k/IRA payouts) and with Social Security.
export const RETIRED_VARS = ['B19059_001E', 'B19059_002E', 'B19055_001E', 'B19055_002E'];

export const MAIN_VARS = [
  'B19013_001E',                                   // median household income
  'B19001_001E', ...B19001_BRACKETS.map(([c]) => `B19001_${c}E`), // income distribution
  ...series('B25040', 1, 10),                      // house heating fuel
  'B25035_001E',                                   // median year structure built
  ...series('B25024', 1, 5),                       // units in structure (total, 1 det, 1 att, 2, 3-4)
  'B25003_001E', 'B25003_002E',                    // tenure: occupied, owner-occupied
  ...series('B25007', 2, 11),                      // owner-occupied households by age of householder
  'B25018_001E',                                   // median rooms (house size outside NYC)
];

// Pick B25034 (year built) variables for decades before 1980 by reading labels,
// so we never depend on line numbers that change between ACS vintages.
export function pre1980Codes(groupVariables) {
  const codes = [];
  for (const [code, v] of Object.entries(groupVariables)) {
    if (!/^B25034_\d{3}E$/.test(code)) continue;
    const label = v.label || '';
    if (/1939 or earlier/i.test(label)) { codes.push(code); continue; }
    const m = label.match(/Built (\d{4}) to (\d{4})/i);
    if (m && Number(m[2]) < 1980) codes.push(code);
  }
  return codes.sort();
}

// Language spoken at home (B16001 detailed, or C16001 collapsed). Read from labels, like
// pre1980Codes, so line numbers can change between vintages. Labels look like
//   Estimate!!Total:                                     → people 5 and older
//   Estimate!!Total:!!Speak only English
//   Estimate!!Total:!!Spanish:                           → speak Spanish at home
//   Estimate!!Total:!!Spanish:!!Speak English less than "very well"
export function languageCodes(groupVariables, table) {
  const out = { table, total: null, english: null, items: [] };
  const byName = new Map();
  for (const [code, v] of Object.entries(groupVariables).sort(([a], [b]) => a.localeCompare(b))) {
    if (!new RegExp(`^${table}_\\d{3}E$`).test(code)) continue;
    const parts = String(v.label || '').split('!!').map((x) => x.replace(/:$/, '').trim());
    if (parts.length === 2 && /^Total$/i.test(parts[1])) out.total = code;
    else if (parts.length === 3 && /only English/i.test(parts[2])) out.english = code;
    else if (parts.length === 3) { const it = { name: parts[2], total: code, lep: null }; byName.set(parts[2], it); out.items.push(it); }
    else if (parts.length === 4 && /less than/i.test(parts[3]) && byName.has(parts[2])) byName.get(parts[2]).lep = code;
  }
  return out;
}

// Place of birth for people born abroad (B05006): every country line (a label with nothing under it).
// "Other ..." catch-all lines are skipped because they don't name a country.
export function birthplaceCodes(groupVariables) {
  const rows = Object.entries(groupVariables)
    .filter(([code]) => /^B05006_\d{3}E$/.test(code))
    .map(([code, v]) => ({ code, label: String(v.label || '').replace(/:$/, '') }));
  const total = rows.find((r) => r.label.split('!!').length === 2)?.code || null;
  const items = rows
    .filter((r) => r.label.split('!!').length > 2 && !rows.some((o) => o.label.startsWith(`${r.label}:!!`) || o.label.startsWith(`${r.label}!!`)))
    .map((r) => ({ name: r.label.split('!!').pop().replace(/:$/, '').trim(), code: r.code }))
    .filter((r) => !/^Other\b/i.test(r.name))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { total, items };
}

// Census answers a missing/bad key with an HTML page. Turn that into a clear instruction.
async function censusJSON(url) {
  try {
    return await fetchJSON(url);
  } catch (e) {
    if (/Missing Key|Invalid Key/i.test(e.message)) {
      throw new Error('Census API key missing or invalid. Get a free key at https://api.census.gov/data/key_signup.html and set CENSUS_API_KEY (in .env locally, or as a GitHub Actions secret).');
    }
    throw e;
  }
}

function rowsToObjects(arr) {
  const [header, ...rows] = arr;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export async function runACS() {
  const src = config('sources.json').acs;
  const { state_fips } = config('areas.json');
  const key = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : '';

  // 1) Find the newest ACS 5-year vintage that is live.
  let year = null;
  let group = null;
  for (const y of src.years_to_try) {
    try {
      group = await fetchJSON(`${src.base}/${y}/acs/acs5/groups/B25034.json`);
      year = y;
      break;
    } catch (e) {
      warn(`ACS ${y} not available (${e.message.split('\n')[0]}) — trying older`);
    }
  }
  if (!year) throw new Error('No ACS 5-year vintage reachable. Check config/sources.json acs.years_to_try.');
  const pre = pre1980Codes(group.variables);
  if (!pre.length) throw new Error('Could not detect pre-1980 B25034 variables from labels.');
  log(`ACS ${year} 5-year · pre-1980 vars: ${pre.join(', ')}`);

  const ageVars = ['B25034_001E', ...pre];
  const rows = new Map();

  for (const c of activeCounties()) {
    for (const vars of [MAIN_VARS, ageVars, [...RACE_VARS, ...RETIRED_VARS]]) {   // the API takes at most 50 variables per request (NAME counts)
      const url = `${src.base}/${year}/acs/acs5?get=NAME,${vars.join(',')}&for=tract:*&in=state:${state_fips}&in=county:${c.fips}${key}`;
      const data = rowsToObjects(await censusJSON(url));
      for (const r of data) {
        const geoid = `${r.state}${r.county}${r.tract}`;
        const row = rows.get(geoid) || { geoid, name: r.NAME, v: {} };
        for (const k of vars) row.v[k] = num(r[k]);
        rows.set(geoid, row);
      }
    }
    log(`ACS · ${c.name}: ${[...rows.keys()].filter((g) => g.slice(2, 5) === c.fips).length} tracts`);
  }

  // Languages at home and places of birth: big tables, so fetch them in chunks
  // (the API takes at most 50 variables per request).
  const groupVars = async (table) => (await fetchJSON(`${src.base}/${year}/acs/acs5/groups/${table}.json`)).variables;
  const fetchChunked = async (vars, c) => {
    for (let i = 0; i < vars.length; i += 45) {
      const chunk = vars.slice(i, i + 45);
      const url = `${src.base}/${year}/acs/acs5?get=${chunk.join(',')}&for=tract:*&in=state:${state_fips}&in=county:${c.fips}${key}`;
      for (const r of rowsToObjects(await censusJSON(url))) {
        const row = rows.get(`${r.state}${r.county}${r.tract}`);
        if (row) for (const k of chunk) row.v[k] = num(r[k]);
      }
    }
  };
  let languages = null, birthplaces = null;
  for (const table of src.language_tables || ['B16001', 'C16001']) {
    try {
      const meta = languageCodes(await groupVars(table), table);
      if (!meta.total || !meta.items.length) throw new Error('no language lines found in the labels');
      const vars = [meta.total, meta.english, ...meta.items.flatMap((x) => [x.total, x.lep])].filter(Boolean);
      for (const c of activeCounties()) await fetchChunked(vars, c);
      // Some detailed tables answer for tracts but with every value blank (published for bigger areas only).
      const filled = [...rows.values()].filter((r) => r.v[meta.total] > 0).length;
      if (filled < rows.size / 2) throw new Error(`only ${filled} of ${rows.size} tracts have values`);
      languages = meta;
      log(`ACS · languages from ${table}: ${meta.items.length} languages`);
      break;
    } catch (e) {
      warn(`ACS · ${table} languages unavailable for tracts (${e.message.split('\n')[0]}) — trying the next table`);
    }
  }
  try {
    const meta = birthplaceCodes(await groupVars('B05006'));
    if (!meta.total || !meta.items.length) throw new Error('no country lines found in the labels');
    for (const c of activeCounties()) await fetchChunked([meta.total, ...meta.items.map((x) => x.code)], c);
    birthplaces = meta;
    log(`ACS · places of birth (B05006): ${meta.items.length} countries`);
  } catch (e) {
    warn(`ACS · places of birth unavailable (${e.message.split('\n')[0]}) — the map will skip "born abroad"`);
  }

  writeJSON(raw('acs_tracts.json'), { year, pre1980_codes: pre, languages, birthplaces, rows: [...rows.values()] });
  return rows.size;
}

if (isMain(import.meta.url)) runACS().catch((e) => { console.error(e); process.exit(1); });
