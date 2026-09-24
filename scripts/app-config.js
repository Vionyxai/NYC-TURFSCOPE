// Writes m3-map/data/app.json: what the phone app needs for knock tracking.
// Reads config/supabase.json (project URL + publishable key) and config/team.json (statuses, follow-ups).
// Usage: npm run app-config   (also runs at the end of npm run pipeline)
import { config, writeJSON, out, log, warn, isMain } from '../lib/util.js';

// The publishable/anon key is safe in a public web page; a secret/service key is not.
export function checkSupabase(sb) {
  const url = String(sb?.url || '').trim().replace(/\/+$/, '');
  const key = String(sb?.anon_key || '').trim();
  if (!url && !key) return { ok: false, reason: 'not set up yet' };
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) return { ok: false, reason: `URL should look like https://abcd1234.supabase.co (got "${url}")` };
  if (/^sb_secret_/.test(key)) return { ok: false, reason: 'that is the SECRET key — use the publishable key instead', secret: true };
  if (/^eyJ/.test(key)) {
    try {
      const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role;
      if (role === 'service_role') return { ok: false, reason: 'that is the service_role key — use the anon/publishable key instead', secret: true };
      if (role !== 'anon') return { ok: false, reason: `unexpected key role "${role}"` };
    } catch { return { ok: false, reason: 'key is not a valid Supabase key' }; }
  } else if (!/^sb_publishable_/.test(key)) return { ok: false, reason: 'key should start with sb_publishable_ (or be the legacy anon key)' };
  return { ok: true, url, key };
}

export function buildAppConfig(sb, team) {
  const c = checkSupabase(sb);
  return {
    supabase: c.ok ? { url: c.url, key: c.key } : null,
    supabase_status: c.ok ? 'ready' : c.reason,
    statuses: team.knock_statuses,
    followups: team.followups,
    refresh_seconds: team.refresh_seconds,
  };
}

function main() {
  const app = buildAppConfig(config('supabase.json'), config('team.json'));
  if (!app.supabase) {
    if (/SECRET|service_role/.test(app.supabase_status)) { console.error(`[turfscope] Supabase key refused: ${app.supabase_status}`); process.exit(1); }
    warn(`Knock tracking off: Supabase ${app.supabase_status}. Fill in config/supabase.json.`);
  } else log(`Knock tracking on → ${app.supabase.url}`);
  writeJSON(out('app.json'), app);
}

if (isMain(import.meta.url)) main();
