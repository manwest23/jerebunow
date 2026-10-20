/* JerebuNow settings.
   IQAir (places outside DOE's network) is called through the Worker's /iq
   route, which keeps the key secret and shares each reading nearby for an
   hour. iqairKey is only a fallback for running without the Worker; a key
   placed here is visible to anyone. */
window.JEREBU_CONFIG = {
  // IQAir goes through the Worker (/iq), which holds the key as a secret.
  iqairKey: "",
  // Haze alerts: the URL of your Cloudflare Worker (see worker/README.md).
  // Leave empty to hide alerts.
  alertsUrl: "https://jerebunow-alerts.luqmanharriz23.workers.dev",
  // Live and total visitor counts (same Worker; needs its D1 database).
  statsUrl: "https://jerebunow-alerts.luqmanharriz23.workers.dev"
};
