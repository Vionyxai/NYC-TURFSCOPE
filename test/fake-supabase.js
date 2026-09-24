// A tiny in-memory stand-in for the Supabase endpoints m3-map/team.js uses.
// It mirrors the rules in supabase/001_team_tracking.sql closely enough to test the app logic offline.
// (The real rules are tested against Postgres by supabase/tests/rls_test.sql.)
export function fakeSupabase({ users, reps, statuses, turfStatuses = ['claimed', 'finished', 'avoid', 'open'] }) {
  const tables = { knocks: [], turf_log: [], notes: [] };
  const tokens = new Map();          // access token -> email
  const refreshTokens = new Map();   // refresh token -> email
  let n = 0, ids = 0;
  const state = { offline: false, loseResponses: 0, expire: new Set(), calls: [] };

  const json = (status, body) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status });
  const issue = (email) => {
    n++;
    const access_token = `at-${n}`, refresh_token = `rt-${n}`;
    tokens.set(access_token, email); refreshTokens.set(refresh_token, email);
    return { access_token, refresh_token, expires_in: 3600, user: { email } };
  };
  const repFor = (email) => reps.find((r) => r.active !== false && r.email && r.email.toLowerCase() === String(email).toLowerCase());
  const repName = (id) => reps.find((r) => r.id === id).name;
  const newest = (rows, key, time) => {
    const by = new Map();
    for (const k of rows) { const cur = by.get(k[key]); if (!cur || k[time] > cur[time] || (k[time] === cur[time] && k.id > cur.id)) by.set(k[key], k); }
    return [...by.values()].map((k) => ({ ...k, rep: repName(k.rep_id) }));
  };
  const views = {
    latest_knocks: () => newest(tables.knocks, 'bbl', 'knocked_at'),
    turf_status: () => newest(tables.turf_log, 'tract', 'set_at'),
    team_notes: () => tables.notes.map((x) => ({ ...x, rep: repName(x.rep_id) })),
  };
  // PostgREST-style filters the app uses: eq, in, is.null, not.is.null
  const filter = (rows, params) => rows.filter((r) => [...params].every(([k, v]) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
    if (v === 'is.null') return r[k] == null;
    if (v === 'not.is.null') return r[k] != null;
    if (v === 'is.true') return r[k] !== false;
    if (v.startsWith('eq.')) return String(r[k]) === v.slice(3);
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(r[k]));
    return true;
  }));
  const phone = /[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{4}/, email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const check = {
    knocks: (k) => statuses.includes(k.status),
    turf_log: (t) => turfStatuses.includes(t.status),
    notes: (x) => x.body && x.body.trim() && x.body.length <= 280 && !phone.test(x.body) && !email.test(x.body),
  };

  async function fetch(url, { method = 'GET', headers = {}, body } = {}) {
    state.calls.push(`${method} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    if (state.offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const p = u.pathname;
    const data = body ? JSON.parse(body) : undefined;
    if (p === '/auth/v1/token') {
      if (u.searchParams.get('grant_type') === 'password') {
        return users[data.email] === data.password ? json(200, issue(data.email)) : json(400, { error_description: 'Invalid login credentials' });
      }
      const who = refreshTokens.get(data.refresh_token);
      if (!who) return json(400, { error_description: 'Invalid Refresh Token' });
      refreshTokens.delete(data.refresh_token);
      return json(200, issue(who));
    }
    const tok = (headers.Authorization || '').replace('Bearer ', '');
    if (state.expire.has(tok)) { state.expire.delete(tok); tokens.delete(tok); }
    const who = tokens.get(tok);
    if (!who) return json(401, { message: 'JWT expired' });
    if (p === '/auth/v1/logout') return json(204);
    const rep = repFor(who);
    const name = p.replace('/rest/v1/', '');
    if (name === 'reps') return json(200, rep ? reps.filter((r) => r.active !== false).map(({ name: nm, email: em, is_admin }) => ({ name: nm, email: em, is_admin: !!is_admin })) : []);
    if (tables[name] && method === 'POST') {
      if (!rep) return json(403, { message: `new row violates row-level security policy for table "${name}"` });
      for (const row of data) if (!check[name](row)) return json(400, { message: `violates check constraint on ${name}` });
      for (const row of data) if (!tables[name].some((x) => x.client_id === row.client_id)) tables[name].push({ ...row, id: ++ids, rep_id: rep.id });
      if (state.loseResponses > 0) { state.loseResponses--; throw new TypeError('Network connection was lost'); } // saved, but the phone never hears back
      return json(201);
    }
    if (tables[name] && method === 'DELETE') {
      const id = u.searchParams.get('client_id').replace('eq.', '');
      const i = tables[name].findIndex((x) => x.client_id === id && (x.rep_id === rep?.id || rep?.is_admin));
      if (i >= 0) tables[name].splice(i, 1);
      return json(204);
    }
    if (!rep) return json(200, []);
    if (views[name]) return json(200, filter(views[name](), u.searchParams));
    if (name === 'tract_progress') {
      const tract = u.searchParams.get('tract').replace('eq.', '');
      const ks = views.latest_knocks().filter((k) => k.tract === tract);
      const c = (st) => ks.filter((k) => k.status === st).length;
      return json(200, ks.length ? [{ tract, knocked: ks.length, booked: c('booked'), interested: c('interested'), come_back: c('come_back'), not_interested: c('not_interested'), no_answer: c('no_answer') }] : []);
    }
    if (name === 'rep_stats') {
      const today = new Date().toDateString();
      const turf = views.turf_status();
      return json(200, reps.filter((r) => r.active !== false).map((r) => {
        const mine = tables.knocks.filter((k) => k.rep_id === r.id);
        const t = mine.filter((k) => new Date(k.knocked_at).toDateString() === today);
        return { rep: r.name, knocks: mine.length, booked: mine.filter((k) => k.status === 'booked').length, knocks_today: t.length,
          booked_today: t.filter((k) => k.status === 'booked').length, turf_claimed: turf.filter((x) => x.rep === r.name && x.status === 'claimed').length };
      }));
    }
    return json(404, { message: `no route ${p}` });
  }
  return { fetch, tables, knocks: tables.knocks, state };
}

export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
