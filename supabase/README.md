# Supabase setup: knock tracking for the 4-man team

About 15 minutes, all in the browser. You only do this once.

## How it's set up (plain version)

- **`reps` table:** one row per rep: Issac, Matt, Cody, Gio. Gio is the admin. Each row gets that rep's login email.
- **`knocks` table:** every tap on a door. Each knock is automatically stamped with the rep who made it, so every rep has their own trail of knocks inside one table. That's easier to report on than a separate table per rep, and adding a 5th rep is just one more row.
- **Row-level security (RLS):** the database's own rules.
  - Logged out: sees nothing.
  - Logged in but not on the reps list: sees nothing.
  - Reps see the whole team's knocks, so nobody double-knocks.
  - A rep can only add knocks under their own name and undo their own. Gio can undo anyone's.
  - Nobody can edit an old knock. A new tap just becomes the latest status.
- **No personal data:** houses are stored by their NYC lot ID (BBL) only. No homeowner names, no phone numbers, no free-text notes.

All of this is in [`001_knock_tracking.sql`](001_knock_tracking.sql) and tested by `npm run test:sql`.

## Step 1: create the project
1. Go to supabase.com → **New project**. Name: `turfscope`. Region: **East US (North Virginia)**. Save the database password somewhere safe; the app never needs it.
2. Wait for it to finish setting up (about 1 minute).

## Step 2: build the tables and security rules
1. Left menu → **SQL Editor** → **New query**.
2. Paste the **entire** contents of `supabase/001_knock_tracking.sql` and press **Run**. You should see "Success. No rows returned."
3. Left menu → **Table Editor**. You should see `reps` with Issac, Matt, Cody and Gio.

## Step 3: lock down sign-ups and create the 4 logins
1. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Only you create accounts. (Even if a stranger got an account, the RLS rules would show them nothing. This is a second lock.)
2. **Authentication → Users → Add user → Create new user**, four times, one per rep:
   - Their email and a password (you tell them the password).
   - Check **Auto Confirm User**.

## Step 4: link each login to a rep
SQL Editor → New query. Put in the real emails, then Run:

```sql
update public.reps set email = 'issac@example.com' where name = 'Issac';
update public.reps set email = 'matt@example.com'  where name = 'Matt';
update public.reps set email = 'cody@example.com'  where name = 'Cody';
update public.reps set email = 'gio@example.com'   where name = 'Gio';
select name, email, is_admin, active from public.reps order by id;
```

The emails must match the logins from step 3 exactly (upper/lower case doesn't matter).

## Step 5: connect the app
1. **Project Settings → API Keys** (or **API**). Copy:
   - **Project URL**, like `https://abcd1234.supabase.co`
   - the **publishable** key (`sb_publishable_…`, or the legacy **anon** key)
2. Send both to Claude, or put them in `config/supabase.json` yourself, then run `npm run app-config` and commit.
   - The app refuses the **secret / service_role** key if it's pasted by mistake. Never share that one.
3. Vercel redeploys on the commit. Open the site: a **Sign in** button appears top right.

## Step 6: set up each iPhone
1. Open the Vercel link in **Safari** (not Chrome, and not a link opened inside Messages or Gmail's built-in browser).
2. Tap **Share → Add to Home Screen → Add**. Use the green TurfScope icon from now on.
3. Open it, tap **Sign in**, and enter the email and password from step 3. Reps stay signed in; nobody has to log in every morning.
4. Tap the **locate** button (top right under +/−) and choose **Allow While Using App**.
   - If it was denied: Settings → Privacy & Security → Location Services → Safari Websites → While Using the App. Then reopen TurfScope.
5. Test knock: open any Queens walk list, tap a house, tap **No answer**, then tap **Undo** in the black bar.

Heads-up: the home-screen app and Safari keep separate logins. Sign in inside the home-screen app.

## Day to day
- **Tap a house → pick a status.** "Come back" asks when (after 5pm, weekend, and so on). The black bar at the bottom has **Undo** for 6 seconds, and "Undo last knock" is in the house's sheet after that.
- **No signal?** Keep knocking. Knocks save on the phone ("waiting to sync") and go up by themselves when signal comes back. The name button top right shows "Matt · 3 to sync" until then. Signing out is blocked until everything has synced, so nothing gets lost.
- **Hide done** hides Booked and Not interested houses. No answer, Come back and Interested stay visible.
- **Scoreboard:** tap your name top right to see today's knocks and bookings per rep.
- **Team progress:** tract cards show "142 of 628 knocked · 6 booked".

## Office side (Supabase dashboard)
- **All knocks:** Table Editor → `knocks`, or `latest_knocks` for one row per house. **Export → CSV**.
- **Scoreboard:** Table Editor → `rep_stats`.
- **Someone leaves:** `update public.reps set active = false where name = 'Cody';` removes their access right away and keeps their knock history.
- **Add a rep:** `insert into public.reps (name, email) values ('New Rep', 'new@example.com');`, then create their login (step 3). Also add them to `config/team.json` so the files stay in sync (`npm test` checks this).

## Good to know
- **Free plan pause:** Supabase pauses free projects after about a week with no activity. Daily knocking keeps it awake. If the team is off for a while, open the dashboard and click **Restore** before the next shift.
- **Changing statuses or follow-up choices:** they live in `config/team.json` and in the check rules in the SQL. Change both, since `npm test` fails if they drift apart, and apply the SQL change in the editor. Ask Claude to write the migration.
