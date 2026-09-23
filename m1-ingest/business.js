// m1 / NYC licensed businesses (DCWP) at a lot → data/raw/business_by_bbl.json  { bbl: [category, …] }
// Only active Premises licenses: a business operating at that address. Individual licenses
// (e.g. a licensed salesperson registered at home) are people, not businesses, and are skipped.
// Only the category is kept — no business names, phone numbers or license numbers.
import { config, fetchJSON, writeJSON, raw, log, activeCounties, isMain } from '../lib/util.js';

export async function runBusiness() {
  const src = config('sources.json').business_licenses;
  const boroughs = activeCounties().filter((c) => c.nyc).map((c) => c.name);
  if (!boroughs.length) { log('Businesses · no active NYC boroughs, skipping'); return 0; }
  const headers = process.env.NYC_APP_TOKEN ? { 'X-App-Token': process.env.NYC_APP_TOKEN } : {};

  const byBbl = {};
  let n = 0;
  for (let offset = 0; ; offset += src.page_size) {
    const params = new URLSearchParams({
      $select: 'bbl,business_category',
      $where: `license_type='Premises' AND license_status='Active' AND bbl IS NOT NULL AND address_borough IN (${boroughs.map((b) => `'${b}'`).join(',')})`,
      $order: 'bbl',
      $limit: String(src.page_size),
      $offset: String(offset),
    });
    const batch = await fetchJSON(`${src.url}?${params}`, { headers });
    for (const r of batch) {
      const bbl = String(r.bbl).split('.')[0];
      const cat = String(r.business_category || 'Licensed business').trim();
      if (!/^\d{10}$/.test(bbl)) continue;
      const list = (byBbl[bbl] ||= []);
      if (!list.includes(cat)) list.push(cat);
      n++;
    }
    if (batch.length < src.page_size) break;
  }
  log(`Businesses · ${n} active premises licenses on ${Object.keys(byBbl).length} lots (${boroughs.join(', ')})`);
  writeJSON(raw('business_by_bbl.json'), byBbl);
  return n;
}

if (isMain(import.meta.url)) runBusiness().catch((e) => { console.error(e); process.exit(1); });
