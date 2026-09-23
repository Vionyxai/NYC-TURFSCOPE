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

export const MAIN_VARS = [
  'B19013_001E',                                   // median household income
  'B19001_001E', ...B19001_BRACKETS.map(([c]) => `B19001_${c}E`), // income distribution
  ...series('B25040', 1, 10),                      // house heating fuel
  'B25035_001E',                                   // median year structure built
  ...series('B25024', 1, 5),                       // units in structure (total, 1 det, 1 att, 2, 3-4)
  'B25003_001E', 'B25003_002E',                    // tenure: occupied, owner-occupied
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
    for (const vars of [MAIN_VARS, ageVars]) {
      const url = `${src.base}/${year}/acs/acs5?get=NAME,${vars.join(',')}&for=tract:*&in=state:${state_fips}&in=county:${c.fips}${key}`;
      const data = rowsToObjects(await fetchJSON(url));
      for (const r of data) {
        const geoid = `${r.state}${r.county}${r.tract}`;
        const row = rows.get(geoid) || { geoid, name: r.NAME, v: {} };
        for (const k of vars) row.v[k] = num(r[k]);
        rows.set(geoid, row);
      }
    }
    log(`ACS · ${c.name}: ${[...rows.keys()].filter((g) => g.slice(2, 5) === c.fips).length} tracts`);
  }

  writeJSON(raw('acs_tracts.json'), { year, pre1980_codes: pre, rows: [...rows.values()] });
  return rows.size;
}

if (isMain(import.meta.url)) runACS().catch((e) => { console.error(e); process.exit(1); });
