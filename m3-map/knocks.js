// TurfScope knock tracking: login, recording knocks, offline queue, undo.
// Talks to Supabase with plain fetch (no library). Plain script: defines window.TurfKnocks.
// Everything the outside world touches (fetch, storage, clock) is passed in, so npm test
// can run this file against a fake Supabase without a browser.
(function (root) {
  'use strict';

  function createKnocks(opts) {
    const sb = opts.supabase;                 // { url, key } or null when not set up
    const store = opts.storage;               // localStorage-like: getItem / setItem / removeItem
    const http = opts.fetch;
    const now = opts.now || (() => Date.now());
    const uuid = opts.uuid;
    const K = { session: 'ts.session', queue: 'ts.queue', me: 'ts.me' };
    const listeners = new Set();
    const byBbl = new Map();                  // bbl -> latest knock we know of (server or pending)
    let flushing = null;

    const read = (k, d) => { try { const v = store.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const write = (k, v) => { try { v == null ? store.removeItem(k) : store.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode / full */ } };
    const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });

    let session = read(K.session, null);      // { access_token, refresh_token, expires_at (s), email }
    let me = read(K.me, null);                 // { name, is_admin } once confirmed on the team
    let queue = read(K.queue, []);             // knocks not yet saved to the database

    for (const q of queue) byBbl.set(q.bbl, { ...q, rep: me && me.name, pending: true });

    // ---------- HTTP ----------
    async function call(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
      const h = { apikey: sb.key, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (auth) {
        await ensureFresh();
        if (!session) throw Object.assign(new Error('Signed out'), { status: 401 });
        h.Authorization = `Bearer ${session.access_token}`;
      }
      let res = await http(sb.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 401 && auth && session) {           // token expired early: refresh once and retry
        await refresh();
        h.Authorization = `Bearer ${session.access_token}`;
        res = await http(sb.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.msg || j.message || j.error_description || j.error || msg; } catch (e) { /* not json */ }
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    function saveSession(j) {
      session = {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: j.expires_at || Math.floor(now() / 1000) + (j.expires_in || 3600),
        email: (j.user && j.user.email) || (session && session.email) || '',
      };
      write(K.session, session);
    }

    async function refresh() {
      if (!session) return;
      try {
        const j = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token }, auth: false });
        saveSession(j);
      } catch (e) {
        if (e.status >= 400 && e.status < 500) { session = null; me = null; write(K.session, null); write(K.me, null); emit(); }
        throw e;
      }
    }

    async function ensureFresh() {
      if (session && session.expires_at - 60 < now() / 1000) await refresh();
    }

    // ---------- Account ----------
    async function signIn(email, password) {
      const j = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: String(email).trim(), password }, auth: false });
      saveSession(j);
      await loadMe();
      flush();
      return me;
    }

    // Confirms this login is one of the reps. RLS only shows the reps list to team members.
    async function loadMe() {
      const reps = await call('/rest/v1/reps?select=name,email,is_admin&active=is.true');
      const mine = (reps || []).find((r) => r.email && r.email.toLowerCase() === (session.email || '').toLowerCase());
      me = mine ? { name: mine.name, is_admin: !!mine.is_admin } : null;
      write(K.me, me);
      emit();
      return me;
    }

    async function signOut() {
      if (queue.length) throw new Error(`${queue.length} knock(s) haven't synced yet. Get signal, tap Sync now, then sign out.`);
      try { if (session) await call('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* offline is fine */ }
      session = null; me = null; byBbl.clear();
      write(K.session, null); write(K.me, null);
      emit();
    }

    // ---------- Knocks ----------
    // Save on the phone first, then send. A retry never double-saves: the database ignores a repeated client_id.
    function record(bbl, tract, status, followup) {
      if (!session || !me) throw new Error('Sign in to record knocks');
      const k = { client_id: uuid(), bbl: String(bbl), tract: String(tract), status, followup: followup || null, knocked_at: new Date(now()).toISOString() };
      queue.push(k);
      write(K.queue, queue);
      byBbl.set(k.bbl, { ...k, rep: me.name, pending: true, mine: true });
      emit();
      flush();
      return k;
    }

    async function flush() {
      if (!sb || !session) return;
      while (flushing) await flushing;          // let an attempt already under way finish, then try again ourselves
      if (!queue.length) return;
      flushing = (async () => {
        while (queue.length) {
          const batch = queue.slice(0, 50);
          try {
            await call('/rest/v1/knocks?on_conflict=client_id', {
              method: 'POST', body: batch, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
            });
          } catch (e) {
            if (e.status === 401 || !e.status || e.status >= 500 || e.status === 429) break; // offline / signed out: try later
            // The database refused these knocks (e.g. a check failed). Keep them visible but stop retrying.
            batch.forEach((k) => { const cur = byBbl.get(k.bbl); if (cur && cur.client_id === k.client_id) byBbl.set(k.bbl, { ...cur, pending: false, failed: e.message }); });
          }
          const sent = new Set(batch.map((k) => k.client_id));
          queue = queue.filter((k) => !sent.has(k.client_id));
          write(K.queue, queue);
          batch.forEach((k) => { const cur = byBbl.get(k.bbl); if (cur && cur.client_id === k.client_id && !cur.failed) byBbl.set(k.bbl, { ...cur, pending: false }); });
          emit();
        }
      })();
      try { await flushing; } finally { flushing = null; }
    }

    // Undo the latest knock on a house, if this rep made it (or they're the admin).
    async function undo(bbl) {
      const cur = byBbl.get(String(bbl));
      if (!cur) return false;
      const q = queue.findIndex((k) => k.client_id === cur.client_id);
      if (q >= 0) { queue.splice(q, 1); write(K.queue, queue); }
      else await call(`/rest/v1/knocks?client_id=eq.${encodeURIComponent(cur.client_id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      byBbl.delete(String(bbl));
      emit();
      return true;
    }

    // Pull the team's latest status for every house in a tract.
    async function loadTract(tract) {
      const rows = await call(`/rest/v1/latest_knocks?tract=eq.${encodeURIComponent(tract)}&select=bbl,tract,status,followup,knocked_at,client_id,rep`);
      const pending = new Set(queue.map((k) => k.bbl));
      for (const [bbl, k] of byBbl) if (k.tract === tract && !pending.has(bbl)) byBbl.delete(bbl);
      for (const r of rows || []) {
        if (pending.has(r.bbl)) continue;       // our unsent tap is newer than anything on the server
        byBbl.set(r.bbl, { ...r, mine: me && r.rep === me.name });
      }
      emit();
      return rows ? rows.length : 0;
    }

    async function tractProgress(tract) {
      const rows = await call(`/rest/v1/tract_progress?tract=eq.${encodeURIComponent(tract)}`);
      return (rows && rows[0]) || { tract, knocked: 0, booked: 0, interested: 0, come_back: 0, not_interested: 0, no_answer: 0 };
    }

    async function repStats() {
      return (await call('/rest/v1/rep_stats?select=rep,knocks,booked,knocks_today,booked_today')) || [];
    }

    return {
      enabled: !!sb,
      signIn, signOut, loadMe, record, flush, undo, loadTract, tractProgress, repStats,
      latest: (bbl) => byBbl.get(String(bbl)) || null,
      pendingCount: () => queue.length,
      signedIn: () => !!session,
      me: () => me,
      email: () => (session && session.email) || '',
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  root.TurfKnocks = { createKnocks };
})(typeof window !== 'undefined' ? window : globalThis);
