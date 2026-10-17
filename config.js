/* JerebuNow settings.
   iqairKey: a free IQAir "Community" API key (https://dashboard.iqair.com).
   It powers places outside DOE's network. Leave empty to show DOE only.
   A key in a website is visible to anyone, and all users share its quota
   (5 calls/min, 10,000/month on the free plan); the app caches to save calls. */
window.JEREBU_CONFIG = {
  iqairKey: "5a9c1979-25bf-4ae1-9ad3-c0396cf3d001",
  // Haze alerts: the URL of your Cloudflare Worker (see worker/README.md).
  // Leave empty to hide alerts.
  alertsUrl: "https://jerebunow-alerts.luqmanharriz23.workers.dev",
  // Live and total visitor counts (same Worker; needs its D1 database).
  statsUrl: "https://jerebunow-alerts.luqmanharriz23.workers.dev"
};
