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

## Free plan limits

KV allows 1,000 writes and 100,000 reads a day. The Worker only writes when a
reading crosses a level, so this comfortably covers thousands of users. It
stops accepting new sign-ups at 5,000 (`MAX_SUBS`).

## iPhone

Web push works on iOS 16.4 and later, only for apps added to the Home Screen.
The app explains this when someone taps the bell in Safari.
