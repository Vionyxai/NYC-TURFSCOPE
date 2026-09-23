// m2 / pure scoring functions. No I/O — easy to test and tune.
import { clamp01, round } from '../lib/util.js';
import { B19001_BRACKETS } from '../m1-ingest/acs.js';

export function incomeBand(median, bands) {
  if (median == null) return null;
  for (const b of bands) if (b.max == null || median < b.max) return b.label;
  return null;
}

// B25007 owner-occupied lines: [variable suffix, youngest age in bracket]
export const B25007_OWNER_BRACKETS = [
  ['003', 15], ['004', 25], ['005', 35], ['006', 45], ['007', 55], ['008', 60], ['009', 65], ['010', 75], ['011', 85],
];

// Share of owner households whose householder falls in each configured age band.
export function ownerAgeShares(v, bands) {
  const tot = v.B25007_002E;
  if (!(tot > 0) || !bands) return null;
  const out = {};
  for (const b of bands) {
    let n = 0;
    for (const [c, from] of B25007_OWNER_BRACKETS) if (from >= b.from && from <= b.to) n += v[`B25007_${c}E`] || 0;
    out[b.key] = n / tot;
  }
  return out;
}

// Small / medium / large from building square feet (NYC lots) or median rooms (ACS).
export function sizeBand(value, basis, bands) {
  if (value == null || !(value > 0) || !bands) return null;
  const k = basis === 'sqft' ? 'max_sqft' : 'max_rooms';
  for (const b of bands) if (b[k] == null || value <= b[k]) return b.key;
  return null;
}

// Turn raw ACS variables into readable metrics.
export function tractMetrics(v, pre1980Codes, cfg) {
  const fuelTot = v.B25040_001E;
  const fs = (x) => (fuelTot > 0 && x != null ? x / fuelTot : null);
  const sum = (...xs) => xs.reduce((s, x) => s + (x || 0), 0);
  const fuel = fuelTot > 0 ? {
    gas: fs(v.B25040_002E),
    propane: fs(v.B25040_003E),
    electric: fs(v.B25040_004E), // NOTE: ACS can't split heat pumps from resistance heat
    oil: fs(v.B25040_005E),
    other: fs(sum(v.B25040_006E, v.B25040_007E, v.B25040_008E, v.B25040_009E)),
    none: fs(v.B25040_010E),
  } : null;

  const ageTot = v.B25034_001E;
  const pre = pre1980Codes.reduce((s, c) => s + (v[c] || 0), 0);

  const hh = v.B19001_001E;
  let low = 0;
  for (const [c, upper] of B19001_BRACKETS) if (upper <= cfg.low_income_threshold) low += v[`B19001_${c}E`] || 0;

  // ACS counts housing UNITS, not buildings. Estimate 1–4 unit buildings:
  // 1-unit homes count once, 2-unit buildings hold 2 units, 3–4 unit buildings ~3.5.
  const homesEst = (v.B25024_002E || 0) + (v.B25024_003E || 0) + (v.B25024_004E || 0) / 2 + (v.B25024_005E || 0) / 3.5;

  return {
    median_income: v.B19013_001E,
    median_year_built: v.B25035_001E,
    fuel,
    pre1980_share: ageTot > 0 ? pre / ageTot : null,
    owner_share: v.B25003_001E > 0 ? (v.B25003_002E || 0) / v.B25003_001E : null,
    low_income_share: hh > 0 ? low / hh : null,
    homes_est: Math.round(homesEst),
    owner_households: v.B25007_002E ?? null,
    owner_age: ownerAgeShares(v, cfg.targeting?.owner_age_bands),
    median_rooms: v.B25018_001E ?? null,
  };
}

export function scoreTract(m, utility, cfg) {
  const w = cfg.weights;
  const volume = m.homes > 0 ? clamp01(Math.log10(1 + m.homes) / Math.log10(1 + cfg.volume_cap_homes)) : 0;
  const fuel = m.fuel ? clamp01(Object.entries(cfg.fuel_weights).reduce((s, [k, wt]) => s + (m.fuel[k] || 0) * wt, 0)) : 0;
  const age = clamp01(m.pre1980_share);
  const owner = clamp01(m.owner_share);
  const inc = cfg.incentive[utility] || {};
  const incentive = clamp01((inc.dac || 0) * (m.dac ? 1 : 0) + (inc.low_income_share || 0) * (m.low_income_share || 0));

  const parts = {
    volume: round(volume * w.volume, 1),
    fuel: round(fuel * w.fuel, 1),
    age: round(age * w.age, 1),
    owner: round(owner * w.owner, 1),
    incentive: round(incentive * w.incentive, 1),
  };
  const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
  const gaps = [];
  if (!m.fuel) gaps.push('fuel');
  if (m.pre1980_share == null) gaps.push('age');
  if (m.owner_share == null) gaps.push('owner');
  if (m.dac == null) gaps.push('dac');
  return { score, parts, gaps };
}

// DAC is published on 2010 tracts. A 2020 tract counts as DAC when most of its land
// came from DAC 2010 tracts.
export function dacFor2020(g20, relIndex, dac10) {
  if (!dac10) return { dac: null, dac_share: null };
  const parts = relIndex ? relIndex.get(g20) : null;
  if (parts && parts.length) {
    let tot = 0, d = 0;
    for (const p of parts) { tot += p.land; if (dac10[p.g10]) d += p.land; }
    if (tot > 0) { const s = d / tot; return { dac: s >= 0.5, dac_share: round(s) }; }
  }
  if (g20 in dac10) return { dac: dac10[g20], dac_share: dac10[g20] ? 1 : 0 };
  return { dac: null, dac_share: null };
}

export function lotUtility(zip, countyFips, util) {
  for (const [u, zips] of Object.entries(util.nyc_zip_overrides)) if (zips.includes(zip)) return u;
  return util.county_default[countyFips] || null;
}

export function lotScore(lot, tractScore, lotCfg) {
  let s = tractScore;
  if (lot.units <= 2) s += lotCfg.small_bonus;
  else s -= lotCfg.three_four_penalty;
  if (lot.year && lot.year > 1800 && lot.year < 1980) s += lotCfg.pre1980_bonus;
  return Math.max(0, Math.min(100, Math.round(s)));
}
