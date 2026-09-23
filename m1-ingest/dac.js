// m1 / DAC: NYS Disadvantaged Communities (2010 tracts) + 2020↔2010 tract crosswalk
//   → data/raw/dac_2010.json, data/raw/tract_rel.json
import { config, fetchJSON, fetchText, writeJSON, raw, log, warn, activeCounties, isMain } from '../lib/util.js';

export function detectDacFields(row, cfg) {
  const keys = Object.keys(row);
  const geoid = cfg.geoid_field || keys.find((k) => /geoid/i.test(k));
  const dac = cfg.dac_field || keys.find((k) => /dac_desig|designat/i.test(k)) || keys.find((k) => /^dac$/i.test(k));
  return { geoid, dac };
}

export function isDac(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return false;
  if (/not/.test(s)) return false;
  return /designated|^yes$|^true$|^1$|^y$/.test(s);
}

// Parse the Census pipe-delimited 2020↔2010 tract relationship file.
export function parseRelationship(text, countyPrefixes) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split('|');
  const iG20 = header.indexOf('GEOID_TRACT_20');
  const iG10 = header.indexOf('GEOID_TRACT_10');
  const iLand = header.indexOf('AREALAND_PART');
  if (iG20 < 0 || iG10 < 0 || iLand < 0) throw new Error(`Unexpected relationship header: ${lines[0]}`);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split('|');
    const g20 = p[iG20];
    if (countyPrefixes && !countyPrefixes.some((c) => g20.startsWith(c))) continue;
    out.push({ g20, g10: p[iG10], land: Number(p[iLand]) || 0 });
  }
  return out;
}

export async function runDAC() {
  const src = config('sources.json');
  const { state_fips } = config('areas.json');
  const prefixes = activeCounties().map((c) => `${state_fips}${c.fips}`);

  // DAC list (≈4,900 NY tracts, one page)
  const rows = await fetchJSON(`${src.dac.url}?$limit=10000`);
  if (!rows.length) throw new Error('DAC dataset returned no rows');
  const f = detectDacFields(rows[0], src.dac);
  if (!f.geoid || !f.dac) {
    throw new Error(`Could not detect DAC fields. Columns: ${Object.keys(rows[0]).join(', ')}. Set dac.geoid_field / dac.dac_field in config/sources.json.`);
  }
  const dac10 = {};
  for (const r of rows) {
    const g = String(r[f.geoid] ?? '').split('.')[0];
    if (g.length === 11) dac10[g] = isDac(r[f.dac]);
  }
  const nDac = Object.values(dac10).filter(Boolean).length;
  log(`DAC · ${Object.keys(dac10).length} tracts (${nDac} DAC) · fields ${f.geoid} / ${f.dac}`);
  writeJSON(raw('dac_2010.json'), dac10);

  // Crosswalk — DAC is on 2010 tracts, everything else is on 2020 tracts.
  try {
    const rel = parseRelationship(await fetchText(src.tract_relationship.url), prefixes);
    writeJSON(raw('tract_rel.json'), rel);
    log(`Crosswalk · ${rel.length} 2020↔2010 tract pieces`);
  } catch (e) {
    warn(`Tract crosswalk failed — DAC will only match tracts whose GEOID did not change. ${e.message.split('\n')[0]}`);
  }
  return nDac;
}

if (isMain(import.meta.url)) runDAC().catch((e) => { console.error(e); process.exit(1); });
