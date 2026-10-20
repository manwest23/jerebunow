/* JerebuNow · IQAir client (official AirVisual API, Community plan).
   - nearest(lat, lon): air quality (US AQI) + weather for the nearest IQAir city
   - search(query): city search via Open-Meteo geocoding (free, no key)
   Calls go through the JerebuNow Worker (/iq), which keeps the key secret and
   shares each reading with everyone nearby for an hour. If the Worker isn't set
   up, it falls back to calling IQAir directly with the key in config.js, spaced
   to stay within the free plan's 5 calls per minute. Results are also cached on
   this device for 30 minutes. */
window.JerebuIQ = (() => {
  "use strict";
  const CFG = window.JEREBU_CONFIG || {};
  const KEY = (CFG.iqairKey || "").trim();
  const PROXY = (CFG.iqairProxy || CFG.alertsUrl || "").replace(/\/$/, "");
  const API = "https://api.airvisual.com/v2/nearest_city";
  const GEO = "https://geocoding-api.open-meteo.com/v1/search";
  const TTL = 30 * 60 * 1000;
  const PER_MIN = 5;
  const CACHE_PREFIX = "jerebunow.iq.";
  const CALLS_KEY = "jerebunow.iqcalls";

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cell = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;     // ~1 km grid

  // Rolling one-minute window, remembered across reloads on this device
  async function slot() {
    for (;;) {
      const now = Date.now();
      const calls = (ls.get(CALLS_KEY) || []).filter((t) => now - t < 61000);
      if (calls.length < PER_MIN) { calls.push(now); ls.set(CALLS_KEY, calls); return; }
      await sleep(61000 - (now - calls[0]) + 100);
    }
  }

  const POLLUTANT = { p2: "PM2.5", p1: "PM10", o3: "O3", n2: "NO2", s2: "SO2", co: "CO" };
  function normalise(d, lat, lon) {
    const p = d.current?.pollution || {}, w = d.current?.weather || {};
    const [clon, clat] = d.location?.coordinates || [lon, lat];
    return {
      source: "iqair",
      name: d.city || "",
      state: [d.state, d.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", "),
      country: d.country || "",
      lat: clat, lon: clon,
      api: Number.isFinite(p.aqius) ? p.aqius : null,
      pollutant: POLLUTANT[p.mainus] || null,
      readingTime: p.ts || null,
      history: [],
      weather: { tp: w.tp, hu: w.hu, ws: w.ws, ic: w.ic || "", ts: w.ts }
    };
  }

  const inflight = new Map();
  /** Resolves { station, cached, stale } or { error: code } */
  let proxyDown = false;
  async function callIQ(lat, lon) {
    // Rounded to ~1 km here; the Worker rounds further to its ~11 km shared squares
    if (PROXY && !proxyDown) {
      try {
        const res = await fetch(`${PROXY}/iq?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
        const body = await res.json().catch(() => null);
        if (body && (body.status === "success" || (body.data && body.data.message !== "no_key"))) return { res, body };
      } catch { /* fall back below */ }
      proxyDown = true;                                     // Worker not set up: use the key directly
    }
    if (!KEY) return { res: { status: 0 }, body: { status: "fail", data: { message: "no_key" } } };
    await slot();
    const res = await fetch(`${API}?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}&key=${encodeURIComponent(KEY)}`);
    return { res, body: await res.json().catch(() => null) };
  }
  function nearest(lat, lon) {
    if (!KEY && !PROXY) return Promise.resolve({ error: "no_key" });
    const id = cell(lat, lon);
    const hit = ls.get(CACHE_PREFIX + id);
    if (hit && Date.now() - hit.t < TTL) return Promise.resolve({ station: hit.s, cached: true });
    if (inflight.has(id)) return inflight.get(id);
    const job = (async () => {
      try {
        const { res, body } = await callIQ(lat, lon);
        if (body && body.status === "success" && body.data) {
          const s = normalise(body.data, lat, lon);
          if (s.api == null) throw Object.assign(new Error(), { code: "no_data" });
          ls.set(CACHE_PREFIX + id, { t: Date.now(), s });
          return { station: s };
        }
        throw Object.assign(new Error(), { code: (body && body.data && body.data.message) || `http_${res.status}` });
      } catch (e) {
        const code = e.code || "network";
        if (hit) return { station: hit.s, stale: true, error: code };   // show the last reading we have
        return { error: code };
      } finally { inflight.delete(id); }
    })();
    inflight.set(id, job);
    return job;
  }

  /** City search: [{ name, admin, country, lat, lon }] */
  async function search(q, lang) {
    const res = await fetch(`${GEO}?name=${encodeURIComponent(q)}&count=8&format=json&language=${lang === "ms" ? "ms" : "en"}`);
    if (!res.ok) throw new Error(res.status);
    const body = await res.json();
    return (body.results || []).map((r) => ({
      name: r.name, admin: r.admin1 || "", country: r.country || "",
      lat: r.latitude, lon: r.longitude
    }));
  }

  return { enabled: !!(KEY || PROXY), nearest, search, cell };
})();
