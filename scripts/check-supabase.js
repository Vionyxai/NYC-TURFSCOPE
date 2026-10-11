// Health check for the live Supabase project, using only the public (publishable) key.
// Tells you whether the SQL has been run, whether sign-ups are locked, and that logged-out
// visitors can't read team data. Usage: npm run check:supabase   (needs internet)
import { config } from '../lib/util.js';
import { checkSupabase } from './app-config.js';

const c = checkSupabase(config('supabase.json'));
if (!c.ok) { console.error(`✗ config/supabase.json: ${c.reason}`); process.exit(1); }
const get = async (path) => {
  const res = await fetch(c.url + path, { headers: { apikey: c.key } });
  let body = null; try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
let problems = 0;
const ok = (m) => console.log(`✓ ${m}`);
const bad = (m) => { problems++; console.log(`✗ ${m}`); };

console.log(`Supabase project: ${c.url}`);
const settings = await get('/auth/v1/settings');
if (settings.status !== 200) bad(`Can't reach the project or the key is wrong (auth settings → HTTP ${settings.status}: ${JSON.stringify(settings.body)})`);
else {
  ok('Project reachable, publishable key accepted');
  if (settings.body.external?.email === false) bad('Email login is turned off: Authentication → Sign In / Providers → Email → enable');
  else ok('Email + password login enabled');
  if (settings.body.disable_signup) ok('Open sign-ups are OFF (only accounts Gio creates can log in)');
  else bad('Open sign-ups are ON: turn off "Allow new users to sign up" (Authentication → Sign In / Providers). RLS still protects the data, but lock it anyway.');
}

// Logged out, the anon key must be refused on every team table. The error code tells us the SQL ran:
// 42501 = permission denied (table exists, locked) · PGRST205/42P01 = table doesn't exist yet.
// Which SQL file creates each table/view, so a missing one names the file to run.
const FROM = { saved_turfs: '003_saved_turfs.sql', team_saved_turfs: '003_saved_turfs.sql', tract_activity: '003_saved_turfs.sql',
  area_tags: '005_area_tags.sql', team_tags: '005_area_tags.sql',
  appointments: '006_appointments.sql', team_appointments: '006_appointments.sql',
  appointment_updates: '007_appointment_outcomes.sql', appointment_history: '007_appointment_outcomes.sql' };
for (const t of ['reps', 'knocks', 'turf_log', 'notes', 'latest_knocks', 'turf_status', 'team_notes', 'tract_progress', 'rep_stats', ...Object.keys(FROM)]) {
  const file = `supabase/${FROM[t] || '001_team_tracking.sql'}`;
  const r = await get(`/rest/v1/${t}?select=*&limit=1`);
  const code = r.body && r.body.code;
  if (r.status === 200) bad(`${t}: readable while logged out: SECURITY PROBLEM, re-run ${file}`);
  else if (code === '42501' || r.status === 401 || r.status === 403) ok(`${t}: exists and is locked to logged-in reps`);
  else if (code === 'PGRST205' || code === '42P01' || r.status === 404) bad(`${t}: not found. Run ${file} in the SQL Editor`);
  else bad(`${t}: unexpected answer HTTP ${r.status} ${JSON.stringify(r.body)}`);
}
// Columns the app reads that later files add to existing views (a view can exist but be the old version).
for (const [view, cols, file] of [['team_appointments', 'status,status_at,status_rep,when_at', '007_appointment_outcomes.sql']]) {
  const r = await get(`/rest/v1/${view}?select=${cols}&limit=1`);
  const code = r.body && r.body.code;
  if (code === '42703' || code === 'PGRST204' || (r.status === 400 && /column/i.test(JSON.stringify(r.body)))) bad(`${view}: missing ${cols}. Run supabase/${file} in the SQL Editor`);
  else if (r.status === 200) bad(`${view}: readable while logged out: SECURITY PROBLEM`);
  else ok(`${view}: has ${cols.split(',').join(', ')}`);
}
console.log(problems ? `\n${problems} thing(s) to fix: see supabase/README.md` : '\nAll good: Supabase is ready. Every table and view exists and is locked to signed-in reps. (New rep? Create their login and link the email: supabase/README.md steps 3–4.)');
process.exit(problems ? 1 : 0);
