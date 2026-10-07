// m1 / Elections, Suffolk: official 2024 presidential results by election district (Suffolk County
// Board of Elections results file, as archived by OpenElections) joined to the county's own election
// district map (Suffolk open data) → data/raw/precincts_suffolk.json
import { config, fetchWithRetry, writeJSON, raw, log, warn, activeCounties, isMain } from '../lib/util.js';
import { roundGeometry } from '../lib/geo.js';

// The BOE file is fixed-width text, one race after another:
//   ....R<race name>                           → a race starts
//   ....C<candidate name, 25 chars><party> <county total>   → candidates, in column order
//   ....E<ED id, 4 digits>P...                 → one election district; votes are 4-digit columns
//                                                 starting at character 44 (two count columns, then one per candidate)
// ED id = town digit + 3-digit district (e.g. 1235 = Brookhaven ED 235), the same as the map's PRECINCTID.
export function parseSuffolkResults(text, { race, dem_parties, rep_parties, first_vote_col = 44, count_cols = 2, width = 4 }) {
  const dem = new Set(dem_parties), rep = new Set(rep_parties);
  const out = new Map();
  let inRace = false;
  const cands = [];
  for (const l of text.split(/\r?\n/)) {
    const kind = l[4];
    if (kind === 'R') { if (inRace) break; inRace = l.slice(5).trim().toLowerCase().startsWith(race.toLowerCase()); continue; }
    if (!inRace) continue;
    if (kind === 'C') {
      const m = l.slice(30).match(/^(\S{2,4})?\s*S?(\d{6})/);
      cands.push({ name: l.slice(5, 30).trim(), party: m && m[1] && !/^S\d/.test(m[1]) ? m[1] : null, total: m ? Number(m[2]) : 0 });
    } else if (kind === 'E') {
      const id = l.slice(5, 9);
      const r = { dem: 0, rep: 0, total: 0 };
      cands.forEach((c, i) => {
        const at = first_vote_col + (count_cols + i) * width;
        const n = Number(l.slice(at, at + width)) || 0;
        r.total += n;
        if (dem.has(c.party)) r.dem += n; else if (rep.has(c.party)) r.rep += n;
      });
      out.set(id, r);
    }
  }
  return { districts: out, candidates: cands };
}

export async function runElectionsSuffolk() {
  const src = config('sources.json').elections_suffolk;
  if (!src || !activeCounties().some((c) => c.fips === '103')) { log('Elections Suffolk · not configured or Suffolk inactive, skipping'); return 0; }
  const text = await (await fetchWithRetry(src.url)).text();
  const { districts, candidates } = parseSuffolkResults(text, src);
  // Check the decoding: each candidate's districts must add up to the county total printed in the file.
  for (const [i, c] of candidates.entries()) {
    if (!c.total) continue;
    const at = (src.first_vote_col ?? 44) + ((src.count_cols ?? 2) + i) * (src.width ?? 4);
    let sum = 0;
    for (const l of text.split(/\r?\n/)) if (l[4] === 'E' && districts.has(l.slice(5, 9))) { sum += Number(l.slice(at, at + 4)) || 0; }
    if (sum < c.total) warn(`Elections Suffolk · ${c.name} (${c.party}) districts add to ${sum}, county total ${c.total}`);
  }
  const shapes = [];
  for (let offset = 0; ; offset += src.page_size) {
    const params = new URLSearchParams({ where: '1=1', outFields: 'PRECINCTID', outSR: '4326', f: 'geojson', resultOffset: String(offset), resultRecordCount: String(src.page_size) });
    const page = await (await fetchWithRetry(`${src.shapes_url}?${params}`)).json();
    if (page.error) throw new Error(`Suffolk district map: ${page.error.message}`);
    shapes.push(...(page.features || []));
    if ((page.features || []).length < src.page_size) break;
  }
  const precincts = [];
  for (const f of shapes) {
    const id = String(f.properties && f.properties.PRECINCTID).padStart(4, '0');
    const r = districts.get(id);
    if (!r || !f.geometry || r.total <= 0) continue;
    precincts.push({ id: `Suffolk ED ${id}`, county: '103', ...r, geometry: roundGeometry(f.geometry, 5) });
  }
  const dem = precincts.reduce((s, p) => s + p.dem, 0), rep = precincts.reduce((s, p) => s + p.rep, 0);
  log(`Elections Suffolk · ${src.year} president · ${districts.size} districts in results, ${shapes.length} on the map, ${precincts.length} joined · Harris ${dem} · Trump ${rep}`);
  if (!precincts.length) throw new Error('no Suffolk election districts joined');
  writeJSON(raw('precincts_suffolk.json'), { year: src.year, source: src.credit, precincts });
  return precincts.length;
}

if (isMain(import.meta.url)) runElectionsSuffolk().catch((e) => { console.error(e); process.exit(1); });
