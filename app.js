/* JerebuNow — Malaysian Air Pollutant Index (API / IPU) in an Apple Weather
   style layout, in English and Bahasa Melayu. Page 1 is the station nearest
   to you; add more stations and swipe between them. The map (map.js) loads
   on first use. Data: data/api.json, refreshed hourly by
   scripts/fetch-apims.mjs from DOE APIMS and MET Malaysia.
   Developed by manwest. */
(() => {
  "use strict";

  const DATA_URL = "data/api.json";
  const WORLD_URL = "data/world.json";        // IQAir city snapshot, refreshed every 3 h
  const HISTORY_URL = "data/history.json";    // 7 days of DOE readings
  const FIRES_URL = "data/fires.json";        // NASA FIRMS hotspots, 24 h
  const MY_TZ = "Asia/Kuala_Lumpur";
  const REFRESH_MS = 15 * 60 * 1000;
  const SAVED_KEY = "jerebunow.saved";
  const PAGE_KEY = "jerebunow.page";
  const LANG_KEY = "jerebunow.lang";
  const PLACES_KEY = "jerebunow.places";
  const IQ = window.JerebuIQ || { enabled: false };
  const DOE_FAR_KM = 50;          // beyond this, try IQAir for "My Location"
  const I18N = window.JEREBU_I18N;

  /* ---------- API bands (DOE) ---------- */
  const BANDS = [
    { key: "good", max: 50, en: "Good", ms: "Baik", color: "var(--good)", hex: "#3a8bea", sign: "✓" },
    { key: "moderate", max: 100, en: "Moderate", ms: "Sederhana", color: "var(--moderate)", hex: "#3fb560", sign: "✓" },
    { key: "unhealthy", max: 200, en: "Unhealthy", ms: "Tidak Sihat", color: "var(--unhealthy)", hex: "#f2c230", sign: "!" },
    { key: "very", max: 300, en: "Very Unhealthy", ms: "Sangat Tidak Sihat", color: "var(--very)", hex: "#f08a24", sign: "!" },
    { key: "hazard", max: Infinity, en: "Hazardous", ms: "Berbahaya", color: "var(--hazard)", hex: "#e5443a", sign: "!" }
  ];
  const bandFor = (v) => BANDS.find((b) => v <= b.max) || BANDS[BANDS.length - 1];
  const RANGES = ["0–50", "51–100", "101–200", "201–300", "300+"];

  /* ---------- US AQI bands (IQAir places) ---------- */
  const US_BANDS = [
    { key: "good", us: true, max: 50, hex: "#3fb560", sky: "moderate", sign: "✓" },
    { key: "moderate", us: true, max: 100, hex: "#f2c230", sky: "unhealthy", sign: "✓" },
    { key: "usg", us: true, max: 150, hex: "#f08a24", sky: "very", sign: "!" },
    { key: "unhealthy", us: true, max: 200, hex: "#e5443a", sky: "hazard", sign: "!" },
    { key: "very", us: true, max: 300, hex: "#8f3f97", sky: "purple", sign: "!" },
    { key: "hazardous", us: true, max: Infinity, hex: "#7e0023", sky: "maroon", sign: "!" }
  ].map((b) => ({ ...b, color: b.hex }));
  const US_RANGES = ["0–50", "51–100", "101–150", "151–200", "201–300", "301+"];
  const usBandFor = (v) => US_BANDS.find((b) => v <= b.max) || US_BANDS[US_BANDS.length - 1];
  const isIQ = (s) => s && s.source === "iqair";
  const bandOf = (s) => (isIQ(s) ? usBandFor(s.api) : bandFor(s.api));
  const skyOf = (b) => b.sky || b.key;
  const unitOf = (s) => (isIQ(s) ? T.usAqi : T.api);

  const $ = (id) => document.getElementById(id);
  const state = {
    data: null, dataStamp: null, coords: null, locating: true,
    saved: [], page: 0, editing: false, lang: "en",
    places: {}, iq: {}, iqMe: null, iqStamp: 0, world: [], hist: null, fires: null
  };
  let T = I18N.en;
  const otherLang = () => (state.lang === "en" ? "ms" : "en");
  const bandText = (b) => (b.us ? T.usBands[b.key] : T.bands[b.key]);
  const otherBandLabel = (b) => (b.us ? I18N[otherLang()].usBands : I18N[otherLang()].bands)[b.key].label;

  /* ---------- helpers ---------- */
  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtKm = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + " km";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const isNight = () => { const h = new Date().getHours(); return h < 7 || h >= 19; };
  const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const weekday = (iso, style) => new Date(iso + "T00:00:00").toLocaleDateString(T.locale, { weekday: style });

  const fmtTime = (d) => d.toLocaleTimeString(T.locale, { hour: "numeric", minute: "2-digit", timeZone: MY_TZ });
  const fmtLocalTime = (d) => d.toLocaleTimeString(T.locale, { hour: "numeric", minute: "2-digit" });
  // Sunrise and sunset (NOAA approximation, good to a minute or two)
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180;
    const y = date.getFullYear(), m = date.getMonth(), dd = date.getDate();
    const doy = Math.round((Date.UTC(y, m, dd) - Date.UTC(y, 0, 0)) / 864e5);
    const g = (2 * Math.PI / 365) * (doy - 1);
    const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) - Math.tan(lat * rad) * Math.tan(decl)) / rad;
    const base = Date.UTC(y, m, dd);
    return { rise: new Date(base + (720 - 4 * (lon + ha) - eqt) * 6e4), set: new Date(base + (720 - 4 * (lon - ha) - eqt) * 6e4) };
  }

  function timeAgo(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return "";
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return T.updatedNow;
    if (mins < 60) return T.updatedMin(mins);
    if (mins < 24 * 60) return T.updatedHour(Math.round(mins / 60));
    return T.updatedOn(t.toLocaleDateString(T.locale));
  }

  const ARROW = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M11 1 1 5.4l4.6 1 1 4.6Z"/></svg>';
  const ICON = {
    advice: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14s-5.5-3.3-5.5-7.2A3 3 0 0 1 8 4.6a3 3 0 0 1 5.5 2.2C13.5 10.7 8 14 8 14Z"/></svg>',
    run: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="10" cy="2.6" r="1.4"/><path d="m4.5 6.5 3-1.5 2.5 2 2 .5M7.5 5l-1 4 2.5 2-1 3.5M6.5 9 4 11.5H1.5"/></svg>',
    clock: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
    cal: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="12" rx="2"/><path d="M1.5 6.5h13M5 1v3M11 1v3"/></svg>',
    pol: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="9" r="2.5"/><circle cx="11" cy="6" r="3"/><circle cx="10" cy="12.5" r="1.5"/></svg>',
    trend: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 12 6 7.5l3 3 5.5-6"/><path d="M10.5 4.5h4v4"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="m5 8.2 2 2L11 6"/></svg>',
    share: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v10M6.5 6 10 2.5 13.5 6"/><path d="M6 9H4.5v8.5h11V9H14"/></svg>'
  };

  /* ---------- weather (MET Malaysia text is in Bahasa Melayu) ---------- */
  function weather(raw) {
    const s = String(raw || "").toLowerCase();
    const ext = /kebanyakan/.test(s) ? "widespread" : /beberapa/.test(s) ? "scattered" : /satu dua/.test(s) ? "isolated" : "";
    let kind = "cloud";
    if (/ribut petir/.test(s)) kind = "storm";
    else if (/tiada hujan/.test(s) || /cerah/.test(s)) kind = "clear";
    else if (/hujan/.test(s)) kind = "rain";
    else if (/jerebu/.test(s)) kind = "haze";
    // BM keeps MET's wording; EN translates it.
    let label;
    if (!T.wx) label = cap(String(raw || "--"));
    else {
      const e = ext ? T.extent[ext] : "";
      const f = T.wx[kind];
      label = typeof f === "function" ? cap(f(e).trim()) : f;
      if (kind === "cloud" && !/mendung|berawan/.test(s) && raw) label = raw;
    }
    return { kind, label };
  }
  const WX = {
    clear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6" fill="#ffd23f"/><g stroke="#ffd23f" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5h10.2a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.8 1.4A3.1 3.1 0 0 0 7 18.5Z" fill="#fff"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.2a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.8 8.3 3.1 3.1 0 0 0 7 14.5Z" fill="#fff"/><g stroke="#7cc4ff" stroke-width="1.8" stroke-linecap="round"><path d="m8.5 17-1 3M12.5 17l-1 3M16.5 17l-1 3"/></g></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.2a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.8 8.3 3.1 3.1 0 0 0 7 14.5Z" fill="#fff"/><path d="M12.6 14 10 18.2h2.6L11.4 22l3.8-5.2h-2.6l1.2-2.8Z" fill="#ffd23f"/></svg>',
    haze: '<svg viewBox="0 0 24 24"><g stroke="#e6d8b8" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h17M5.5 12h13M3.5 16h17M7.5 20h9"/></g></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M15.5 3.5a8.5 8.5 0 1 0 5 15.2A7 7 0 0 1 15.5 3.5Z" fill="#f2eedf"/></svg>'
  };
  const PERIOD_KEYS = ["morning", "afternoon", "night"];
  // Only rain and thunderstorms make a run wet; haze or cloud is still dry.
  const isDry = (raw) => { const k = weather(raw).kind; return k !== "rain" && k !== "storm"; };
  const periodIndexNow = () => { const h = new Date().getHours(); return h < 12 ? 0 : h < 19 ? 1 : 2; };

  /* ---------- data ---------- */
  async function loadData() {
    try {
      const res = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (err) {
      if (window.__HAZE_SAMPLE__) return window.__HAZE_SAMPLE__;
      throw err;
    }
  }
  async function loadWorldSnapshot() {
    try {
      const res = await fetch(WORLD_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const w = await res.json();
      // Only use readings from the last 6 hours
      state.world = (w.places || []).filter((p) => Number.isFinite(p.api) &&
        (!p.readingTime || Date.now() - new Date(p.readingTime) < 6 * 3600000));
    } catch { /* optional */ }
  }
  async function loadHistory() {
    try {
      const res = await fetch(HISTORY_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) { state.hist = await res.json(); state.iqStamp++; }
    } catch { /* optional */ }
  }
  async function loadFires() {
    try {
      const res = await fetch(FIRES_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (res.ok) state.fires = await res.json();
    } catch { /* optional */ }
  }
  // A snapshot city within 12 km of a point, so adding it needs no API call
  function snapshotNear(lat, lon) {
    let best = null, bd = 12;
    for (const p of state.world) { const d = km({ lat, lon }, p); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  function getPosition() {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5 * 60 * 1000 }
      );
    });
  }
  const stations = () => (state.data?.stations || []).filter((s) => Number.isFinite(s.api));
  const stationById = (id) => stations().find((s) => s.id === id) || null;
  function nearest(coords) {
    let best = null, bd = Infinity;
    for (const s of stations()) { const d = km(coords, s); if (d < bd) { bd = d; best = s; } }
    return best ? { s: best, d: bd } : null;
  }
  const fcCache = new Map();
  function forecastFor(s) {
    const f = state.data?.forecasts?.[s.forecastKey];
    if (!f || !Array.isArray(f.days) || !f.days.length) return null;
    // One row per date (MET can list a place both as a state and a district)
    if (!fcCache.has(f)) {
      const seen = new Set(), days = [];
      for (const d of f.days.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        if (seen.has(d.date)) continue; seen.add(d.date); days.push(d);
      }
      fcCache.set(f, { ...f, days });
    }
    return fcCache.get(f);
  }
  function todayIndex(days) {
    const i = days.findIndex((d) => d.date >= localISO(new Date()));
    return i >= 0 ? i : 0;
  }
  const isWorldId = (id) => typeof id === "string" && id.startsWith("w:");
  function entries() {
    const list = [{ kind: "me" }];
    for (const id of state.saved) {
      if (isWorldId(id) ? state.places[id] : stationById(id)) list.push({ kind: "saved", id });
    }
    return list.map((e) => {
      if (e.kind === "me") {
        const n = state.coords ? nearest(state.coords) : null;
        // Outside DOE coverage (abroad, or far from any station): use IQAir when it is closer
        const iq = state.iqMe && state.iqMe.station;
        if (state.coords && iq && (!n || n.d > DOE_FAR_KM)) {
          const d = km(state.coords, iq);
          if (!n || d < n.d) return { ...e, s: iq, d, iqRes: state.iqMe };
        }
        return { ...e, s: n?.s || null, d: n?.d ?? null };
      }
      if (isWorldId(e.id)) {
        const res = state.iq[e.id];
        const s = res && res.station ? res.station : null;
        return { ...e, world: true, place: state.places[e.id], iqRes: res, s, d: s && state.coords ? km(state.coords, s) : null };
      }
      const s = stationById(e.id);
      return { ...e, s, d: state.coords ? km(state.coords, s) : null };
    });
  }

  /* ---------- running advice ---------- */
  const LEVELS = { go: 0, care: 1, stop: 2 };
  const DOT = { go: "var(--run-go)", care: "var(--run-care)", stop: "var(--run-stop)" };

  function airFactor(s) {
    const u = unitOf(s);
    if (isIQ(s)) {                                          // US AQI thresholds
      if (s.api <= 50) return { level: "go", text: T.airGood(s.api, u) };
      if (s.api <= 100) return { level: "go", text: T.airMod(s.api, u) };
      if (s.api <= 150) return { level: "care", text: T.usSensitive(s.api, u) };
      if (s.api <= 200) return { level: "stop", text: T.airUnhealthy(s.api, u) };
      return { level: "stop", text: T.airVery(s.api, s.api > 300, u) };
    }
    const h = s.history || [];
    const rising = h.length >= 4 && h[h.length - 1] - h[h.length - 4] > 3;
    if (s.api <= 50) return { level: "go", text: T.airGood(s.api) };
    if (s.api <= 100) {
      if (s.api > 85 && rising) return { level: "care", text: T.airModRising(s.api) };
      return { level: "go", text: T.airMod(s.api) };
    }
    if (s.api <= 200) return { level: "stop", text: T.airUnhealthy(s.api) };
    return { level: "stop", text: T.airVery(s.api, s.api > 300) };
  }
  function weatherFactor(day, pi) {
    if (!day) return null;
    const w = weather(day[PERIOD_KEYS[pi]]);
    const when = T.whenNow[pi];
    if (w.kind === "storm") return { level: "stop", text: T.wxStorm(w.label, when) };
    if (w.kind === "rain") return { level: "care", text: T.wxRain(w.label, when) };
    if (w.kind === "haze" || w.kind === "cloud") return { level: "go", text: T.wxDry(w.label, when) };
    return { level: "go", text: T.wxClear(when) };
  }
  function heatFactor(day, pi) {
    if (!day || !Number.isFinite(day.max)) return null;
    if (pi === 1 && day.max >= 33) return { level: "care", text: T.heatPM(day.max) };
    if (day.max >= 35) return { level: "care", text: T.heatHot(day.max) };
    return { level: "go", text: T.heatOk(day.min, day.max) };
  }
  function nextDryWindow(days, startDay, startPeriod) {
    for (let d = startDay; d < Math.min(days.length, startDay + 3); d++) {
      for (let p = d === startDay ? startPeriod : 0; p < 3; p++) {
        if (!isDry(days[d][PERIOD_KEYS[p]])) continue;
        if (d === startDay && p === startPeriod) return null;
        const name = d === startDay ? T.dayToday : d === startDay + 1 ? T.dayTomorrow : weekday(days[d].date, "long");
        return T.windowLabel(name, T.periods[p]);
      }
    }
    return null;
  }
  function runCardIQ(s) {
    const w = currentWeather(s);
    const factors = [{ k: T.kAir, ...airFactor(s) }];
    if (w) {
      if (w.kind === "storm") factors.push({ k: T.kWeather, level: "stop", text: T.wxNowStorm });
      else if (w.kind === "rain") factors.push({ k: T.kWeather, level: "care", text: T.wxNowRain(w.label) });
      else if (w.kind === "snow") factors.push({ k: T.kWeather, level: "care", text: T.wxNowSnow });
      else factors.push({ k: T.kWeather, level: "go", text: T.wxNowOk(w.label) });
      if (Number.isFinite(w.tp)) {
        if (w.tp >= 32) factors.push({ k: T.kHeat, level: "care", text: T.heatNow(w.tp) });
        else if (w.tp <= 5) factors.push({ k: T.kHeat, level: "care", text: T.heatNowCold(w.tp) });
        else factors.push({ k: T.kHeat, level: "go", text: T.heatNowOk(w.tp) });
      }
    }
    return runCardHTML(factors, (airBad, level) => (airBad ? T.bestIndoorUS : level !== "go" ? T.bestLater : ""));
  }
  function runCardHTML(factors, bestFn) {
    const level = factors.reduce((m, f) => (LEVELS[f.level] > LEVELS[m] ? f.level : m), "go");
    const airBad = factors[0].level === "stop";
    const badge = level === "go" ? T.runGo : level === "care" ? T.runCare : T.runStop;
    const verdict = level === "go" ? T.verdictGo : level === "care" ? T.verdictCare : airBad ? T.verdictStopAir : T.verdictStop;
    const best = bestFn(airBad, level);
    return `<section class="card run" data-level="${level}">
      <h2 class="card-head">${ICON.run}${T.runningOutside}</h2>
      <div class="run-top"><span class="run-badge">${badge}</span><p class="run-verdict">${verdict}</p></div>
      <ul class="run-factors">${factors.map((f) =>
        `<li><span class="k">${f.k}</span><span class="v"><i style="background:${DOT[f.level]}"></i>${esc(f.text)}</span></li>`).join("")}</ul>
      <p class="run-best">${esc(best)}</p>
    </section>`;
  }
  // Best window in the next ~36 h: dry per MET, after sunrise or before sunset
  // (cooler), and the air was clean at that clock hour on the latest day we have.
  function bestWindow(s) {
    const fc = forecastFor(s);
    if (!fc) return null;
    const now = new Date(), ti = todayIndex(fc.days);
    const h = s.history || [];
    const base = new Date(s.readingTime || state.data.updated);
    const airAt = (t) => {                                   // same clock hour, most recent past day
      let ref = t.getTime();
      while (ref > base.getTime() + 30 * 6e4) ref -= 864e5;
      const ago = Math.round((base.getTime() - ref) / 36e5);
      return ago >= 0 && ago < h.length ? h[h.length - 1 - ago] : null;
    };
    const slots = [];
    for (let off = 0; off < 2; off++) {
      const day = fc.days[ti + off];
      if (!day) continue;
      const { rise, set } = sunTimes(new Date(now.getTime() + off * 864e5), s.lat, s.lon);
      slots.push({ kind: "m", off, from: new Date(rise.getTime() + 10 * 6e4), to: new Date(rise.getTime() + 85 * 6e4), dry: isDry(day.morning), rise, set });
      slots.push({ kind: "e", off, from: new Date(set.getTime() - 85 * 6e4), to: new Date(set.getTime() - 5 * 6e4), dry: isDry(day.afternoon) && isDry(day.night), rise, set });
    }
    const future = slots.filter((sl) => sl.to > now);
    future.forEach((sl) => { sl.air = airAt(sl.from); sl.est = sl.air ?? s.api; });
    const good = future.find((sl) => sl.dry && sl.est <= 100 && s.api <= 150);
    const today = slots[0];
    if (good) return { slot: good, today };
    const anyClean = future.some((sl) => sl.est <= 100 && s.api <= 150);
    return { none: anyClean ? T.noWindowWet : T.noWindowAir, today };
  }
  function bestWindowHTML(s) {
    if (isIQ(s)) return "";
    const b = bestWindow(s);
    if (!b) return "";
    const sun = b.today ? `<p class="bw-sun">${T.sunrise} ${fmtTime(b.today.rise)} · ${T.sunset} ${fmtTime(b.today.set)}</p>` : "";
    if (b.none) return `<div class="bw"><p class="bw-head">${T.bestTimeHead}</p><p class="bw-none">${esc(b.none)}</p>${sun}</div>`;
    const sl = b.slot;
    const why = [T.whyDry, T.whyCool, sl.air != null ? T.whyAirYest(sl.air, T.api) : T.whyAirNow(s.api, T.api)];
    return `<div class="bw"><p class="bw-head">${T.bestTimeHead}</p>
      <p class="bw-pick">${esc(T.bestPick(sl.kind === "m" ? T.slotMorning : T.slotEvening, sl.off ? T.slotTomorrow : T.slotToday, fmtTime(sl.from), fmtTime(sl.to)))}</p>
      <p class="bw-why">${why.map((w) => `<span>${esc(w)}</span>`).join("")}</p>${sun}
      <p class="bw-note">${T.bestNote}</p></div>`;
  }

  function runCard(s) {
    if (isIQ(s)) return runCardIQ(s);
    const fc = forecastFor(s);
    const ti = fc ? todayIndex(fc.days) : -1;
    const day = fc ? fc.days[ti] : null;
    const pi = periodIndexNow();
    const wf = weatherFactor(day, pi), hf = heatFactor(day, pi);
    const factors = [{ k: T.kAir, ...airFactor(s) }, wf && { k: T.kWeather, ...wf }, hf && { k: T.kHeat, ...hf }].filter(Boolean);
    const level = factors.reduce((m, f) => (LEVELS[f.level] > LEVELS[m] ? f.level : m), "go");
    const airBad = factors[0].level === "stop";
    const badge = level === "go" ? T.runGo : level === "care" ? T.runCare : T.runStop;
    const verdict = level === "go" ? T.verdictGo : level === "care" ? T.verdictCare : airBad ? T.verdictStopAir : T.verdictStop;
    let best = "";
    if (airBad) best = T.bestIndoor;
    else if (fc && level !== "go") { const w = nextDryWindow(fc.days, ti, pi); if (w) best = T.bestWindow(w); }
    else if (!fc) best = T.bestNoFc;
    return `<section class="card run" data-level="${level}">
      <h2 class="card-head">${ICON.run}${T.runningOutside}</h2>
      <div class="run-top"><span class="run-badge">${badge}</span><p class="run-verdict">${verdict}</p></div>
      <ul class="run-factors">${factors.map((f) =>
        `<li><span class="k">${f.k}</span><span class="v"><i style="background:${DOT[f.level]}"></i>${esc(f.text)}</span></li>`).join("")}</ul>
      <p class="run-best">${esc(best)}</p>
      ${bestWindowHTML(s)}
    </section>`;
  }

  /* ---------- page sections ---------- */
  function adviceCard(band) {
    const bt = bandText(band);
    return `<section class="card">
      <h2 class="card-head">${ICON.advice}${T.healthAdvice}</h2>
      <div class="advice-row">
        <span class="advice-sign" style="background:${band.color}" aria-hidden="true">${band.sign}</span>
        <p class="advice-text"><b>${bt.title}</b>${bt.advice}</p>
      </div>
      ${scaleHTML(band)}
    </section>`;
  }
  const TODO_KEY = { good: "good", moderate: "moderate", usg: "unhealthy", unhealthy: "unhealthy", very: "very", hazard: "hazard", hazardous: "hazard" };
  function dailyMax(id) {
    const rows = state.hist?.stations?.[id] || [];
    const days = new Map();
    for (const [hour, v] of rows) { const d = hour.slice(0, 10); days.set(d, Math.max(days.get(d) ?? 0, v)); }
    return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  function schoolStatus(s) {
    if (s.api > 180) return { met: true, text: T.schoolNow };
    const days = dailyMax(s.id);
    const last3 = days.slice(-3);
    if (last3.length === 3 && last3.every(([, v]) => v > 150)) return { met: true, text: T.school3 };
    return { met: false, text: T.schoolNo };
  }
  function todoCard(s, band) {
    const tips = T.todo[TODO_KEY[band.key]] || [];
    const school = !isIQ(s) ? schoolStatus(s) : null;
    return `<section class="card">
      <h2 class="card-head">${ICON.check}${T.whatToDo}</h2>
      <ul class="todo">${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      ${school ? `<div class="school${school.met ? " met" : ""}"><p>${esc(school.text)}</p><p class="small">${T.schoolRule}</p><p class="small">${T.childcare}</p></div>` : ""}
    </section>`;
  }

  // One plain sentence comparing today with the days before it
  function weekSentence(days) {
    if (days.length < 3) return "";
    const [, today] = days[days.length - 1];
    const prev = days.slice(0, -1);
    const n = days.length;
    if (prev.every(([, v]) => today > v)) return T.weekWorstAll(n);
    if (prev.every(([, v]) => today < v)) return T.weekBestAll(n);
    // Latest earlier day that was at least as bad as today
    for (let k = prev.length - 1; k >= 0; k--) {
      if (prev[k][1] >= today) {
        if (k < prev.length - 1) return T.weekWorstSince(weekday(prev[k][0], "long"));
        break;                                  // yesterday was as bad, so "since" says nothing
      }
    }
    const peak = prev.reduce((a, b) => (b[1] > a[1] ? b : a));
    return T.weekPeak(peak[1], weekday(peak[0], "long"));
  }

  // ---- 7-day chart (DOE) ----
  function weekCard(s) {
    if (isIQ(s) || !state.hist) return "";
    const days = dailyMax(s.id).slice(-7);
    if (!days.length) return "";
    const max = Math.max(200, ...days.map(([, v]) => v));
    const cols = days.map(([d, v], i) => {
      // Short weekday for every column (fits 7 across at any text size); today is bold
      const label = weekday(d, "short"), isToday = i === days.length - 1;
      return `<div class="wk${isToday ? " today" : ""}"><span class="v">${v}</span>
        <span class="bar" aria-hidden="true"><i style="height:${Math.max(6, (v / max) * 100).toFixed(0)}%;background:${bandFor(v).color}"></i></span>
        <span class="t">${esc(label)}</span></div>`;
    }).join("");
    const line = weekSentence(days);
    return `<section class="card"><h2 class="card-head">${ICON.cal}${T.weekHead}</h2>
      ${line ? `<p class="week-line">${esc(line)}</p>` : ""}
      <div class="week" role="img" aria-label="${esc(days.map(([d, v]) => `${weekday(d, "long")} ${v}`).join(", "))}">${cols}</div>
      ${days.length < 7 ? `<p class="small">${T.weekNote}</p>` : ""}</section>`;
  }

  // ---- your places at a glance (page 1) ----
  let renderList_ = [];
  function glanceHTML() {
    const others = renderList_.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === "saved" && e.s);
    if (!others.length) return "";
    return `<div class="glance" aria-label="${T.yourPlaces}">${others.map(({ e, i }) => {
      const b = bandOf(e.s);
      return `<button type="button" class="gl" data-goto="${i}"><i style="background:${b.color}"></i><span>${esc(e.s.name)}</span><b>${e.s.api}</b></button>`;
    }).join("")}</div>`;
  }

  function scaleHTML(band) {
    const set = band.us ? US_BANDS : BANDS, ranges = band.us ? US_RANGES : RANGES;
    const labels = band.us ? T.usBands : T.bands;
    return `<div class="scale" style="--n:${set.length}" role="img" aria-label="${esc(band.us ? T.usAqi : T.mapLegend)}">${set.map((b, i) =>
      `<div class="${b === band ? "on" : ""}"><i style="background:${b.color}"></i>${(band.us && T.usShort[b.key]) || labels[b.key].label}<br>${ranges[i]}</div>`).join("")}</div>
      ${band.us ? `<p class="small scale-note">${T.scaleNote}</p>` : ""}`;
  }

  function hoursCard(s) {
    const h = (s.history || []).slice(-24);
    if (!h.length) return "";
    const base = new Date(s.readingTime || state.data.updated);
    const max = Math.max(200, ...h);
    const cells = h.map((v, i) => {
      const t = new Date(base.getTime() - (h.length - 1 - i) * 3600000);
      const now = i === h.length - 1;
      const label = now ? T.now : isNaN(t) ? "" : String(t.getHours()).padStart(2, "0");
      return `<div class="hr${now ? " now" : ""}"><span class="t">${label}</span>
        <span class="bar" aria-hidden="true"><i style="height:${Math.max(6, (v / max) * 100).toFixed(0)}%;background:${bandFor(v).color}"></i></span>
        <span class="v">${v}</span></div>`;
    }).join("");
    const note = h.length < 24 ? `<p class="small">${T.historyNote(h.length)}</p>` : "";
    return `<section class="card"><h2 class="card-head">${ICON.clock}${T.hourly(h.length)}</h2>
      <div class="hours" data-scroll-end>${cells}</div>${note}</section>`;
  }

  function bestRunSlot(day) {
    const dry = PERIOD_KEYS.map((k, i) => (isDry(day[k]) ? T.periods[i] : null)).filter(Boolean);
    if (!dry.length) return T.wetAllDay;
    if (dry.length === 3) return T.dryAllDay;
    return T.dryParts(dry);
  }

  function forecastCard(s) {
    const fc = forecastFor(s);
    if (!fc) return "";
    const ti = todayIndex(fc.days);
    const days = fc.days.slice(ti, ti + 7);
    const lo = Math.min(...days.map((d) => d.min)), hi = Math.max(...days.map((d) => d.max));
    const span = Math.max(1, hi - lo);
    const rows = days.map((d, i) => {
      const w = weather(d.summary);
      const name = i === 0 ? T.today : weekday(d.date, "short");
      const when = w.kind !== "clear" ? T.whenShort[String(d.summary_when || "").toLowerCase()] || "" : "";
      const left = ((d.min - lo) / span) * 100, width = Math.max(8, ((d.max - d.min) / span) * 100);
      return `<li>
        <span class="day">${esc(name)}</span>
        <span class="ic" title="${esc(d.summary)}">${WX[w.kind]}${when ? `<span>${when}</span>` : ""}</span>
        <span class="lo">${d.min}°</span>
        <span class="range" aria-hidden="true"><i style="left:${left.toFixed(0)}%;width:${Math.min(100 - left, width).toFixed(0)}%"></i></span>
        <span class="hi">${d.max}°</span>
        <span class="note">${esc(w.label)} · ${esc(bestRunSlot(d))}</span>
      </li>`;
    }).join("");
    return `<section class="card"><h2 class="card-head">${ICON.cal}${T.forecastHead(days.length)}</h2>
      <ul class="fc">${rows}</ul><p class="small fc-src">${esc(T.forecastSource(fc.location))}</p></section>`;
  }

  function tilesIQ(s) {
    const w = s.weather || {}, pn = T.pollutantNotes;
    const wind = Number.isFinite(w.ws) ? `${Math.round(w.ws * 3.6)} km/h` : "--";
    return `<div class="grid2">
      <section class="card"><h2 class="card-head">${ICON.pol}${T.mainPollutant}</h2>
        <p class="big">${esc(s.pollutant || "--")}</p><p class="small">${esc(pn[s.pollutant] || pn.fallback)}</p></section>
      <section class="card"><h2 class="card-head">${ICON.clock}${T.weatherNow}</h2>
        <p class="big">${Number.isFinite(w.tp) ? `${w.tp}°` : "--"}</p>
        <p class="small">${T.humidity} ${Number.isFinite(w.hu) ? `${w.hu}%` : "--"} · ${T.wind} ${wind}</p></section>
    </div>`;
  }
  function tiles(s) {
    if (isIQ(s)) return tilesIQ(s);
    const h = s.history || [];
    let trend = "--", tnote = T.notEnough;
    if (h.length >= 4) {
      const diff = h[h.length - 1] - h[h.length - 4];
      trend = diff > 3 ? T.rising : diff < -3 ? T.falling : T.steady;
      tnote = T.trendNote(diff);
    }
    const pn = T.pollutantNotes;
    return `<div class="grid2">
      <section class="card"><h2 class="card-head">${ICON.pol}${T.mainPollutant}</h2>
        <p class="big">${esc(s.pollutant || "--")}</p><p class="small">${esc(pn[s.pollutant] || pn.fallback)}</p></section>
      <section class="card"><h2 class="card-head">${ICON.trend}${T.trend}</h2>
        <p class="big">${trend}</p><p class="small">${esc(tnote)}</p></section>
    </div>`;
  }

  function langSwitch() {
    return `<div class="seg" role="group" aria-label="${T.language}">
      <button type="button" data-lang="en" aria-pressed="${state.lang === "en"}">EN</button>
      <button type="button" data-lang="ms" aria-pressed="${state.lang === "ms"}">BM</button>
    </div>`;
  }

  function footer(s) {
    const src = isIQ(s)
      ? `<p>${T.srcIQ}</p>
      <p>${T.poweredBy} <a href="https://www.iqair.com/" target="_blank" rel="noopener">IQAir</a></p>`
      : `<p>${state.data?.sample ? T.srcSample : T.srcLive}</p>
      <p>${T.srcForecast}</p>
      <p>${T.srcOfficial} <a href="https://eqms.doe.gov.my/APIMS/main" target="_blank" rel="noopener">eqms.doe.gov.my</a></p>`;
    return `<footer class="foot">
      ${langSwitch()}
      <p class="checked">${checkedText()}</p>
      ${src}
      <p class="privacy">${T.privacy}</p>
      <p class="credit">${T.developedBy} <b>manwest</b></p>
    </footer>`;
  }

  function checkedText() {
    return state.checkedAt ? esc(T.checkedAt(fmtLocalTime(state.checkedAt))) : "";
  }
  // Update the "Last checked" lines in place (pages are not rebuilt when nothing changed)
  function paintChecked() {
    const t = checkedText();
    document.querySelectorAll(".foot .checked").forEach((el) => { el.innerHTML = t; });
  }

  function hiLo(s) {
    const h = (s.history || []).slice(-24);
    return h.length > 1 ? `H:${Math.max(...h)}  L:${Math.min(...h)}` : "";
  }

  // Weather right now at a station, from MET's forecast for this part of the day
  // IQAir icon codes (OpenWeather style): 01 clear, 02 few clouds, 03/04 clouds,
  // 09 showers, 10 rain, 11 thunderstorm, 13 snow, 50 mist; "n" = night there
  const IC_KIND = { "01": "clear", "02": "cloud", "03": "cloud", "04": "cloud", "09": "rain", "10": "rain", "11": "storm", "13": "snow", "50": "haze" };
  const nightAt = (s) => (isIQ(s) && s.weather && s.weather.ic ? /n$/.test(s.weather.ic) : isNight());
  function currentWeather(s) {
    if (isIQ(s)) {
      const w = s.weather || {}, code = String(w.ic || "").slice(0, 2);
      const kind = IC_KIND[code];
      return kind ? { kind, label: T.icLabels[code] || "", tp: w.tp } : null;
    }
    const fc = forecastFor(s);
    if (!fc) return null;
    const day = fc.days[todayIndex(fc.days)];
    if (!day) return null;
    const raw = day[PERIOD_KEYS[periodIndexNow()]] || day.summary;
    return { ...weather(raw), min: day.min, max: day.max };
  }
  const hazeLevel = (api) => (api > 100 ? 2 : api > 50 ? 1 : 0);
  function fxFor(s, seed) {
    const w = s ? currentWeather(s) : null;
    return window.JerebuFX ? JerebuFX.markup(w ? w.kind : "none", s ? nightAt(s) : isNight(), s ? hazeLevel(s.api) : 0, seed) : "";
  }
  function heroWeather(s) {
    const w = currentWeather(s);
    if (!w) return "";
    const temp = Number.isFinite(w.tp) ? ` · ${w.tp}°` : Number.isFinite(w.min) && Number.isFinite(w.max) ? ` · ${w.min}°–${w.max}°` : "";
    const icon = w.kind === "clear" && nightAt(s) ? WX.moon : (WX[w.kind] || WX.cloud);
    return `<p class="hero-wx"><span class="wx-ic" aria-hidden="true">${icon}</span>${esc(w.label)}${temp}</p>`;
  }
  function iqErrorText(code) {
    if (/limit|too_many/.test(code)) return T.iqErr.limit;
    if (/no_nearest|not_found|no_data/.test(code)) return T.iqErr.none;
    if (/network|http_5/.test(code)) return T.iqErr.network;
    return T.iqErr.off;
  }

  function pageHTML(e, i) {
    const night = (e.s ? nightAt(e.s) : isNight()) ? " night" : "";
    const tag = e.kind === "me" ? `<p class="hero-tag">${ARROW}${T.myLocation}</p>` : `<p class="hero-tag">&nbsp;</p>`;
    if (e.world && !e.s) {
      const msg = e.iqRes && e.iqRes.error ? iqErrorText(e.iqRes.error) : T.iqLoading;
      const retry = e.iqRes && e.iqRes.error ? `<button class="pill" type="button" data-retry="${esc(e.id)}">${T.tryAgain}</button>` : "";
      return `<section class="slide sky sky-none${night}" data-index="${i}" data-band="none" aria-label="${esc(e.place.name)}">
        ${fxFor(null, e.id)}<div class="page"><div class="page-inner">
          <header class="hero">${tag}<p class="hero-name">${esc(e.place.name)}</p><p class="hero-api">--</p>
            <p class="hero-meta">${esc([e.place.admin, e.place.country].filter(Boolean).join(", "))}</p></header>
          <section class="card empty"><p>${msg}</p>${retry}</section>
          ${footer({ source: "iqair" })}
        </div></div></section>`;
    }
    if (!e.s) {
      return `<section class="slide sky sky-none${night}" data-index="${i}" data-band="none" aria-label="${T.myLocation}">
        ${fxFor(null, "me")}<div class="page"><div class="page-inner">
          <header class="hero">${tag}<p class="hero-name">${state.locating ? T.locating : T.locationOff}</p><p class="hero-api">--</p></header>
          <section class="card empty"><p>${state.locating ? T.findingNearest : T.locationOffMsg}</p>
            ${state.locating ? "" : `<button class="pill" type="button" data-action="locate">${T.tryAgain}</button>`}</section>
          ${footer()}
        </div></div></section>`;
    }
    const s = e.s, band = bandOf(s), sky = skyOf(band);
    const other = otherBandLabel(band);
    const near = e.kind === "me" && e.d != null ? (isIQ(s) ? T.nearestCity(fmtKm(e.d)) : T.nearestStation(fmtKm(e.d))) : "";
    const meta = [e.kind === "me" ? near : s.state, timeAgo(s.readingTime || state.data.updated),
      e.iqRes && e.iqRes.stale ? T.iqStale : ""].filter(Boolean).join(" · ");
    return `<section class="slide sky sky-${sky}${night}" data-index="${i}" data-band="${sky}" aria-label="${esc(s.name)}">
      ${fxFor(s, s.id || e.id || s.name)}<div class="ptr" aria-hidden="true"><i></i></div><div class="page"><div class="page-inner">
        <header class="hero">
          ${tag}
          <p class="hero-name">${esc(s.name)}</p>
          <p class="hero-api" aria-hidden="true">${s.api}<small>${unitOf(s)}</small></p>
          <p class="sr">${esc(T.srReading(s.api, unitOf(s), bandText(band).label))}</p>
          <p class="hero-cat">${bandText(band).label} · <span class="alt">${other}</span></p>
          ${heroWeather(s)}
          <p class="hero-hl">${hiLo(s)}</p>
          <p class="hero-meta">${esc(meta)}</p>
          <button class="share-btn" type="button" data-share="${i}">${ICON.share}${T.share}</button>
        </header>
        ${e.kind === "me" ? glanceHTML() : ""}
        ${adviceCard(band)}
        ${todoCard(s, band)}
        ${runCard(s)}
        ${hoursCard(s)}
        ${weekCard(s)}
        ${forecastCard(s)}
        ${tiles(s)}
        ${footer(s)}
      </div></div>
    </section>`;
  }

  /* ---------- render ---------- */
  let lastPagesKey = "";
  function render(force) {
    const list = entries();
    state.page = Math.max(0, Math.min(state.page, list.length - 1));
    // Skip rebuilding pages when nothing visible changed (keeps scroll smooth).
    const key = JSON.stringify([state.dataStamp, state.iqStamp, state.lang, state.locating, list.map((e) => [e.kind, e.s?.id, e.d && Math.round(e.d * 10)]), isNight()]);
    const pager = $("pager");
    if (force || key !== lastPagesKey) {
      lastPagesKey = key;
      const keep = [...pager.querySelectorAll(".page")].map((p) => p.scrollTop);
      renderList_ = list;
      pager.innerHTML = list.map(pageHTML).join("");
      const pages = pager.querySelectorAll(".page");
      pages.forEach((p, i) => { if (keep[i]) p.scrollTop = keep[i]; });
      pager.querySelectorAll("[data-scroll-end]").forEach((el) => { el.scrollLeft = el.scrollWidth; });
      pager.scrollLeft = state.page * pager.clientWidth;
    }
    requestAnimationFrame(markDot);
    $("dots").innerHTML = list.map((e, i) =>
      `<button class="dot-btn" type="button" role="tab" data-goto="${i}" aria-selected="${i === state.page}"
        aria-label="${esc(e.kind === "me" ? T.myLocation : e.s?.name || e.place?.name || "")}">${e.kind === "me" ? ARROW : "<i></i>"}</button>`).join("");
    renderList(list);
    renderChrome();
  }

  // Static labels outside the pages
  function renderChrome() {
    document.documentElement.lang = state.lang === "ms" ? "ms" : "en";
    $("mapBtn").setAttribute("aria-label", T.openMap);
    $("listBtn").setAttribute("aria-label", T.allLocations);
    $("dots").setAttribute("aria-label", T.pages);
    $("searchLabel").textContent = T.searchPlaceholder;
    $("search").placeholder = T.searchPlaceholder;
    $("sheetTitle").textContent = T.addLocation;
    $("sheetCancel").textContent = T.cancel;
    $("listSource").textContent = state.data?.sample ? T.srcSample : T.listSource;
    $("listCredit").innerHTML = `${T.developedBy} <b>manwest</b>`;
    $("listLang").innerHTML = langSwitch();
    $("installBtn").setAttribute("aria-label", T.installBtn);
    $("installBtn").title = T.installBtn;
  }

  function renderList(list = entries()) {
    $("editBtn").textContent = state.editing ? T.done : T.edit;
    $("locCards").innerHTML = list.map((e, i) => {
      const s = e.s, night = (s ? nightAt(s) : isNight()) ? " night" : "";
      const band = s ? bandOf(s) : null;
      const sky = band ? `sky-${skyOf(band)}` : "sky-none";
      const where = s ? s.state : e.place ? [e.place.admin, e.place.country].filter(Boolean).join(", ") : "";
      const tagIQ = s && isIQ(s) ? ` · ${T.usAqi}` : "";
      const sub = e.kind === "me" ? `${ARROW}${T.myLocation}${where ? ` · ${esc(where)}` : ""}` : esc(where) + tagIQ;
      const name = e.kind === "me" ? (s ? s.name : state.locating ? T.locating : T.locationOff) : (s ? s.name : e.place.name);
      const remove = state.editing && e.kind === "saved"
        ? `<button class="remove-btn" type="button" data-remove="${esc(e.id)}" aria-label="${esc(T.remove(name))}"><svg viewBox="0 0 14 14"><path d="M3 7h8"/></svg></button>` : "";
      const swipe = e.kind === "saved" && !state.editing;
      const del = swipe ? `<button class="swipe-del" type="button" data-remove="${esc(e.id)}" tabindex="-1" aria-label="${esc(T.remove(name))}"><span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7M10 10.5v6M14 10.5v6"/></svg>${T.delete}</span></button>` : "";
      return `<li class="loc-card${swipe ? " swipeable" : ""}" data-id="${esc(e.id || "")}">${remove}${del}
        <button class="loc-open sky ${sky}${night}" type="button" data-open="${i}">
          <span class="nm">${esc(name)}</span><span class="sub">${sub}</span>
          <span class="val">${s ? s.api : "--"}</span>
          <span class="cat">${band ? bandText(band).label : ""}</span>
          <span class="hl">${s ? hiLo(s) : ""}</span>
        </button></li>`;
    }).join("");
  }

  let worldSeq = 0, worldTimer = 0, worldResults = [];
  function renderSearch(q) {
    renderDoeSearch(q);
    clearTimeout(worldTimer);
    const needle = (q || "").trim();
    const box = $("worldList");
    if (!IQ.enabled || needle.length < 2) { box.innerHTML = ""; worldResults = []; return; }
    box.innerHTML = `<li class="sec">${T.worldSection}</li><li><p class="small pad">${T.searching}</p></li>`;
    const seq = ++worldSeq;
    worldTimer = setTimeout(async () => {
      let res;
      try { res = await IQ.search(needle, state.lang); } catch { res = null; }
      if (seq !== worldSeq) return;                         // a newer search is running
      worldResults = res || [];
      box.innerHTML = `<li class="sec">${T.worldSection}</li>` + (res == null ? `<li><p class="small pad">${T.worldFail}</p></li>`
        : !res.length ? `<li><p class="small pad">${T.worldNone}</p></li>`
        : res.map((r, i) => {
          const id = "w:" + IQ.cell(r.lat, r.lon);
          const added = state.saved.includes(id) ? `<span class="added">${T.added}</span>` : "";
          const d = state.coords ? ` · ${fmtKm(km(state.coords, r))}` : "";
          return `<li><button class="row" type="button" data-add-world="${i}">
            <span class="dot globe" aria-hidden="true"></span>
            <span class="txt"><span class="nm">${esc(r.name)}${added}</span><span class="st">${esc([r.admin, r.country].filter(Boolean).join(", "))}${d}</span></span>
            <span class="val src">IQAir</span></button></li>`;
        }).join(""));
    }, 350);
  }
  function renderDoeSearch(q) {
    const needle = (q || "").trim().toLowerCase();
    const list = stations()
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.state.toLowerCase().includes(needle))
      .map((s) => ({ s, d: state.coords ? km(state.coords, s) : null }))
      .sort((a, b) => (a.d != null && b.d != null ? a.d - b.d : a.s.state.localeCompare(b.s.state) || a.s.name.localeCompare(b.s.name)));
    const head = IQ.enabled ? `<li class="sec">${T.doeSection}</li>` : "";
    $("allList").innerHTML = head + (list.length ? list.map(({ s, d }) => {
      const b = bandFor(s.api);
      const added = state.saved.includes(s.id) ? `<span class="added">${T.added}</span>` : "";
      return `<li><button class="row" type="button" data-add="${esc(s.id)}">
        <span class="dot" style="background:${b.color}"></span>
        <span class="txt"><span class="nm">${esc(s.name)}${added}</span><span class="st">${esc(s.state)}${d != null ? ` · ${fmtKm(d)}` : ""} · ${bandText(b).label}</span></span>
        <span class="val">${s.api}</span></button></li>`;
    }).join("") : `<li><p class="small pad">${T.noMatch}</p></li>`);
  }

  /* ---------- views (transform/opacity transitions only) ---------- */
  function setView(el, open) {
    el.classList.toggle("open", open);
    el.toggleAttribute("inert", !open);
    el.setAttribute("aria-hidden", String(!open));
  }
  function goTo(i, smooth) {
    const pager = $("pager");
    state.page = i;
    store.set(PAGE_KEY, i);
    pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth && !reduceMotion() ? "smooth" : "auto" });
    markDot();
  }
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SKY_BOTTOM = { good: "#1e4c8c", moderate: "#22544b", unhealthy: "#46402a", very: "#4a2f22", hazard: "#3a1b1a", purple: "#331f3f", maroon: "#2e141a", none: "#222a36" };
  function mixHex(a, b, t) {
    const p = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
    const A = p(a), B = p(b);
    return "#" + A.map((v, k) => Math.round(v + (B[k] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  function markDot() {
    document.querySelectorAll(".dot-btn").forEach((d, i) => d.setAttribute("aria-selected", String(i === state.page)));
    const slides = $("pager").querySelectorAll(".slide");
    slides.forEach((sl, i) => sl.classList.toggle("active", i === state.page));
    const cur = slides[state.page];
    window.JerebuFX?.activate(cur && !document.body.classList.contains("list-open") && !document.body.classList.contains("map-open") ? cur : null);
    // Paint the area behind the app in the page's colour so any edge iOS
    // leaves uncovered blends in.
    const base = SKY_BOTTOM[cur?.dataset.band || "none"] || SKY_BOTTOM.none;
    const col = cur?.classList.contains("night") ? mixHex(base, "#070b14", 0.4) : base;
    if (!document.body.classList.contains("list-open")) {
      document.documentElement.style.backgroundColor = col;
      document.body.style.backgroundColor = col;
    }
  }
  function showList(show) {
    if (!show) state.editing = false;
    openRow = null;
    renderList();
    document.body.classList.toggle("list-open", show);
    setView($("listView"), show);
    if (show) {
      window.JerebuFX?.pause();
      document.documentElement.style.backgroundColor = ""; document.body.style.backgroundColor = "";
    } else { window.JerebuFX?.resume(); markDot(); }
  }
  const sheet = $("sheet");
  function openSheet() {
    renderSearch($("search").value = "");
    setView(sheet, true);
    setTimeout(() => $("search").focus({ preventScroll: true }), 320);
  }
  function closeSheet() { $("search").blur(); setView(sheet, false); }

  function openStation(id) {
    const n = state.coords ? nearest(state.coords) : null;
    if (n && n.s.id === id) { showList(false); return goTo(0, false); }
    addStation(id);
  }
  function addStation(id) {
    if (!state.saved.includes(id)) { state.saved.push(id); store.set(SAVED_KEY, state.saved); }
    closeSheet();
    showList(false);
    render();
    const idx = entries().findIndex((e) => e.kind === "saved" && e.id === id);
    goTo(idx >= 0 ? idx : 0, false);
  }
  function removeStation(id) {
    state.saved = state.saved.filter((x) => x !== id);
    store.set(SAVED_KEY, state.saved);
    if (isWorldId(id)) { delete state.places[id]; delete state.iq[id]; store.set(PLACES_KEY, state.places); }
    render();
  }
  function addWorld(r) {
    const id = "w:" + IQ.cell(r.lat, r.lon);
    if (!state.places[id]) { state.places[id] = { name: r.name, admin: r.admin, country: r.country, lat: r.lat, lon: r.lon }; store.set(PLACES_KEY, state.places); }
    addStation(id);
    if (!(state.iq[id] && state.iq[id].station)) loadWorld(id);
  }
  async function loadWorld(id) {
    const p = state.places[id];
    if (!p) return;
    if (state.iq[id] && state.iq[id].error && !state.iq[id].station) { delete state.iq[id]; state.iqStamp++; render(); }
    const snap = snapshotNear(p.lat, p.lon);
    const res = snap ? { station: snap, cached: true } : await IQ.nearest(p.lat, p.lon);
    if (!state.places[id]) return;                          // removed while loading
    state.iq[id] = res; state.iqStamp++;
    render();
  }
  async function loadAllWorld() {
    if (!IQ.enabled) return;
    for (const id of state.saved.filter(isWorldId)) await loadWorld(id);   // one at a time (rate limit)
  }
  async function loadMeIQ() {
    if (!IQ.enabled || !state.coords) return;
    const n = nearest(state.coords);
    if (n && n.d <= DOE_FAR_KM) { if (state.iqMe) { state.iqMe = null; state.iqStamp++; render(); } return; }
    const snap = snapshotNear(state.coords.lat, state.coords.lon);
    const res = snap ? { station: snap, cached: true } : await IQ.nearest(state.coords.lat, state.coords.lon);
    state.iqMe = res && res.station ? res : null; state.iqStamp++;
    render();
  }
  function setLang(lang) {
    if (!I18N[lang] || lang === state.lang) return;
    state.lang = lang; T = I18N[lang];
    store.set(LANG_KEY, lang);
    render(true);
    if ($("installSheet").classList.contains("open")) renderInstall();
    syncAlertsBtn(); syncAlertsLang();
    if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext());
  }

  /* ---------- map (lazy) ---------- */
  function mapContext() {
    return {
      t: T, lang: state.lang, bands: BANDS, bandFor,
      bandLabel: (b) => T.bands[b.key].label,
      stations: stations(), updated: state.data?.updated,
      world: worldForMap(), usBandFor, usLabel: (b) => T.usBands[b.key].label,
      fires: state.fires,
      coords: state.coords,
      onOpen: (id) => { closeMap(); openStation(id); },
      onOpenWorld: (p) => { closeMap(); openWorld(p); },
      onClose: () => closeMap()
    };
  }
  // IQAir places for the map: snapshot cities + saved world places + My Location
  function worldForMap() {
    const out = [], seen = [];
    const add = (s) => {
      if (!s || !Number.isFinite(s.api)) return;
      if (seen.some((q) => km(q, s) < 5)) return;            // same city twice
      seen.push(s); out.push(s);
    };
    state.world.forEach(add);
    Object.values(state.iq).forEach((r) => add(r && r.station));
    add(state.iqMe && state.iqMe.station);
    return out;
  }
  function openWorld(s) {
    const id = "w:" + IQ.cell(s.lat, s.lon);
    if (state.saved.includes(id)) { showList(false); return goTo(entries().findIndex((e) => e.id === id), false); }
    state.iq[id] = { station: s, cached: true };
    addWorld({ name: s.name, admin: (s.state || "").split(", ")[0] === s.country ? "" : (s.state || "").split(", ")[0], country: s.country, lat: s.lat, lon: s.lon });
  }
  let mapScript;
  function loadMapModule() {
    if (window.JerebuMap) return Promise.resolve();
    if (!mapScript) mapScript = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "map.js?v=8"; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return mapScript;
  }
  async function openMap() {
    const view = $("mapView");
    document.body.classList.add("map-open");
    setView(view, true);
    window.JerebuFX?.pause();
    try {
      await loadMapModule();
      await window.JerebuMap.open(view, mapContext());
    } catch {
      view.querySelector(".map-status").textContent = T.mapError;
    }
  }
  function closeMap() {
    document.body.classList.remove("map-open");
    setView($("mapView"), false);
    window.JerebuFX?.resume(); markDot();
    window.JerebuMap?.close();
  }

  /* ---------- Haze alerts (Web Push via the Cloudflare Worker) ---------- */
  const ALERTS_URL = ((window.JEREBU_CONFIG && window.JEREBU_CONFIG.alertsUrl) || "").replace(/\/$/, "");
  const ALERTS_KEY = "jerebunow.alerts";
  const ALERT_RULES = [["above100", "ruleAbove100"], ["above200", "ruleAbove200"], ["runOk", "ruleRunOk"], ["school", "ruleSchool"]];
  let alertsCfg = store.get(ALERTS_KEY, null);
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  function syncAlertsBtn() {
    const b = $("alertsBtn");
    b.hidden = !ALERTS_URL;
    b.setAttribute("aria-label", T.alerts);
    b.querySelector(".on-dot").hidden = !alertsCfg;
  }
  function alertPlaces() {
    const out = [];
    const n = state.coords ? nearest(state.coords) : null;
    if (n && n.d <= DOE_FAR_KM) out.push({ id: n.s.id, label: T.myLocationStation(n.s.name) });
    for (const id of state.saved) {
      const s = !isWorldId(id) && stationById(id);
      if (s && !out.some((o) => o.id === s.id)) out.push({ id: s.id, label: `${s.name} · ${s.state}` });
    }
    if (alertsCfg && !out.some((o) => o.id === alertsCfg.station)) {
      const s = stationById(alertsCfg.station);
      if (s) out.push({ id: s.id, label: `${s.name} · ${s.state}` });
    }
    return out;
  }
  function renderAlerts(msg) {
    $("alertsTitle").textContent = T.alertsTitle;
    $("alertsSub").textContent = T.alertsSub;
    $("alertsClose").textContent = T.done;
    $("alertsPlaceLabel").textContent = T.alertsPlace;
    $("alertsRulesLabel").textContent = T.alertsRules;
    $("alertsQuiet").textContent = T.alertsQuiet;
    const places = alertPlaces();
    const sel = alertsCfg ? alertsCfg.station : places[0]?.id;
    $("alertsPlaces").innerHTML = places.map((p) =>
      `<label class="opt"><input type="radio" name="alertPlace" value="${esc(p.id)}"${p.id === sel ? " checked" : ""}><span>${esc(p.label)}</span></label>`).join("")
      || `<p class="small">${T.locationOffMsg}</p>`;
    const rules = alertsCfg ? alertsCfg.rules : ["above100", "runOk"];
    $("alertsRules").innerHTML = ALERT_RULES.map(([k, t]) =>
      `<label class="opt"><input type="checkbox" name="alertRule" value="${k}"${rules.includes(k) ? " checked" : ""}><span>${T[t]}</span></label>`).join("");
    $("alertsGo").textContent = alertsCfg ? T.alertsSave : T.alertsOn;
    $("alertsOff").textContent = T.alertsOff;
    $("alertsOff").hidden = !alertsCfg;
    $("alertsGo").disabled = !places.length;
    $("alertsMsg").textContent = msg != null ? msg : alertsCfg ? T.alertsEnabled : "";
  }
  function openAlerts() {
    renderAlerts(!pushSupported() ? (isIOS() && !isStandalone() ? T.alertsNeedHome : T.alertsUnsupported) : null);
    setView($("alertsSheet"), true);
  }
  const closeAlerts = () => setView($("alertsSheet"), false);
  const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  async function saveAlerts(ev) {
    ev.preventDefault();
    if (!pushSupported()) return renderAlerts(isIOS() && !isStandalone() ? T.alertsNeedHome : T.alertsUnsupported);
    if (isIOS() && !isStandalone()) return renderAlerts(T.alertsNeedHome);
    const station = ($("alertsForm").querySelector("input[name=alertPlace]:checked") || {}).value;
    const rules = [...$("alertsForm").querySelectorAll("input[name=alertRule]:checked")].map((i) => i.value);
    if (!station || !rules.length) return;
    $("alertsGo").disabled = true;
    try {
      const perm = await Notification.requestPermission();      // must follow the tap directly
      if (perm !== "granted") return renderAlerts(T.alertsDenied);
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { publicKey } = await (await fetch(ALERTS_URL + "/vapid")).json();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
      }
      const res = await fetch(ALERTS_URL + "/subscribe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), station, rules, lang: state.lang, confirm: !alertsCfg })
      });
      if (!res.ok) throw new Error(res.status);
      alertsCfg = { station, rules, endpoint: sub.endpoint, lang: state.lang };
      store.set(ALERTS_KEY, alertsCfg);
      syncAlertsBtn();
      renderAlerts(T.alertsEnabled);
    } catch {
      renderAlerts(T.alertsFail);
    } finally { $("alertsGo").disabled = false; }
  }
  async function turnOffAlerts() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = (sub && sub.endpoint) || (alertsCfg && alertsCfg.endpoint);
      if (endpoint) await fetch(ALERTS_URL + "/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) }).catch(() => {});
      if (sub) await sub.unsubscribe().catch(() => {});
    } catch { /* still clear locally */ }
    alertsCfg = null; store.set(ALERTS_KEY, null);
    syncAlertsBtn(); renderAlerts(T.alertsDisabled);
  }
  // Keep the server's language in step with the app
  async function syncAlertsLang() {
    if (!alertsCfg || !ALERTS_URL || alertsCfg.lang === state.lang || !pushSupported()) return;
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (!sub) return;
      await fetch(ALERTS_URL + "/subscribe", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), station: alertsCfg.station, rules: alertsCfg.rules, lang: state.lang }) });
      alertsCfg.lang = state.lang; store.set(ALERTS_KEY, alertsCfg);
    } catch { /* next time */ }
  }

  /* ---------- Toast ---------- */
  let toastT;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove("show"), 2200);
  }

  /* ---------- Share a reading as an image ---------- */
  const SKY_TOP = { good: "#4d8fdc", moderate: "#5b9a86", unhealthy: "#8a7a4c", very: "#9a6a44", hazard: "#8c4640", purple: "#74508a", maroon: "#7a3a46", none: "#4f5c6e" };
  async function shareEntry(i) {
    const e = renderList_[i];
    if (!e || !e.s) return;
    const s = e.s, band = bandOf(s), sky = skyOf(band), label = bandText(band).label, unit = unitOf(s);
    const W = 1080, H = 1350, c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, SKY_TOP[sky] || SKY_TOP.none); grad.addColorStop(1, SKY_BOTTOM[sky] || SKY_BOTTOM.none);
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    const font = getComputedStyle(document.body).fontFamily;
    g.fillStyle = "#fff"; g.textAlign = "center";
    g.font = `600 44px ${font}`; g.globalAlpha = 0.8; g.fillText("JerebuNow", W / 2, 140); g.globalAlpha = 1;
    g.font = `500 84px ${font}`; g.fillText(s.name, W / 2, 330, W - 120);
    g.font = `200 340px ${font}`; g.fillText(String(s.api), W / 2, 680);
    g.font = `500 52px ${font}`; g.fillText(`${unit} · ${label}`, W / 2, 790, W - 120);
    g.font = `400 40px ${font}`; g.globalAlpha = 0.8;
    g.fillText(s.state || "", W / 2, 860, W - 120);
    const when = new Date(s.readingTime || state.data.updated);
    g.fillText(isNaN(when) ? "" : when.toLocaleString(T.locale, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }), W / 2, 920);
    g.font = `400 34px ${font}`; g.globalAlpha = 0.7;
    g.fillText(isIQ(s) ? "IQAir · US AQI" : "DOE Malaysia · APIMS", W / 2, H - 150);
    g.fillText(location.host + location.pathname.replace(/index\.html$/, ""), W / 2, H - 95);
    g.globalAlpha = 1;
    const text = T.shareText(s.name, s.api, unit, label);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const file = blob && new File([blob], "jerebunow.png", { type: "image/png" });
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text }); return; }
      if (navigator.share) { await navigator.share({ text, url: location.href }); return; }
    } catch (err) { if (err && err.name === "AbortError") return; }
    if (blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "jerebunow.png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(T.shareSaved);
    } else {
      try { await navigator.clipboard.writeText(text); toast(T.shareCopied); } catch {}
    }
  }

  /* ---------- Pull to refresh ---------- */
  let ptr = null;
  $("pager").addEventListener("touchstart", (e) => {
    const page = e.target.closest(".page");
    if (!page || page.scrollTop > 0 || e.touches.length !== 1) return;
    ptr = { page, y0: e.touches[0].clientY, x0: e.touches[0].clientX, d: 0, el: page.parentElement.querySelector(".ptr") };
  }, { passive: true });
  $("pager").addEventListener("touchmove", (e) => {
    if (!ptr) return;
    const dy = e.touches[0].clientY - ptr.y0, dx = Math.abs(e.touches[0].clientX - ptr.x0);
    if (dx > Math.abs(dy) || ptr.page.scrollTop > 0) { ptr.el && ptr.el.style.removeProperty("--pull"); ptr = null; return; }
    ptr.d = Math.max(0, dy);
    if (ptr.el) { ptr.el.style.setProperty("--pull", Math.min(1, ptr.d / 90).toFixed(3)); ptr.el.classList.toggle("ready", ptr.d > 90); }
  }, { passive: true });
  $("pager").addEventListener("touchend", async () => {
    if (!ptr) return;
    const { d, el } = ptr; ptr = null;
    if (!el) return;
    if (d > 90) {
      el.classList.add("spin");
      const res = await refresh();
      el.classList.remove("spin", "ready"); el.style.removeProperty("--pull");
      toast(res === "changed" ? T.refreshed : res === "same" ? `${T.upToDate} · ${T.checkedAt(fmtLocalTime(state.checkedAt))}` : T.loadError);
    } else { el.classList.remove("ready"); el.style.removeProperty("--pull"); }
  });

  /* ---------- Swipe left to delete (locations list) ---------- */
  const OPEN_X = -92;
  let sw = null, openRow = null, swipeEndedAt = 0;
  function closeRow(li) {
    if (!li) return;
    li.classList.remove("open");
    li.querySelector(".loc-open").style.transform = "";
    setTimeout(() => { if (!li.classList.contains("open")) li.classList.remove("swiping"); }, 320);
    if (openRow === li) openRow = null;
  }
  function animateRemove(li, id) {
    const card = li.querySelector(".loc-open");
    li.style.height = li.offsetHeight + "px";
    if (card) card.style.transform = `translateX(${-li.offsetWidth}px)`;
    requestAnimationFrame(() => { li.classList.add("removing"); li.style.height = "0px"; });
    setTimeout(() => removeStation(id), 300);
  }
  const cards = $("locCards");
  cards.addEventListener("pointerdown", (e) => {
    const li = e.target.closest(".loc-card.swipeable");
    if (openRow && openRow !== li) { closeRow(openRow); swipeEndedAt = Date.now(); }
    if (!li || e.target.closest(".swipe-del") || (e.pointerType === "mouse" && e.button !== 0)) return;
    sw = { li, card: li.querySelector(".loc-open"), id: e.pointerId, x0: e.clientX, y0: e.clientY,
      base: li.classList.contains("open") ? OPEN_X : 0, x: 0, lock: null };
  });
  cards.addEventListener("pointermove", (e) => {
    if (!sw || e.pointerId !== sw.id) return;
    const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
    if (!sw.lock) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        sw.lock = "x";
        sw.li.classList.add("swiping", "dragging");
        try { sw.card.setPointerCapture(e.pointerId); } catch {}
      } else if (Math.abs(dy) > 8) { sw = null; return; }
      else return;
    }
    let x = sw.base + dx;
    if (x > 0) x *= 0.25;                                   // resist dragging right
    sw.x = x;
    sw.card.style.transform = `translateX(${x}px)`;
  });
  function endSwipe(e) {
    if (!sw || e.pointerId !== sw.id) return;
    const { li, card, x, lock } = sw;
    sw = null;
    if (lock !== "x") return;
    swipeEndedAt = Date.now();
    li.classList.remove("dragging");
    if (x < -li.offsetWidth * 0.5) {                        // full swipe deletes
      animateRemove(li, li.dataset.id);
    } else if (x < OPEN_X / 2) {                           // reveal Delete
      li.classList.add("open");
      card.style.transform = `translateX(${OPEN_X}px)`;
      openRow = li;
    } else closeRow(li);
  }
  cards.addEventListener("pointerup", endSwipe);
  cards.addEventListener("pointercancel", endSwipe);
  $("listScroll").addEventListener("scroll", () => { if (openRow) closeRow(openRow); }, { passive: true });

  /* ---------- Add to Home Screen ---------- */
  let installPrompt = null;
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function syncInstallBtn() { $("installBtn").hidden = isStandalone(); }

  const isAndroid = () => /android/i.test(navigator.userAgent);
  const isSamsung = () => /SamsungBrowser/i.test(navigator.userAgent);
  let installOS = null;
  // The guide opens on the phone you're using; the switch shows the other one
  function renderInstall() {
    const os = installOS || (isIOS() ? "ios" : "android");
    $("installTitle").textContent = T.installTitle;
    $("installSub").textContent = T.installSub;
    const tabs = $("installTabs");
    tabs.setAttribute("aria-label", T.installTitle);
    tabs.querySelector('[data-os="ios"]').textContent = T.tabIphone;
    tabs.querySelector('[data-os="android"]').textContent = T.tabAndroid;
    tabs.querySelectorAll("[data-os]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.os === os)));
    // One-tap install where the browser offers it (Chrome on Android and computers)
    const canPrompt = !!installPrompt && os === "android";
    $("installNow").hidden = !canPrompt;
    $("installNow").textContent = T.installNow;
    $("installOr").hidden = !canPrompt;
    $("installOr").textContent = T.installNowNote;
    let steps, note;
    if (os === "ios") { steps = T.installIOS; note = T.installIOSNote; }
    else if (isSamsung()) { steps = T.installSamsung; note = ""; }
    else { steps = T.installAndroid; note = T.installAndroidNote; }
    $("installSteps").innerHTML = steps.map((s) => `<li><span>${s}</span></li>`).join("") + (note ? `<li class="note">${note}</li>` : "");
    $("installDone").textContent = T.installOk;
  }
  function onInstall() {
    installOS = null;
    renderInstall();
    setView($("installSheet"), true);
  }
  async function installNow() {
    if (!installPrompt) return;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    if (choice?.outcome === "accepted") { $("installBtn").hidden = true; closeInstall(); }
    else renderInstall();
  }
  const closeInstall = () => setView($("installSheet"), false);
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; syncInstallBtn(); });
  window.addEventListener("appinstalled", () => { installPrompt = null; $("installBtn").hidden = true; closeInstall(); });
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  /* ---------- flow ---------- */
  async function locate() {
    state.locating = true; render();
    state.coords = await getPosition();
    state.locating = false;
    render();
    loadMeIQ();
    if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext());
  }
  async function refresh() {
    let data;
    try { data = await loadData(); }
    catch {
      if (!state.data) $("pager").innerHTML = `<section class="slide sky sky-none"><div class="page"><div class="page-inner"><section class="card empty">
        <p>${T.loadError}</p><button class="pill" type="button" data-action="reload">${T.tryAgain}</button></section></div></div></section>`;
      return false;
    }
    state.checkedAt = new Date();
    paintChecked();
    await loadWorldSnapshot();
    loadAllWorld();
    if (state.coords) loadMeIQ();
    const stamp = data.updated + ":" + (data.stations?.length || 0);
    if (stamp === state.dataStamp) return "same";    // nothing new, keep the DOM as is
    state.data = data; state.dataStamp = stamp;
    render();
    loadHistory().then(render);
    loadFires().then(() => { if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext()); });
    if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext());
    return "changed";
  }

  /* ---------- events ---------- */
  let rafId = 0;
  $("pager").addEventListener("scroll", () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const p = $("pager");
      const i = Math.round(p.scrollLeft / Math.max(1, p.clientWidth));
      if (i !== state.page) { state.page = i; markDot(); }
    });
  }, { passive: true });
  $("pager").addEventListener("scrollend", () => store.set(PAGE_KEY, state.page), { passive: true });

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const lang = t.closest("[data-lang]"); if (lang) return setLang(lang.dataset.lang);
    const go = t.closest("[data-goto]"); if (go) return goTo(+go.dataset.goto, true);
    const open = t.closest("[data-open]");
    if (open) {
      if (Date.now() - swipeEndedAt < 350) return;          // that was a swipe, not a tap
      if (openRow) return closeRow(openRow);
      if (!state.editing) { showList(false); return goTo(+open.dataset.open, false); }
    }
    const rm = t.closest("[data-remove]");
    if (rm) {
      const li = rm.closest(".loc-card");
      return li ? animateRemove(li, rm.dataset.remove) : removeStation(rm.dataset.remove);
    }
    const add = t.closest("[data-add]"); if (add) return addStation(add.dataset.add);
    const addW = t.closest("[data-add-world]"); if (addW) { const r = worldResults[+addW.dataset.addWorld]; if (r) addWorld(r); return; }
    const retry = t.closest("[data-retry]"); if (retry) return loadWorld(retry.dataset.retry);
    const sh = t.closest("[data-share]"); if (sh) return shareEntry(+sh.dataset.share);
    if (t.closest("[data-close-alerts]")) return closeAlerts();
    const act = t.closest("[data-action]");
    if (act?.dataset.action === "locate") return locate();
    if (act?.dataset.action === "reload") return refresh();
    if (t.closest("[data-close-install]")) return closeInstall();
    if (t.closest("[data-close]")) return closeSheet();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if ($("alertsSheet").classList.contains("open")) closeAlerts();
      else if ($("installSheet").classList.contains("open")) closeInstall();
      else if (sheet.classList.contains("open")) closeSheet();
      else if (document.body.classList.contains("map-open")) closeMap();
      else if (document.body.classList.contains("list-open")) showList(false);
    }
    const free = !sheet.classList.contains("open") && !document.body.classList.contains("list-open") && !document.body.classList.contains("map-open");
    if (free && (ev.key === "ArrowRight" || ev.key === "ArrowLeft") && !/input/i.test(ev.target.tagName)) {
      const max = entries().length - 1;
      goTo(Math.max(0, Math.min(max, state.page + (ev.key === "ArrowRight" ? 1 : -1))), true);
    }
  });
  $("mapBtn").addEventListener("click", openMap);
  $("installBtn").addEventListener("click", onInstall);
  $("installNow").addEventListener("click", installNow);
  $("installTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-os]"); if (b) { installOS = b.dataset.os; renderInstall(); } });
  $("alertsBtn").addEventListener("click", openAlerts);
  $("alertsForm").addEventListener("submit", saveAlerts);
  $("alertsOff").addEventListener("click", turnOffAlerts);
  $("searchOpen").addEventListener("click", openSheet);
  $("listBtn").addEventListener("click", () => showList(true));
  $("editBtn").addEventListener("click", () => { state.editing = !state.editing; renderList(); });
  $("search").addEventListener("input", (ev) => renderSearch(ev.target.value));
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => goTo(state.page, false), 120); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  /* ---------- Text size: follow the iPhone's Text Size setting ----------
     Safari exposes it through the "-apple-system-body" font (17px at the
     default size). Text grows with it, capped at 1.5x so layouts hold. */
  function applyTextSize() {
    let px = 17;
    try {
      if (window.CSS && CSS.supports("font", "-apple-system-body")) {
        const probe = document.createElement("span");
        probe.style.font = "-apple-system-body";
        probe.style.position = "absolute"; probe.style.visibility = "hidden";
        document.body.appendChild(probe);
        const v = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        if (Number.isFinite(v) && v > 0) px = v;
      }
    } catch { /* keep the default */ }
    px = Math.min(25.5, Math.max(14, px));
    const val = px + "px";
    if (document.documentElement.style.fontSize !== val) document.documentElement.style.fontSize = val;
  }
  applyTextSize();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) applyTextSize(); });
  window.addEventListener("resize", applyTextSize);

  /* ---------- start ---------- */
  state.saved = store.get(SAVED_KEY, []);
  if (!Array.isArray(state.saved)) state.saved = [];
  state.places = store.get(PLACES_KEY, {}) || {};
  state.page = Math.max(0, +store.get(PAGE_KEY, 0) || 0);
  const savedLang = store.get(LANG_KEY, null);
  state.lang = I18N[savedLang] ? savedLang : (navigator.language || "").toLowerCase().startsWith("ms") ? "ms" : "en";
  T = I18N[state.lang];
  [$("listView"), $("mapView"), sheet, $("installSheet"), $("alertsSheet")].forEach((v) => setView(v, false));
  syncInstallBtn();
  syncAlertsBtn();
  renderChrome();

  refresh().then((ok) => { if (ok) locate(); });
  setInterval(refresh, REFRESH_MS);
})();
