// m1 / Long Island homes from the NYS assessment roll → data/raw/li_parcels.json
// One row per 1–3 family property in Nassau and Suffolk: address, home type and, where the town
// assessor reports it (parts of Suffolk), year built, living sq ft and heating fuel.
// Only address and building fields are requested. Owner names and mailing addresses are never pulled.
import { config, fetchJSON, writeJSON, raw, log, warn, sleep, activeCounties, isMain } from '../lib/util.js';

// "OIL" → "oil"; the state uses words like Oil, Gas, Electric, Propane/LPG, Unknown, None.
export function fuelKey(desc) {
  const d = String(desc || '').trim().toLowerCase();
  if (!d || d === 'unknown' || d === 'none') return null;
  if (d.startsWith('oil')) return 'oil';
  if (d.startsWith('gas')) return 'gas';
  if (d.startsWith('elec')) return 'electric';
  if (d.startsWith('propane') || d.includes('lpg')) return 'propane';
  return 'other';
}

// Turn one state record into our walk-list lot (or null to skip it).
export function parcelToLot(a, g, classes) {
  const cls = String(a.PROP_CLASS || '').trim();
  const units = classes.units[cls];
  const address = String(a.PARCEL_ADDR || '').trim().replace(/\s+/g, ' ');
  if (!units || !address || !g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  const year = Number(a.YR_BLT) > 1800 ? Number(a.YR_BLT) : null;
  const sqft = Number(a.SQFT_LIVING) > 0 ? Math.round(Number(a.SQFT_LIVING)) : null;
  return {
    id: String(a.SWIS_PRINT_KEY_ID || '').trim(),
    address,
    zip: a.LOC_ZIP ? String(a.LOC_ZIP).trim().slice(0, 5) : '',
    town: a.CITYTOWN_NAME ? String(a.CITYTOWN_NAME).trim() : '',
    cls,
    units,
    year,
    sqft,
    fuel: fuelKey(a.FUEL_TYPE_DESC),
    heat: a.HEAT_TYPE_DESC && !/^unknown$/i.test(a.HEAT_TYPE_DESC) ? String(a.HEAT_TYPE_DESC).trim() : null,
    biz: classes.business_on_site.includes(cls),
    lat: Math.round(g.y * 1e6) / 1e6,
    lon: Math.round(g.x * 1e6) / 1e6,
  };
}

// The server upper-cases statistic names ("lo" comes back as "LO"), so read them either way.
export function statRange(j) {
  const a = (j && j.features && j.features[0] && j.features[0].attributes) || {};
  const get = (k) => a[k] ?? a[k.toUpperCase()];
  const lo = Number(get('lo')), hi = Number(get('hi'));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`NYS parcels: no OBJECTID range in ${JSON.stringify(a)}`);
  return { lo, hi };
}

// The state server sometimes answers with an error inside a normal response when it's busy.
// Retry those a few times before giving up, and say which request failed.
async function query(src, where, extra = {}, tries = 5) {
  const params = new URLSearchParams({ where, f: 'json', ...extra });
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const j = await fetchJSON(`${src.url}?${params}`);
      if (!j.error) return j;
      last = new Error(j.error.message || JSON.stringify(j.error));
    } catch (e) { last = e; }
    if (i < tries - 1) await sleep(2000 * 2 ** i);
  }
  const what = extra.outStatistics ? 'id range' : `page ${where.replace(/.*AND OBJECTID/, 'OBJECTID')}`;
  throw new Error(`NYS parcels (${what}): ${last.message.split('\n')[0]}`);
}

// Pages through one OBJECTID range (or everything after \`from\` when \`to\` is null), 1,000 at a time.
async function pageRange(src, base, from, to, onPage) {
  let last = from;
  while (to == null || last < to) {
    const j = await query(src, `${base} AND OBJECTID > ${last}${to == null ? '' : ` AND OBJECTID <= ${to}`}`, {
      outFields: src.fields.join(','), orderByFields: 'OBJECTID', resultRecordCount: String(src.page_size),
      returnGeometry: 'true', outSR: '4326',
    });
    const feats = j.features || [];
    if (!feats.length) break;
    onPage(feats);
    last = feats[feats.length - 1].attributes.OBJECTID;
  }
}

export async function runLiParcels() {
  const src = config('sources.json').li_parcels;
  const classes = config('scoring.json').li_property_classes;
  const active = activeCounties().filter((c) => src.counties[c.fips]);
  if (!active.length) { log('LI parcels · no active Long Island counties, skipping'); return 0; }
  const classList = Object.keys(classes.units).map((c) => `'${c}'`).join(',');

  const lots = [];
  for (const c of active) {
    const base = `COUNTY_NAME='${src.counties[c.fips]}' AND PROP_CLASS IN (${classList})`;
    let kept = 0, seen = 0;
    const onPage = (feats) => {
      for (const f of feats) {
        seen++;
        const lot = parcelToLot(f.attributes, f.geometry, classes);
        if (lot) { lots.push(lot); kept++; }
      }
    };
    // Faster: split the county into OBJECTID ranges and download them side by side.
    // If the server won't compute the range, fall back to one page after another.
    let range = null;
    try {
      range = statRange(await query(src, base, {
        outStatistics: JSON.stringify([
          { statisticType: 'min', onStatisticField: 'OBJECTID', outStatisticFieldName: 'lo' },
          { statisticType: 'max', onStatisticField: 'OBJECTID', outStatisticFieldName: 'hi' },
        ]),
      }, 3));
    } catch (e) {
      warn(`LI parcels · ${c.name}: ${e.message} — downloading one page at a time instead`);
    }
    if (range) {
      const n = src.parallel;
      const step = Math.ceil((range.hi - range.lo + 1) / n);
      await Promise.all(Array.from({ length: n }, (_, i) =>
        pageRange(src, base, range.lo + i * step - 1, Math.min(range.hi, range.lo + (i + 1) * step - 1), onPage)));
    } else {
      await pageRange(src, base, 0, null, onPage);
    }
    if (!kept) throw new Error(`NYS parcels: 0 homes for ${c.name} (${seen} parcels read) — check the service and property classes`);
    const withFuel = lots.filter((l) => l.fuel).length;
    log(`LI parcels · ${c.name}: ${kept} homes kept of ${seen} residential parcels (fuel on record so far: ${withFuel})`);
  }
  writeJSON(raw('li_parcels.json'), lots);
  return lots.length;
}

if (isMain(import.meta.url)) runLiParcels().catch((e) => { console.error(e); process.exit(1); });
