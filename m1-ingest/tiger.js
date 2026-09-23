// m1 / TIGERweb: 2020 census tract polygons + internal points → data/raw/tracts_geo.json
import { config, fetchJSON, writeJSON, raw, log, activeCounties, isMain } from '../lib/util.js';

export async function runTiger() {
  const src = config('sources.json').tigerweb;
  const { state_fips } = config('areas.json');

  // Look up the layer id by name instead of hardcoding it.
  const meta = await fetchJSON(`${src.service}?f=json`);
  const layer = (meta.layers || []).find((l) => l.name === src.tract_layer_name);
  if (!layer) {
    const names = (meta.layers || []).map((l) => `${l.id}:${l.name}`).join(' | ');
    throw new Error(`TIGERweb layer "${src.tract_layer_name}" not found. Available: ${names}`);
  }

  const features = [];
  for (const c of activeCounties()) {
    let offset = 0;
    let got = 0;
    while (true) {
      const params = new URLSearchParams({
        where: `STATE='${state_fips}' AND COUNTY='${c.fips}'`,
        outFields: 'GEOID,STATE,COUNTY,TRACT,INTPTLAT,INTPTLON,AREALAND',
        orderByFields: 'GEOID', // stable order so paging never skips or repeats tracts
        returnGeometry: 'true',
        outSR: '4326',
        geometryPrecision: '5',
        maxAllowableOffset: String(src.simplify_deg),
        resultOffset: String(offset),
        resultRecordCount: String(src.page_size),
        f: 'geojson',
      });
      const fc = await fetchJSON(`${src.service}/${layer.id}/query?${params}`);
      const batch = fc.features || [];
      features.push(...batch);
      got += batch.length;
      if (batch.length < src.page_size) break;
      offset += src.page_size;
    }
    log(`TIGER · ${c.name}: ${got} tract polygons`);
  }

  writeJSON(raw('tracts_geo.json'), { type: 'FeatureCollection', features });
  return features.length;
}

if (isMain(import.meta.url)) runTiger().catch((e) => { console.error(e); process.exit(1); });
