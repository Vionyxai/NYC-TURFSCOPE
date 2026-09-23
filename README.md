# TurfScope NYC

Heat pump turf map for NY Clean Heat door-to-door sales. It scores census tracts in Queens, Nassau and Suffolk (then the rest of the turf area) by how many 1–4 family homes there are, how old they are, what they heat with, owner-occupancy and incentive eligibility. Every tract is tagged Con Edison or PSEG Long Island. Queens also gets address-level walk lists.

## Quick start

```bash
npm test           # offline check, no network needed
npm run pipeline   # pull live data + score + walk lists (a few minutes)
npm run dev        # open http://localhost:3000
```

Requires Node 18.17+. No npm install needed — there are zero dependencies.

The pipeline needs a free Census API key (https://api.census.gov/data/key_signup.html). Put it in `.env` as `CENSUS_API_KEY` for local runs, and add it as a repository secret named `CENSUS_API_KEY` (Settings → Secrets and variables → Actions) for the GitHub refresh.

## Deploy

Push to GitHub, import the repo in Vercel, and deploy. `vercel.json` serves `m3-map/` as-is.

To refresh the data without running anything locally: GitHub → **Actions** → **Refresh data** → **Run workflow**. It runs the tests and the live pipeline, then commits `m3-map/data/`, and Vercel redeploys. The office CSV (`walklists_all.csv`) is attached to the run as a download. You can still run `npm run pipeline` locally and commit the result instead.

## Docs

- `SPEC.md` — what it does and why
- `CLAUDE.md` — how to work on it (read this first if you're an agent)
- `config/` — every tunable number, endpoint and the turf boundary
