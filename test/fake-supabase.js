// A tiny in-memory stand-in for the Supabase endpoints m3-map/knocks.js uses.
// It mirrors the rules in supabase/001_knock_tracking.sql closely enough to test the app logic offline.
export function fakeSupabase({ users, reps, statuses }) {
  const knocks = [];
  const tokens = new Map();          // access token -> email
  const refreshTokens = new Map();   // refresh token -> email
  let n = 0;
  const state = { offline: false, loseResponses: 0, expire: new Set(), calls: [] };

  const json = (status, body) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status });
  const issue = (email) => {
    n++;
    const access_token = `at-${n}`, refresh_token = `rt-${n}`;
    tokens.set(access_token, email); refreshTokens.set(refresh_token, email);
    return { access_token, refresh_token, expires_in: 3600, user: { email } };
  };
  const repFor = (email) => reps.find((r) => r.active !== false && r.email && r.email.toLowerCase() === String(email).toLowerCase());
  const latest = () => {
    const by = new Map();
    for (const k of knocks) { const cur = by.get(k.bbl); if (!cur || k.knocked_at > cur.knocked_at || (k.knocked_at === cur.knocked_at && k.id > cur.id)) by.set(k.bbl, k); }
    return [...by.values()].map((k) => ({ bbl: k.bbl, tract: k.tract, status: k.status, followup: k.followup, knocked_at: k.knocked_at, client_id: k.client_id, rep: reps.find((r) => r.id === k.rep_id).name }));
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
      const email = refreshTokens.get(data.refresh_token);
      if (!email) return json(400, { error_description: 'Invalid Refresh Token' });
      refreshTokens.delete(data.refresh_token);
      return json(200, issue(email));
    }
    const tok = (headers.Authorization || '').replace('Bearer ', '');
    if (state.expire.has(tok)) { state.expire.delete(tok); tokens.delete(tok); }
    const email = tokens.get(tok);
    if (!email) return json(401, { message: 'JWT expired' });
    if (p === '/auth/v1/logout') return json(204);
    const rep = repFor(email);
    if (p === '/rest/v1/reps') return json(200, rep ? reps.filter((r) => r.active !== false).map(({ name, email, is_admin }) => ({ name, email, is_admin })) : []);
    if (p === '/rest/v1/knocks' && method === 'POST') {
      if (!rep) return json(403, { message: 'new row violates row-level security policy for table "knocks"' });
      for (const k of data) {
        if (!statuses.includes(k.status)) return json(400, { message: 'violates check constraint "knocks_status_check"' });
      }
      for (const k of data) if (!knocks.some((x) => x.client_id === k.client_id)) knocks.push({ ...k, id: knocks.length + 1, rep_id: rep.id });
      if (state.loseResponses > 0) { state.loseResponses--; throw new TypeError('Network connection was lost'); } // saved, but the phone never hears back
      return json(201);
    }
    if (p === '/rest/v1/knocks' && method === 'DELETE') {
      const id = u.searchParams.get('client_id').replace('eq.', '');
      const i = knocks.findIndex((k) => k.client_id === id && (k.rep_id === rep?.id || rep?.is_admin));
      if (i >= 0) knocks.splice(i, 1);
      return json(204);
    }
    if (!rep) return json(200, []);
    const tract = (u.searchParams.get('tract') || '').replace('eq.', '');
    if (p === '/rest/v1/latest_knocks') return json(200, latest().filter((k) => k.tract === tract));
    if (p === '/rest/v1/tract_progress') {
      const ks = latest().filter((k) => k.tract === tract);
      const c = (st) => ks.filter((k) => k.status === st).length;
      return json(200, ks.length ? [{ tract, knocked: ks.length, booked: c('booked'), interested: c('interested'), come_back: c('come_back'), not_interested: c('not_interested'), no_answer: c('no_answer') }] : []);
    }
    if (p === '/rest/v1/rep_stats') {
      const today = new Date().toDateString();
      return json(200, reps.filter((r) => r.active !== false).map((r) => {
        const mine = knocks.filter((k) => k.rep_id === r.id);
        const t = mine.filter((k) => new Date(k.knocked_at).toDateString() === today);
        return { rep: r.name, knocks: mine.length, booked: mine.filter((k) => k.status === 'booked').length, knocks_today: t.length, booked_today: t.filter((k) => k.status === 'booked').length };
      }));
    }
    return json(404, { message: `no route ${p}` });
  }
  return { fetch, knocks, state };
}

export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
