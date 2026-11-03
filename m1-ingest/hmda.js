// m1 / HMDA: public mortgage application records (CFPB / FFIEC), tallied per census tract
// → data/raw/hmda_tracts.json. Used as a neighborhood stand-in for credit ("Financing-ready").
// Only counts are kept: applications, approvals, and denials for credit history. No one's
// credit score exists in this data, and nothing about any applicant is stored.
import { config, fetchWithRetry, writeJSON, raw, log, warn, activeCounties, isMain } from '../lib/util.js';
import { csvFields } from './elections_nyc.js';

// The API takes two filters at most (action taken + loan purpose); the rest are applied here.
// Keeps owner-occupied 1–4 family homes, skips business-purpose loans and reverse mortgages.
// action_taken: 1 originated, 2 approved but not taken, 3 denied. Denial reason 3 = credit history.
export function tallyHmda(text, cfg = {}) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows: 0, tracts: {} };
  const head = csvFields(lines[0]);
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ['census_tract', 'action_taken', 'occupancy_type', 'total_units', 'denial_reason-1']) {
    if (!(need in col)) throw new Error(`HMDA file has no ${need} column (got ${head.slice(0, 12).join(', ')}…)`);
  }
  const credit = String(cfg.credit_denial_code ?? '3');
  const units = new Set((cfg.total_units || ['1', '2', '3', '4']).map(String));
  const reasons = ['denial_reason-1', 'denial_reason-2', 'denial_reason-3', 'denial_reason-4'].filter((k) => k in col);
  const tracts = {};
  let kept = 0;
  for (let i = 1; i < lines.length; i++) {
    const r = csvFields(lines[i]);
    const g = r[col.census_tract];
    const act = r[col.action_taken];
    if (!/^\d{11}$/.test(g) || !['1', '2', '3'].includes(act)) continue;
    if (r[col.occupancy_type] !== '1' || !units.has(r[col.total_units])) continue;
    if ('business_or_commercial_purpose' in col && r[col.business_or_commercial_purpose] === '1') continue;
    if ('reverse_mortgage' in col && r[col.reverse_mortgage] === '1') continue;
    const t = tracts[g] || (tracts[g] = { apps: 0, approved: 0, credit_denied: 0 });
    t.apps++;
    if (act !== '3') t.approved++;
    else if (reasons.some((k) => r[col[k]] === credit)) t.credit_denied++;
    kept++;
  }
  return { rows: kept, tracts };
}

export async function runHmda() {
  const src = config('sources.json').hmda;
  const counties = activeCounties();
  for (const year of src.years_to_try) {
    const tracts = {}, counts = {};
    let ok = true;
    for (const c of counties) {
      const url = `${src.base}?years=${year}&counties=${config('areas.json').state_fips}${c.fips}&actions_taken=1,2,3&loan_purposes=${src.loan_purposes}`;
      let res;
      try {
        res = tallyHmda(await (await fetchWithRetry(url)).text(), src);   // fetch follows the API's redirect to a cached file
      } catch (e) {
        warn(`HMDA ${year} · ${c.name}: ${e.message.split('\n')[0]}`);
        ok = false; break;
      }
      if (res.rows < (src.min_rows_per_county ?? 1000)) { warn(`HMDA ${year} · ${c.name}: only ${res.rows} applications — not published yet?`); ok = false; break; }
      Object.assign(tracts, res.tracts);
      counts[c.name] = { rows: res.rows, tracts: Object.keys(res.tracts).length };
    }
    if (!ok) continue;
    log(`HMDA ${year} · ${Object.entries(counts).map(([n, x]) => `${n} ${x.rows.toLocaleString()} applications in ${x.tracts} tracts`).join(' · ')}`);
    writeJSON(raw('hmda_tracts.json'), { year, source: src.credit, tracts });
    return Object.keys(tracts).length;
  }
  throw new Error(`No HMDA year usable (tried ${src.years_to_try.join(', ')})`);
}

if (isMain(import.meta.url)) runHmda().catch((e) => { console.error(e); process.exit(1); });
