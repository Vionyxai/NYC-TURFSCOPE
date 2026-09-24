# Supabase setup: knock tracking for the 4-man team

About 15 minutes, all in the browser. You only do this once.

## How it's set up (plain version)

- **`reps`:** one row per rep: Issac, Matt, Cody, Gio (Gio is the admin). Each row gets that rep's login email, and that's how a login becomes "Matt".
- **`knocks`:** every tap on a door (house status), stamped with the rep who made it.
- **`turf_log`:** every change to an area's status: **Claimed / Finished / Avoid / Open**, stamped with the rep. This is how you see who picked which turf.
- **`notes`:** team notes, on a **house**, on a **whole tract (area)**, or as a **pin** dropped on the map.
- One table per kind of thing, with every row stamped with its rep. Each rep has their own trail (their "My stuff" in the app), and reports across the team stay simple. Adding a 5th rep is just one more row.

**Who can do what (row-level security, RLS):**
- Logged out, or logged in but not on the reps list: sees nothing.
- **Every rep sees everything the team does:** all house statuses, who claimed which turf, all notes and pins, with names and times.
- **Every rep can change any house's status and any area's status,** no matter who set it before. The newest change wins, and it's recorded under whoever made it.
- Nobody can post as someone else, and nobody can edit history. A rep can undo or delete their **own** entries; Gio (admin) can remove anyone's.

**Notes and privacy:** notes are free text up to 280 characters so the team can coordinate ("Big dog, use side gate", "Block party Saturday, skip until Monday"). The database **refuses any note with a phone number or email address**. Don't write homeowners' names either; the app reminds reps.

All of this is in [`001_team_tracking.sql`](001_team_tracking.sql) and tested by `npm run test:sql`.

## Step 1: create the project
1. Go to supabase.com → **New project**. Name: `turfscope`. Region: **East US (North Virginia)**. Save the database password somewhere safe; the app never needs it.
2. Wait for it to finish setting up (about 1 minute).

## Step 2: build the tables and security rules
1. Left menu → **SQL Editor** → **New query**.
2. Paste the **entire** contents of `supabase/001_team_tracking.sql` and press **Run**. You should see "Success. No rows returned."
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
- **Pick turf:** tap a tract → **Claim**. The map outlines it in your color with your name (Issac purple, Matt teal, Cody pink, Gio brown). **Finished** makes it dashed; **Avoid** makes it dark dotted; **Open** releases it. Any rep can change any area. "Undo last area change" takes back your own.
- **Knock:** open the walk list → tap a house → pick a status. "Come back" asks when. The black bar has **Undo** for 6 seconds; later use "Undo last knock" in the house's sheet.
- **Notes:** in a house's sheet (house notes), on a tract card (area notes), or tap the **pin** button (top right, under locate) to drop a pin at your location or anywhere you tap. Everyone sees them right away.
- **My stuff:** tap your name, top right. It shows your claimed turf, your come-backs and interested houses (tap to jump there) and the team's numbers today. The **Mine** button shows only your turf on the map.
- **No signal?** Keep going. Knocks, claims and notes save on the phone ("waiting to sync") and go up by themselves when signal returns. Signing out is blocked until everything has synced.
- **Hide done** in a walk list hides Booked and Not interested houses.
- Teammates' changes show up within about a minute, or right away when you reopen the app.

## Office side (Supabase dashboard)
- **All knocks:** Table Editor → `knocks`, or `latest_knocks` for one row per house (with address). **Export → CSV**.
- **Who has which turf:** `turf_status`. Full history: `turf_log`.
- **All notes and pins:** `team_notes`.
- **Scoreboard:** Table Editor → `rep_stats`.
- **Someone leaves:** `update public.reps set active = false where name = 'Cody';` removes their access right away and keeps their knock history.
- **Add a rep:** `insert into public.reps (name, email) values ('New Rep', 'new@example.com');`, then create their login (step 3). Also add them to `config/team.json` so the files stay in sync (`npm test` checks this).

## Good to know
- **Free plan pause:** Supabase pauses free projects after about a week with no activity. Daily knocking keeps it awake. If the team is off for a while, open the dashboard and click **Restore** before the next shift.
- **Changing statuses or follow-up choices:** they live in `config/team.json` and in the check rules in the SQL. Change both, since `npm test` fails if they drift apart, and apply the SQL change in the editor. Ask Claude to write the migration.
