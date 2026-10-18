# JerebuNow haze alerts (Cloudflare Worker)

This small server sends push notifications when a DOE station crosses a level
someone asked about (above 100, above 200, above 180 for school closures, or
back to 100 and below for running). It runs on Cloudflare's free plan.

It checks `data/api.json` on the JerebuNow site every hour. Signing keys are
created automatically on first use and stored in KV, so there are no secrets
to set.

## Set up in the Cloudflare dashboard (about 10 minutes, no coding)

1. Sign up free at https://dash.cloudflare.com.
2. **Workers & Pages → Create → Create Worker.** Name it `jerebunow-alerts`, then **Deploy**.
3. Click **Edit code**, delete the sample, paste the whole of `worker.js`, then **Deploy**.
4. **Storage & Databases → KV → Create** a namespace called `jerebunow-subs`.
5. Back in the Worker: **Settings → Bindings → Add → KV namespace**.
   Variable name `SUBS`, namespace `jerebunow-subs`. Save and deploy.
6. **Settings → Triggers → Add Cron Trigger**: `20 * * * *` (every hour at :20,
   just after the site's hourly data update).
7. Open `https://jerebunow-alerts.<your-subdomain>.workers.dev/vapid` in a browser.
   You should see `{"publicKey":"B..."}`.
8. Put that Worker URL (without `/vapid`) in `config.js` as `alertsUrl`.

The bell button then appears in the app.

## Visitor counts (live and total)

The footer's "online now" and "visitors in total" come from the same Worker.

1. **Storage & Databases → D1 SQL Database → Create**, name it `jerebunow-stats`.
2. In the Worker: **Settings → Bindings → Add → D1 database**, variable name `DB`, database `jerebunow-stats`.
3. Paste the latest `worker.js` and **Deploy**. Tables are created automatically.

Each browser gets a random anonymous ID; no IP or location is stored. "Online now"
means seen in the last 5 minutes (the app checks in every 2 minutes while open).
D1's free plan allows 100,000 row writes a day; a new visitor costs 2 writes and a
returning one at most 1 per check-in.

## Telegram channel (optional)

The Worker can post to a public Telegram channel: a summary of every state at
7 am, and a post when a state's worst reading goes above 100, 200 or 300, or
back to 100 or below.

1. In Telegram, message **@BotFather** → `/newbot` → pick a name and a username
   ending in `bot`. Copy the **token** it gives you.
2. Create a **public channel** (e.g. `@jerebunow`), then add your bot as an
   **administrator** that can post messages.
3. In the Worker: **Settings → Variables and secrets → Add**
   - `TG_TOKEN` · type **Secret** · the BotFather token
   - `TG_CHAT` · type **Text** · your channel username, e.g. `@jerebunow`
4. Deploy. The first hourly run posts a "Haze right now" summary so you can see
   it works; after that it posts at 7 am and when levels change.

## Free plan limits

KV allows 1,000 writes and 100,000 reads a day. The Worker only writes when a
reading crosses a level, so this comfortably covers thousands of users. It
stops accepting new sign-ups at 5,000 (`MAX_SUBS`).

## iPhone

Web push works on iOS 16.4 and later, only for apps added to the Home Screen.
The app explains this when someone taps the bell in Safari.
