// TurfScope team sync: login, house knocks, turf claims, notes and pins, all offline-first.
// Talks to Supabase with plain fetch (no library). Plain script: defines window.TurfTeam.
// Everything the outside world touches (fetch, storage, clock) is passed in, so npm test
// can run this file against a fake Supabase without a browser.
(function (root) {
  'use strict';

  // Same rule the database enforces on notes (supabase/001_team_tracking.sql → clean_note).
  const PHONE = /[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{3}[^0-9A-Za-z]{0,3}[0-9]{4}/;
  const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  function noteProblem(body, max = 280) {
    const t = String(body || '').trim();
    if (!t) return 'Write something first.';
    if (t.length > max) return `Keep it under ${max} characters.`;
    if (PHONE.test(t)) return 'No phone numbers in notes. They stay private to the homeowner.';
    if (EMAIL.test(t)) return 'No email addresses in notes.';
    return null;
  }

  // Where each kind of entry is stored in the database.
  const TABLE = { knock: 'knocks', turf: 'turf_log', note: 'notes', saved: 'saved_turfs' };

  function createTeam(opts) {
    const sb = opts.supabase;                 // { url, key } or null when not set up
    const store = opts.storage;               // localStorage-like: getItem / setItem / removeItem
    const http = opts.fetch;
    const now = opts.now || (() => Date.now());
    const uuid = opts.uuid;
    const noteMax = opts.noteMax || 280;
    const K = { session: 'ts.session', queue: 'ts.queue', me: 'ts.me' };
    const listeners = new Set();
    const byBbl = new Map();                  // bbl -> latest knock (anyone's, or our pending one)
    const turfBy = new Map();                 // tract -> latest area status
    const notes = new Map();                  // client_id -> note / pin
    const K2 = { saved: 'ts.saved', activity: 'ts.activity' };
    let teamSaved = [];                       // everyone's saved turfs: { tract, plan_date, saved_at, rep, client_id }
    let activity = {};                        // tract -> { knocked, notes, pins, turf_status, turf_rep, last_at, last_rep }
    let flushing = null;

    const read = (k, d) => { try { const v = store.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const write = (k, v) => { try { v == null ? store.removeItem(k) : store.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode / full */ } };
    const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    const iso = () => new Date(now()).toISOString();

    let session = read(K.session, null);      // { access_token, refresh_token, expires_at (s), email }
    let me = read(K.me, null);                 // { name, is_admin } once confirmed on the team
    let queue = read(K.queue, []).map((q) => (q.kind ? q : { kind: 'knock', row: q }));  // entries not yet in the database
    teamSaved = read(K2.saved, []);           // last copy we saw, so the list shows with no signal
    activity = read(K2.activity, {});

    // Show our own unsent entries straight away.
    function applyLocal(q) {
      const mine = { rep: me && me.name, pending: true, mine: true };
      if (q.kind === 'knock') byBbl.set(q.row.bbl, { ...q.row, ...mine });
      if (q.kind === 'turf') turfBy.set(q.row.tract, { ...q.row, ...mine });
      if (q.kind === 'note') notes.set(q.row.client_id, { ...q.row, ...mine });
      if (q.kind === 'saved') {
        teamSaved = teamSaved.filter((x) => !(x.tract === q.row.tract && me && x.rep === me.name));
        teamSaved.push({ ...q.row, ...mine });
      }
    }
    queue.forEach(applyLocal);

    // ---------- HTTP ----------
    async function call(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
      const h = { apikey: sb.key, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (auth) {
        await ensureFresh();
        if (!session) throw Object.assign(new Error('Signed out'), { status: 401 });
        h.Authorization = `Bearer ${session.access_token}`;
      }
      const send = () => http(sb.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      let res = await send();
      if (res.status === 401 && auth && session) {           // token expired early: refresh once and retry
        await refresh();
        if (!session) throw Object.assign(new Error('Signed out'), { status: 401 });
        h.Authorization = `Bearer ${session.access_token}`;
        res = await send();
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

    // One refresh at a time: Supabase refresh tokens work once, so two parallel requests that
    // both hit an expired token must share the same refresh instead of racing (and signing out).
    let refreshing = null;
    async function refresh() {
      if (refreshing) return refreshing;
      if (!session) return;
      const used = session.refresh_token;
      refreshing = (async () => {
        try {
          const j = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: used }, auth: false });
          saveSession(j);
        } catch (e) {
          if (e.status >= 400 && e.status < 500 && session && session.refresh_token === used) {
            session = null; me = null; write(K.session, null); write(K.me, null); emit();
          }
          throw e;
        }
      })();
      try { await refreshing; } finally { refreshing = null; }
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
      if (queue.length) throw new Error(`${queue.length} change(s) haven't synced yet. Get signal, tap Sync now, then sign out.`);
      try { if (session) await call('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* offline is fine */ }
      session = null; me = null; byBbl.clear(); turfBy.clear(); notes.clear(); teamSaved = []; activity = {};
      write(K.session, null); write(K.me, null); write(K2.saved, null); write(K2.activity, null);
      emit();
    }

    // ---------- Queue: save on the phone first, then send ----------
    // A retry never double-saves: the database ignores a repeated client_id.
    function enqueue(kind, row) {
      if (!session || !me) throw new Error('Sign in first');
      const q = { kind, row: { client_id: uuid(), ...row } };
      queue.push(q);
      write(K.queue, queue);
      applyLocal(q);
      emit();
      flush();
      return q.row;
    }

    function markSent(q, failed) {
      const upd = (map, key) => { const cur = map.get(key); if (cur && cur.client_id === q.row.client_id) map.set(key, { ...cur, pending: false, failed: failed || undefined }); };
      if (q.kind === 'knock') upd(byBbl, q.row.bbl);
      if (q.kind === 'turf') upd(turfBy, q.row.tract);
      if (q.kind === 'note') upd(notes, q.row.client_id);
      if (q.kind === 'saved') teamSaved = teamSaved.map((x) => (x.client_id === q.row.client_id ? { ...x, pending: false, failed: failed || undefined } : x));
    }

    async function flush() {
      if (!sb || !session) return;
      while (flushing) await flushing;          // let an attempt already under way finish, then try again ourselves
      if (!queue.length) return;
      flushing = (async () => {
        while (queue.length) {
          const kind = queue[0].kind;
          let n = 0;
          while (n < queue.length && n < 50 && queue[n].kind === kind) n++;
          const batch = queue.slice(0, n);
          let failed = null;
          try {
            // Saved turfs: one row per rep per tract, so saving again updates the date. Everything else: a retry never double-saves.
            const conflict = kind === 'saved' ? 'rep_id,tract' : 'client_id';
            const resolution = kind === 'saved' ? 'merge-duplicates' : 'ignore-duplicates';
            await call(`/rest/v1/${TABLE[kind]}?on_conflict=${conflict}`, {
              method: 'POST', body: batch.map((q) => q.row), headers: { Prefer: `resolution=${resolution},return=minimal` },
            });
          } catch (e) {
            if (e.status === 401 || !e.status || e.status >= 500 || e.status === 429) break; // offline / signed out: try later
            failed = e.message;                   // the database refused it (a rule failed): keep it visible, stop retrying
          }
          const sent = new Set(batch.map((q) => q.row.client_id));
          queue = queue.filter((q) => !sent.has(q.row.client_id));
          write(K.queue, queue);
          batch.forEach((q) => markSent(q, failed));
          emit();
        }
      })();
      try { await flushing; } finally { flushing = null; }
    }

    // Remove one of our entries: from the queue if it never left the phone, else from the database.
    async function remove(kind, clientId) {
      const i = queue.findIndex((q) => q.row.client_id === clientId);
      if (i >= 0) { queue.splice(i, 1); write(K.queue, queue); return; }
      await call(`/rest/v1/${TABLE[kind]}?client_id=eq.${encodeURIComponent(clientId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }

    // ---------- House knocks ----------
    function record(bbl, tract, status, followup, address) {
      return enqueue('knock', {
        bbl: String(bbl), tract: String(tract), address: address ? String(address).slice(0, 100) : null,
        status, followup: followup || null, knocked_at: iso(),
      });
    }

    // Undo the latest knock on a house, if this rep made it (or they're the admin).
    async function undo(bbl) {
      const cur = byBbl.get(String(bbl));
      if (!cur) return false;
      await remove('knock', cur.client_id);
      byBbl.delete(String(bbl));
      emit();
      return true;
    }

    // ---------- Turf (area status) ----------
    function setTurf(tract, status) {
      return enqueue('turf', { tract: String(tract), status, set_at: iso() });
    }
    async function undoTurf(tract) {
      const cur = turfBy.get(String(tract));
      if (!cur) return false;
      await remove('turf', cur.client_id);
      turfBy.delete(String(tract));
      emit();
      loadTeam().catch(() => {});             // show what the area was before
      return true;
    }

    // ---------- Notes and pins ----------
    function addNote({ tract, bbl, address, lat, lon, body }) {
      const problem = noteProblem(body, noteMax);
      if (problem) throw new Error(problem);
      return enqueue('note', {
        tract: tract ? String(tract) : null, bbl: bbl ? String(bbl) : null,
        address: address ? String(address).slice(0, 100) : null,
        lat: lat == null ? null : Math.round(lat * 1e6) / 1e6, lon: lon == null ? null : Math.round(lon * 1e6) / 1e6,
        body: String(body).trim(), noted_at: iso(),
      });
    }
    async function deleteNote(clientId) {
      await remove('note', clientId);
      notes.delete(clientId);
      emit();
    }
    const byTime = (a, b) => (a.noted_at < b.noted_at ? 1 : -1);
    const notesFor = ({ bbl, tract }) => [...notes.values()]
      .filter((n) => (bbl ? n.bbl === String(bbl) : n.tract === String(tract) && !n.bbl && n.lat == null))
      .sort(byTime);
    const houseNotesInTract = (tract) => [...notes.values()].filter((n) => n.tract === String(tract) && n.bbl).sort(byTime);
    const pins = () => [...notes.values()].filter((n) => n.lat != null).sort(byTime);

    // ---------- Loading the team's data ----------
    const pendingKeys = (kind, key) => new Set(queue.filter((q) => q.kind === kind).map((q) => q.row[key]));

    // Everything for one tract: house statuses and notes.
    async function loadTract(tract) {
      const [rows, ns] = await Promise.all([
        call(`/rest/v1/latest_knocks?tract=eq.${encodeURIComponent(tract)}&select=bbl,tract,address,status,followup,knocked_at,client_id,rep`),
        call(`/rest/v1/team_notes?tract=eq.${encodeURIComponent(tract)}&lat=is.null&select=client_id,tract,bbl,address,lat,lon,body,noted_at,rep`),
      ]);
      const pend = pendingKeys('knock', 'bbl');
      for (const [bbl, k] of byBbl) if (k.tract === tract && !pend.has(bbl)) byBbl.delete(bbl);
      for (const r of rows || []) if (!pend.has(r.bbl)) byBbl.set(r.bbl, { ...r, mine: !!me && r.rep === me.name });
      const pendNotes = pendingKeys('note', 'client_id');
      for (const [id, n] of notes) if (n.tract === tract && n.lat == null && !pendNotes.has(id)) notes.delete(id);
      for (const n of ns || []) notes.set(n.client_id, { ...n, mine: !!me && n.rep === me.name });
      emit();
      return rows ? rows.length : 0;
    }

    // Team-wide: who has which turf, and every pin on the map.
    async function loadTeam() {
      const [turf, ps] = await Promise.all([
        call('/rest/v1/turf_status?select=tract,status,set_at,client_id,rep'),
        call('/rest/v1/team_notes?lat=not.is.null&select=client_id,tract,bbl,address,lat,lon,body,noted_at,rep&order=noted_at.desc&limit=2000'),
      ]);
      const pend = pendingKeys('turf', 'tract');
      for (const t of [...turfBy.keys()]) if (!pend.has(t)) turfBy.delete(t);
      for (const t of turf || []) if (!pend.has(t.tract)) turfBy.set(t.tract, { ...t, mine: !!me && t.rep === me.name });
      const pendNotes = pendingKeys('note', 'client_id');
      for (const [id, n] of notes) if (n.lat != null && !pendNotes.has(id)) notes.delete(id);
      for (const n of ps || []) notes.set(n.client_id, { ...n, mine: !!me && n.rep === me.name });
      emit();
    }

    async function tractProgress(tract) {
      const rows = await call(`/rest/v1/tract_progress?tract=eq.${encodeURIComponent(tract)}`);
      return (rows && rows[0]) || { tract, knocked: 0, booked: 0, interested: 0, come_back: 0, not_interested: 0, no_answer: 0 };
    }

    async function repStats() {
      return (await call('/rest/v1/rep_stats?select=rep,knocks,booked,knocks_today,booked_today,turf_claimed')) || [];
    }

    // ---------- Saved turfs ----------
    // A rep's own queue of tracts, with an optional planned date (YYYY-MM-DD).
    function saveTurf(tract, planDate) {
      return enqueue('saved', { tract: String(tract), plan_date: planDate || null, saved_at: iso() });
    }
    async function unsaveTurf(tract) {
      if (!me) return;
      const t = String(tract);
      const pending = queue.filter((q) => q.kind === 'saved' && q.row.tract === t);
      if (pending.length) { queue = queue.filter((q) => !pending.includes(q)); write(K.queue, queue); }
      const wasSaved = teamSaved.some((x) => x.tract === t && x.rep === me.name && !x.pending);
      teamSaved = teamSaved.filter((x) => !(x.tract === t && x.rep === me.name));
      write(K2.saved, teamSaved);
      emit();
      // The database only lets you remove your own, so filtering by tract is safe.
      if (wasSaved) await call(`/rest/v1/saved_turfs?tract=eq.${encodeURIComponent(t)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
    async function loadSaved() {
      const rows = (await call('/rest/v1/team_saved_turfs?select=client_id,tract,plan_date,saved_at,rep&order=plan_date.asc.nullslast,saved_at.asc')) || [];
      const pendingSaved = queue.filter((q) => q.kind === 'saved');
      teamSaved = rows.map((r) => ({ ...r, mine: !!me && r.rep === me.name }));
      pendingSaved.forEach(applyLocal);
      write(K2.saved, teamSaved.filter((x) => !x.pending));
      const tracts = [...new Set(teamSaved.map((x) => x.tract))];
      if (tracts.length) {
        const act = (await call(`/rest/v1/tract_activity?tract=in.(${tracts.join(',')})`)) || [];
        activity = Object.fromEntries(act.map((a) => [a.tract, a]));
        write(K2.activity, activity);
      }
      emit();
      return teamSaved;
    }
    // "working" once anyone has knocked, noted, pinned or claimed there; otherwise "queued".
    const turfStage = (tract) => {
      const a = activity[String(tract)];
      const localWork = [...byBbl.values()].some((k) => k.tract === String(tract)) || [...notes.values()].some((n) => n.tract === String(tract));
      return (a && (a.knocked || a.notes || a.pins || (a.turf_status && a.turf_status !== 'open'))) || localWork ? 'working' : 'queued';
    };

    // "My stuff": my come-backs and interested houses across all tracts.
    async function myFollowups() {
      if (!me) return [];
      return (await call(`/rest/v1/latest_knocks?rep=eq.${encodeURIComponent(me.name)}&status=in.(come_back,interested)&order=knocked_at.desc&limit=200&select=bbl,tract,address,status,followup,knocked_at,rep`)) || [];
    }

    return {
      enabled: !!sb,
      signIn, signOut, loadMe, flush,
      record, undo, setTurf, undoTurf, addNote, deleteNote,
      loadTract, loadTeam, tractProgress, repStats, myFollowups,
      saveTurf, unsaveTurf, loadSaved, turfStage,
      mySaved: () => teamSaved.filter((x) => me && x.rep === me.name),
      teamSaved: () => teamSaved,
      savedFor: (tract) => teamSaved.find((x) => me && x.rep === me.name && x.tract === String(tract)) || null,
      activityFor: (tract) => activity[String(tract)] || null,
      latest: (bbl) => byBbl.get(String(bbl)) || null,
      turf: (tract) => turfBy.get(String(tract)) || null,
      allTurf: () => turfBy,
      notesFor, houseNotesInTract, pins,
      noteProblem: (b) => noteProblem(b, noteMax),
      pendingCount: () => queue.length,
      signedIn: () => !!session,
      me: () => me,
      email: () => (session && session.email) || '',
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  root.TurfTeam = { createTeam, noteProblem };
})(typeof window !== 'undefined' ? window : globalThis);
