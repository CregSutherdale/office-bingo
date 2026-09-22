# Sales Bingo

The office whiteboard bingo card, on everyone's phone. One shared card per week: tap a square
when you get it and everyone sees the X (with your initials) within seconds. A new shuffled
card starts itself every Monday; Settings holds the list of squares, and "Shuffle" reshuffles
this week's card.

No logins. The app lives at a GitHub Pages link; the shared card lives in a free Supabase
database; a team code (in the invite link, not in this repo) keeps strangers out.

## One-time setup (about 5 minutes)

1. Sign in at https://supabase.com and click **New project** (free plan). Any name, e.g.
   `office-bingo`. Pick a database password and keep it somewhere safe.
2. When it finishes, open **SQL Editor** > **New query**, paste all of `supabase/migrations/20260922000000_bingo.sql`,
   change `CHANGE-ME` on line 10 to your team code, and click **Run**. It should say
   "Success. No rows returned".
3. Open **Project Settings** > **Data API** (or **API**) and copy two values:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon public** key (a long string starting with `eyJ`)
4. Put them in `config.js` (`url` and `anonKey`) and push. Both are safe to publish: the key
   only reaches the bingo functions, and every one of them checks the team code.
5. Open the app, go to **Settings**, copy the **Invite link**, and text it to the team.

## On each phone

- Open the invite link once (it remembers the team code), pick your name.
- iPhone: Safari > Share > **Add to Home Screen**. Android: Chrome > menu > **Add to Home
  screen**. The home-screen app may ask for the team code once.

## How it works

- Weeks run Monday to Sunday. The first phone to open a new week creates its shuffled card;
  everyone gets that same card.
- Squares come from Settings: each item with how many times it appears. 24 spots plus the free
  center. More than 24 listed: a random 24 are used; fewer: random repeats fill in.
- Tap an X to see who got it and when, or to remove it.
- **Past weeks** shows old cards, view only.
- Without `config.js` values the app runs in demo mode: X's stay on that one phone.

## Keep customer information out

Only first names and square taps are stored. Don't type customer names, policy numbers or
anything about a customer into square names or team names.

## Files

`index.html` (page + styles), `app.js` (everything the page does), `config.js` (Supabase
URL + anon key), `supabase/migrations/20260922000000_bingo.sql` (tables + the functions the app calls),
`supabase/test_setup.py` (runs the migration on a real throwaway Postgres and checks every
function: `pip install pgserver psycopg2-binary`, then `python supabase/test_setup.py`).
