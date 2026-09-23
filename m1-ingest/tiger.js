// m1 / TIGERweb: 2020 census tract polygons + internal points → data/raw/tracts_geo.json
import { config, fetchJSON, readJSONIfExists, writeJSON, raw, log, warn, activeCounties, isMain } from '../lib/util.js';

// Find a TIGERweb layer by name. Prefers the vintage matching the ACS year (ACS runs
// first and records it): "Current" can have newer tract splits the ACS data doesn't
// know about yet. Falls back to Current.
async function findLayer(src, layerName) {
  const acsYear = readJSONIfExists(raw('acs_tracts.json'))?.year;
  const candidates = [acsYear && src.service.replace('{year}', acsYear), src.fallback_service].filter(Boolean);
  for (const url of candidates) {
    try {
      // Look up the layer id by name instead of hardcoding it.
      const meta = await fetchJSON(`${url}?f=json`);
      const layer = (meta.layers || []).find((l) => l.name === layerName);
      if (layer) return { service: url, layer };
      warn(`TIGERweb layer "${layerName}" not in ${url}. Available: ${(meta.layers || []).map((l) => `${l.id}:${l.name}`).join(' | ')}`);
    } catch (e) {
      warn(`TIGERweb service unavailable: ${url} (${e.message.split('\n')[0]})`);
    }
  }
  throw new Error(`No TIGERweb layer "${layerName}" found. Check tigerweb settings in config/sources.json.`);
}

export async function runTiger() {
  const src = config('sources.json').tigerweb;
  const { state_fips } = config('areas.json');
  const { service, layer } = await findLayer(src, src.tract_layer_name);
  log(`TIGER · using ${service.split('/').slice(-2, -1)[0]}`);

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
      const fc = await fetchJSON(`${service}/${layer.id}/query?${params}`);
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

// Village boundaries for places with their own municipal electric utility
// (config/utilities.json → municipal_electric) → data/raw/muni_places.json
export async function runPlaces() {
  const src = config('sources.json').tigerweb;
  const { state_fips } = config('areas.json');
  const places = config('utilities.json').municipal_electric?.places || [];
  if (!places.length) return 0;
  const { service, layer } = await findLayer(src, src.place_layer_name);
  const names = places.map((p) => `'${p.name.replace(/'/g, "''")}'`).join(',');
  const params = new URLSearchParams({
    where: `STATE='${state_fips}' AND NAME IN (${names})`,
    outFields: 'GEOID,NAME',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    f: 'geojson',
  });
  const fc = await fetchJSON(`${service}/${layer.id}/query?${params}`);
  const found = (fc.features || []).map((f) => f.properties.NAME);
  const missing = places.filter((p) => !found.includes(p.name)).map((p) => p.name);
  if (missing.length) warn(`Municipal electric places not found in TIGERweb: ${missing.join(', ')} — check names in config/utilities.json`);
  log(`Places · ${found.join(', ') || 'none'}`);
  writeJSON(raw('muni_places.json'), { type: 'FeatureCollection', features: fc.features || [] });
  return found.length;
}

if (isMain(import.meta.url)) runTiger().catch((e) => { console.error(e); process.exit(1); });
