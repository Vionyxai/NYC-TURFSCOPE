// TurfScope "My fit": each rep's personal turf map, learned from their own knocks and appointments.
// Plain script: defines window.TurfFit (npm test loads it too). Pure: no network, no storage.
//
// How it works (settings in config/scoring.json → personal):
//   1. Every tract gets traits: home age, income, size, oil level, main language, homeowner age,
//      retired share, voting lean, utility, county, DAC, renter-heavy.
//   2. For each rep and each trait value, compare their appointments per door and closes per
//      appointment with their own overall rates → a "lift" (1.0 = same as usual, 2.0 = twice as good).
//   3. Small samples are pulled toward the team's pattern (and the team's toward neutral), so a
//      handful of doors can't swing the map.
//   4. My fit for a tract = TurfScore × the rep's average lift over that tract's traits.
(function (root) {
  'use strict';

  const band = (x, edges, names) => (x == null ? null : names[edges.filter((e) => x >= e).length]);

  // The traits of one tract, as "group:value" ids. Missing data → trait left out.
  function traitsOf(p, cfg) {
    const b = cfg.bins || {};
    const out = [];
    const add = (group, value) => { if (value != null && value !== '') out.push({ group, value: String(value), id: `${group}:${value}` }); };
    const want = new Set(cfg.traits || []);
    if (want.has('home_age_band')) add('home_age_band', p.home_age_band);
    if (want.has('income_band')) add('income_band', p.income_band);
    if (want.has('size_band')) add('size_band', p.size_band);
    if (want.has('oil')) add('oil', band(p.fuel && p.fuel.oil, b.oil || [0.15, 0.4], ['low', 'some', 'high']));
    if (want.has('language') && (p.languages || p.english_only != null)) {
      const top = (p.languages || []).filter(([n]) => !/^Other/i.test(n)).sort((x, y) => y[1] - x[1])[0];
      add('language', top && top[1] >= (b.language_min ?? 0.15) ? top[0] : 'English');
    }
    if (want.has('owner_age') && p.owner_age) add('owner_age', Object.entries(p.owner_age).sort((x, y) => y[1] - x[1])[0][0]);
    if (want.has('retired')) add('retired', band(p.retired && p.retired.retirement_income, b.retired || [0.25, 0.35], ['low', 'mid', 'high']));
    if (want.has('vote')) add('vote', band(p.vote && p.vote.dem, b.vote || [0.4, 0.6], ['R', 'mixed', 'D']));
    if (want.has('utility')) add('utility', p.utility);
    if (want.has('county')) add('county', p.county_name);
    if (want.has('dac') && p.dac != null) add('dac', p.dac ? 'yes' : 'no');
    if (want.has('renter_heavy') && p.renter_heavy != null) add('renter_heavy', p.renter_heavy ? 'yes' : 'no');
    return out;
  }

  // Add up doors / appointments / closes overall and per trait value.
  function tally(rows, traitsByTract) {
    const t = { D: 0, A: 0, C: 0, groups: new Map() };
    for (const r of rows) {
      const D = Number(r.doors) || 0, A = Number(r.appts) || 0, C = Number(r.closed) || 0;
      t.D += D; t.A += A; t.C += C;
      for (const tr of traitsByTract(r.tract)) {
        const g = t.groups.get(tr.id) || { D: 0, A: 0, C: 0 };
        g.D += D; g.A += A; g.C += C;
        t.groups.set(tr.id, g);
      }
    }
    return t;
  }

  // One profile (a rep's, or the team's when prior is null).
  function makeProfile(name, t, cfg, prior) {
    const sd = cfg.smooth_doors ?? 150, sa = cfg.smooth_appts ?? 6;
    // Overall rates, pulled toward the team's when the rep has little data.
    const rA = prior ? (t.A + sd * prior.rA) / (t.D + sd) : (t.D ? t.A / t.D : 0);
    const rC = prior ? (t.C + sa * prior.rC) / (t.A + sa) : (t.A ? t.C / t.A : 0);
    const wa = cfg.appt_weight ?? 0.6;
    const wc = (cfg.close_weight ?? 0.4) * Math.min(1, t.A / (cfg.close_full_at || 20));
    const lift = {};
    const ids = new Set([...t.groups.keys(), ...(prior ? Object.keys(prior.lift) : [])]);
    for (const id of ids) {
      const g = t.groups.get(id) || { D: 0, A: 0, C: 0 };
      const pl = prior && prior.lift[id] ? prior.lift[id] : { liftA: 1, liftC: 1 };
      const aRate = rA > 0 ? (g.A + sd * rA * pl.liftA) / (g.D + sd) : 0;
      const cRate = rC > 0 ? (g.C + sa * rC * pl.liftC) / (g.A + sa) : 0;
      const liftA = rA > 0 ? aRate / rA : 1, liftC = rC > 0 ? cRate / rC : 1;
      const l = Math.exp((wa * Math.log(liftA) + wc * Math.log(liftC)) / (wa + wc));
      lift[id] = { lift: l, liftA, liftC, doors: g.D, appts: g.A, closed: g.C, per100: g.D ? (100 * g.A) / g.D : null };
    }
    const minD = cfg.min_doors ?? 200;
    return {
      rep: name, doors: t.D, appts: t.A, closed: t.C, rA, rC,
      per100: t.D ? (100 * t.A) / t.D : null, closeRate: t.A ? t.C / t.A : null,
      learning: !!prior && t.D < minD, remaining: Math.max(0, minD - t.D), lift,
    };
  }

  // rows: rep_tract_results; tractProps(geoid) → tract properties. Returns { team, reps: { name: profile } }.
  function buildProfiles(rows, tractProps, cfg) {
    const cache = new Map();
    const traitsByTract = (g) => { if (!cache.has(g)) { const p = tractProps(g); cache.set(g, p ? traitsOf(p, cfg) : []); } return cache.get(g); };
    const team = makeProfile('team', tally(rows, traitsByTract), cfg, null);
    const reps = {};
    for (const name of new Set(rows.map((r) => r.rep))) reps[name] = makeProfile(name, tally(rows.filter((r) => r.rep === name), traitsByTract), cfg, team);
    return { team, reps };
  }

  // Keep My fit on the 0–100 scale without piling good tracts up at 100: above 80 it bends toward 100.
  const soften = (x) => Math.round(x <= 80 ? Math.max(0, x) : 80 + 20 * (1 - Math.exp(-(x - 80) / 20)));

  // My fit for one tract. A rep still learning gets the team's pattern.
  function fit(p, profile, team, cfg) {
    const use = !profile || profile.learning ? team : profile;
    const tr = traitsOf(p, cfg);
    if (!use || !tr.length) return { score: p.score, raw: p.score, mult: 1, reasons: [], learning: !profile || profile.learning };
    let sum = 0, n = 0;
    const reasons = [];
    for (const t of tr) {
      const L = use.lift[t.id];
      if (!L) continue;
      sum += Math.log(L.lift); n++;
      if (L.doors >= (cfg.reason_min_doors ?? 40) && (L.lift >= (cfg.reason_lift ?? 1.15) || L.lift <= 1 / (cfg.reason_lift ?? 1.15))) reasons.push({ ...t, ...L });
    }
    const mult = n ? Math.min(cfg.multiplier_max ?? 1.6, Math.max(cfg.multiplier_min ?? 0.5, Math.exp(sum / n))) : 1;   // average: related traits (old homes, Queens, Con Ed) describe the same blocks, so they don't stack
    reasons.sort((a, b) => Math.abs(Math.log(b.lift)) - Math.abs(Math.log(a.lift)));
    return { score: soften(p.score * mult), raw: p.score * mult, mult, reasons: reasons.slice(0, 3), learning: !profile || profile.learning };
  }

  // What works / doesn't for a rep: trait values with enough doors, best and worst.
  function strengths(profile, cfg) {
    if (!profile) return { good: [], bad: [] };
    const minD = cfg.reason_min_doors ?? 40, cut = cfg.reason_lift ?? 1.15;
    const all = Object.entries(profile.lift).filter(([, L]) => L.doors >= minD).map(([id, L]) => ({ id, group: id.split(':')[0], value: id.slice(id.indexOf(':') + 1), ...L }));
    return {
      good: all.filter((x) => x.lift >= cut).sort((a, b) => b.lift - a.lift).slice(0, 3),
      bad: all.filter((x) => x.lift <= 1 / cut).sort((a, b) => a.lift - b.lift).slice(0, 3),
    };
  }

  // Teammates who worked this tract recently (knocked within days), newest first.
  function recentOthers(rows, tract, me, nowMs, days) {
    const since = nowMs - days * 86400000;
    return rows.filter((r) => r.tract === tract && r.rep !== me && r.last_knock_at && Date.parse(r.last_knock_at) >= since)
      .sort((a, b) => (a.last_knock_at < b.last_knock_at ? 1 : -1))
      .map((r) => ({ rep: r.rep, last_knock_at: r.last_knock_at, doors: Number(r.doors) || 0 }));
  }

  root.TurfFit = { traitsOf, buildProfiles, fit, strengths, recentOthers };
})(typeof window !== 'undefined' ? window : globalThis);
