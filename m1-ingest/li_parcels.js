// m1 / Long Island homes from the NYS assessment roll → data/raw/li_parcels.json
// One row per 1–3 family property in Nassau and Suffolk: address, home type and, where the town
// assessor reports it (parts of Suffolk), year built, living sq ft and heating fuel.
// Only address and building fields are requested. Owner names and mailing addresses are never pulled.
import { config, fetchJSON, writeJSON, raw, log, activeCounties, isMain } from '../lib/util.js';

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

async function query(src, where, extra = {}) {
  const params = new URLSearchParams({ where, f: 'json', ...extra });
  const j = await fetchJSON(`${src.url}?${params}`);
  if (j.error) throw new Error(`NYS parcels: ${j.error.message || JSON.stringify(j.error)}`);
  return j;
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
    // Split the county into OBJECTID ranges and page through each with "OBJECTID > last" (stable, no offsets).
    const st = await query(src, base, {
      outStatistics: JSON.stringify([
        { statisticType: 'min', onStatisticField: 'OBJECTID', outStatisticFieldName: 'lo' },
        { statisticType: 'max', onStatisticField: 'OBJECTID', outStatisticFieldName: 'hi' },
      ]),
    });
    const { lo, hi } = st.features[0].attributes;
    const n = src.parallel;
    const step = Math.ceil((hi - lo + 1) / n);
    let kept = 0, seen = 0;
    await Promise.all(Array.from({ length: n }, async (_, i) => {
      let last = lo + i * step - 1;
      const end = Math.min(hi, lo + (i + 1) * step - 1);
      while (last < end) {
        const j = await query(src, `${base} AND OBJECTID > ${last} AND OBJECTID <= ${end}`, {
          outFields: src.fields.join(','), orderByFields: 'OBJECTID', resultRecordCount: String(src.page_size),
          returnGeometry: 'true', outSR: '4326',
        });
        const feats = j.features || [];
        for (const f of feats) {
          seen++;
          const lot = parcelToLot(f.attributes, f.geometry, classes);
          if (lot) { lots.push(lot); kept++; }
        }
        if (!feats.length) break;
        last = feats[feats.length - 1].attributes.OBJECTID;
      }
    }));
    const withFuel = lots.filter((l) => l.fuel).length;
    log(`LI parcels · ${c.name}: ${kept} homes kept of ${seen} residential parcels (fuel on record so far: ${withFuel})`);
  }
  writeJSON(raw('li_parcels.json'), lots);
  return lots.length;
}

if (isMain(import.meta.url)) runLiParcels().catch((e) => { console.error(e); process.exit(1); });
