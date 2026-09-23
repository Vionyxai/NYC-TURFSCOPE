# m5 — freshness jobs (not built yet)

Planned n8n workflows. Build these after the map is in use.

1. **Con Ed funding meter** — Con Edison publishes Clean Heat program funding status on a regular cadence. Scrape it on a schedule and alert (Twilio SMS) if remaining residential funds drop sharply.
   Page: https://www.coned.com/en/our-energy-future/electric-heating-and-cooling-equipment/clean-heat-program-funding
2. **DOB mechanical permits → suppression list** — weekly pull from NYC Open Data of recent mechanical/HVAC permits; write BBLs that likely already converted to `data/raw/suppress_bbls.json`, then have m4 skip them. First confirm heat pump jobs are identifiable (job type or description keywords).
3. **Program numbers check** — monthly reminder to re-verify rebate notes in `config/utilities.json` and bump `last_verified`.

Keep each workflow independent: it writes one file into `data/raw/`, and the existing modules pick it up.
