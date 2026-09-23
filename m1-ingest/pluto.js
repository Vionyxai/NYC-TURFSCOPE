// m1 / PLUTO: NYC tax lots with residential units for active NYC boroughs → data/raw/pluto_lots.json
import { config, fetchJSON, writeJSON, raw, log, activeCounties, num, isMain } from '../lib/util.js';

const BORO_DIGIT_TO_COUNTY = { 1: '061', 2: '005', 3: '047', 4: '081', 5: '085' };

// bct2020 = borough digit + 6-digit 2020 tract code (e.g. "4012300" → 36081012300).
export function plutoTractGeoid(bct2020) {
  if (bct2020 === null || bct2020 === undefined || bct2020 === '') return null;
  const s = String(bct2020).split('.')[0].trim();
  const county = BORO_DIGIT_TO_COUNTY[s[0]];
  const tract = s.slice(1);
  if (!county || !tract) return null;
  return `36${county}${tract.padStart(6, '0')}`;
}

export async function runPluto() {
  const src = config('sources.json').pluto;
  const boroughs = activeCounties().filter((c) => c.nyc).map((c) => c.borough);
  if (!boroughs.length) { log('PLUTO · no active NYC boroughs, skipping'); return 0; }
  const headers = process.env.NYC_APP_TOKEN ? { 'X-App-Token': process.env.NYC_APP_TOKEN } : {};

  const lots = [];
  for (const b of boroughs) {
    let offset = 0;
    let kept = 0;
    while (true) {
      const params = new URLSearchParams({
        $select: src.fields.join(','),
        $where: `borough='${b}'`,
        $order: 'bbl',
        $limit: String(src.page_size),
        $offset: String(offset),
      });
      const batch = await fetchJSON(`${src.url}?${params}`, { headers });
      for (const r of batch) {
        const units = num(r.unitsres);
        if (!units || units < 1) continue; // residential lots only
        lots.push({
          bbl: String(r.bbl).split('.')[0],
          boro: r.borough,
          block: num(r.block),
          address: r.address || '',
          zip: r.zipcode ? String(r.zipcode).split('.')[0] : '',
          cls: r.bldgclass || '',
          units,
          year: num(r.yearbuilt) || null,
          lat: num(r.latitude),
          lon: r.longitude != null ? Number(r.longitude) : null, // longitudes are negative; don't run through num()
          tract: plutoTractGeoid(r.bct2020),
        });
        kept++;
      }
      if (batch.length < src.page_size) break;
      offset += src.page_size;
    }
    log(`PLUTO · ${b}: ${kept} residential lots`);
  }

  writeJSON(raw('pluto_lots.json'), lots);
  return lots.length;
}

if (isMain(import.meta.url)) runPluto().catch((e) => { console.error(e); process.exit(1); });
