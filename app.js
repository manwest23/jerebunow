/* JerebuNow — Malaysian Air Pollutant Index (API / IPU) in an Apple Weather
   style layout, in English and Bahasa Melayu. Page 1 is the station nearest
   to you; add more stations and swipe between them. The map (map.js) loads
   on first use. Data: data/api.json, refreshed hourly by
   scripts/fetch-apims.mjs from DOE APIMS and MET Malaysia.
   Developed by manwest. */
(() => {
  "use strict";

  const DATA_URL = "data/api.json";
  const REFRESH_MS = 15 * 60 * 1000;
  const SAVED_KEY = "jerebunow.saved";
  const PAGE_KEY = "jerebunow.page";
  const LANG_KEY = "jerebunow.lang";
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

  const $ = (id) => document.getElementById(id);
  const state = {
    data: null, dataStamp: null, coords: null, locating: true,
    saved: [], page: 0, editing: false, lang: "en"
  };
  let T = I18N.en;
  const otherLang = () => (state.lang === "en" ? "ms" : "en");
  const bandText = (b) => T.bands[b.key];

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
    trend: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 12 6 7.5l3 3 5.5-6"/><path d="M10.5 4.5h4v4"/></svg>'
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
    haze: '<svg viewBox="0 0 24 24"><g stroke="#e6d8b8" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h17M5.5 12h13M3.5 16h17M7.5 20h9"/></g></svg>'
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
  function entries() {
    const list = [{ kind: "me" }];
    for (const id of state.saved) if (stationById(id)) list.push({ kind: "saved", id });
    return list.map((e) => {
      if (e.kind === "me") {
        const n = state.coords ? nearest(state.coords) : null;
        return { ...e, s: n?.s || null, d: n?.d ?? null };
      }
      const s = stationById(e.id);
      return { ...e, s, d: state.coords ? km(state.coords, s) : null };
    });
  }

  /* ---------- running advice ---------- */
  const LEVELS = { go: 0, care: 1, stop: 2 };
  const DOT = { go: "var(--run-go)", care: "var(--run-care)", stop: "var(--run-stop)" };

  function airFactor(s) {
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
  function runCard(s) {
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
      <div class="scale" role="img" aria-label="${esc(T.mapLegend)}">${BANDS.map((b, i) =>
        `<div class="${b === band ? "on" : ""}"><i style="background:${b.color}"></i>${T.bands[b.key].label}<br>${RANGES[i]}</div>`).join("")}</div>
    </section>`;
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

  function tiles(s) {
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

  function footer() {
    return `<footer class="foot">
      ${langSwitch()}
      <p>${state.data?.sample ? T.srcSample : T.srcLive}</p>
      <p>${T.srcForecast}</p>
      <p>${T.srcOfficial} <a href="https://eqms.doe.gov.my/APIMS/main" target="_blank" rel="noopener">eqms.doe.gov.my</a></p>
      <p class="credit">${T.developedBy} <b>manwest</b></p>
    </footer>`;
  }

  function hiLo(s) {
    const h = (s.history || []).slice(-24);
    return h.length > 1 ? `H:${Math.max(...h)}  L:${Math.min(...h)}` : "";
  }

  function pageHTML(e, i) {
    const night = isNight() ? " night" : "";
    const tag = e.kind === "me" ? `<p class="hero-tag">${ARROW}${T.myLocation}</p>` : `<p class="hero-tag">&nbsp;</p>`;
    if (!e.s) {
      return `<section class="page sky sky-none${night}" data-index="${i}" aria-label="${T.myLocation}">
        <div class="page-inner">
          <header class="hero">${tag}<p class="hero-name">${state.locating ? T.locating : T.locationOff}</p><p class="hero-api">--</p></header>
          <section class="card empty"><p>${state.locating ? T.findingNearest : T.locationOffMsg}</p>
            ${state.locating ? "" : `<button class="pill" type="button" data-action="locate">${T.tryAgain}</button>`}</section>
          ${footer()}
        </div></section>`;
    }
    const s = e.s, band = bandFor(s.api);
    const other = I18N[otherLang()].bands[band.key].label;
    const meta = [e.kind === "me" ? (e.d != null ? T.nearestStation(fmtKm(e.d)) : "") : s.state,
      timeAgo(s.readingTime || state.data.updated)].filter(Boolean).join(" · ");
    return `<section class="page sky sky-${band.key}${night}" data-index="${i}" aria-label="${esc(s.name)}">
      <div class="page-inner">
        <header class="hero">
          ${tag}
          <p class="hero-name">${esc(s.name)}</p>
          <p class="hero-api">${s.api}<small>${T.api}</small></p>
          <p class="hero-cat">${bandText(band).label} · <span class="alt">${other}</span></p>
          <p class="hero-hl">${hiLo(s)}</p>
          <p class="hero-meta">${esc(meta)}</p>
        </header>
        ${adviceCard(band)}
        ${runCard(s)}
        ${hoursCard(s)}
        ${forecastCard(s)}
        ${tiles(s)}
        ${footer()}
      </div>
    </section>`;
  }

  /* ---------- render ---------- */
  let lastPagesKey = "";
  function render(force) {
    const list = entries();
    state.page = Math.max(0, Math.min(state.page, list.length - 1));
    // Skip rebuilding pages when nothing visible changed (keeps scroll smooth).
    const key = JSON.stringify([state.dataStamp, state.lang, state.locating, list.map((e) => [e.kind, e.s?.id, e.d && Math.round(e.d * 10)]), isNight()]);
    const pager = $("pager");
    if (force || key !== lastPagesKey) {
      lastPagesKey = key;
      const keep = [...pager.querySelectorAll(".page")].map((p) => p.scrollTop);
      pager.innerHTML = list.map(pageHTML).join("");
      const pages = pager.querySelectorAll(".page");
      pages.forEach((p, i) => { if (keep[i]) p.scrollTop = keep[i]; });
      pager.querySelectorAll("[data-scroll-end]").forEach((el) => { el.scrollLeft = el.scrollWidth; });
      pager.scrollLeft = state.page * pager.clientWidth;
    }
    $("dots").innerHTML = list.map((e, i) =>
      `<button class="dot-btn" type="button" role="tab" data-goto="${i}" aria-selected="${i === state.page}"
        aria-label="${esc(e.kind === "me" ? T.myLocation : e.s?.name || "")}">${e.kind === "me" ? ARROW : "<i></i>"}</button>`).join("");
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
      const s = e.s, night = isNight() ? " night" : "";
      const sky = s ? `sky-${bandFor(s.api).key}` : "sky-none";
      const sub = e.kind === "me" ? `${ARROW}${T.myLocation}${s ? ` · ${esc(s.state)}` : ""}` : esc(s.state);
      const name = e.kind === "me" ? (s ? s.name : state.locating ? T.locating : T.locationOff) : s.name;
      const remove = state.editing && e.kind === "saved"
        ? `<button class="remove-btn" type="button" data-remove="${esc(e.id)}" aria-label="${esc(T.remove(s.name))}"><svg viewBox="0 0 14 14"><path d="M3 7h8"/></svg></button>` : "";
      return `<li class="loc-card">${remove}
        <button class="loc-open sky ${sky}${night}" type="button" data-open="${i}">
          <span class="nm">${esc(name)}</span><span class="sub">${sub}</span>
          <span class="val">${s ? s.api : "--"}</span>
          <span class="cat">${s ? bandText(bandFor(s.api)).label : ""}</span>
          <span class="hl">${s ? hiLo(s) : ""}</span>
        </button></li>`;
    }).join("");
  }

  function renderSearch(q) {
    const needle = (q || "").trim().toLowerCase();
    const list = stations()
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.state.toLowerCase().includes(needle))
      .map((s) => ({ s, d: state.coords ? km(state.coords, s) : null }))
      .sort((a, b) => (a.d != null && b.d != null ? a.d - b.d : a.s.state.localeCompare(b.s.state) || a.s.name.localeCompare(b.s.name)));
    $("allList").innerHTML = list.length ? list.map(({ s, d }) => {
      const b = bandFor(s.api);
      const added = state.saved.includes(s.id) ? `<span class="added">${T.added}</span>` : "";
      return `<li><button class="row" type="button" data-add="${esc(s.id)}">
        <span class="dot" style="background:${b.color}"></span>
        <span class="txt"><span class="nm">${esc(s.name)}${added}</span><span class="st">${esc(s.state)}${d != null ? ` · ${fmtKm(d)}` : ""} · ${bandText(b).label}</span></span>
        <span class="val">${s.api}</span></button></li>`;
    }).join("") : `<li><p class="small" style="padding:12px 0">${T.noMatch}</p></li>`;
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
  function markDot() {
    document.querySelectorAll(".dot-btn").forEach((d, i) => d.setAttribute("aria-selected", String(i === state.page)));
  }
  function showList(show) {
    if (!show) state.editing = false;
    renderList();
    document.body.classList.toggle("list-open", show);
    setView($("listView"), show);
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
    render();
  }
  function setLang(lang) {
    if (!I18N[lang] || lang === state.lang) return;
    state.lang = lang; T = I18N[lang];
    store.set(LANG_KEY, lang);
    render(true);
    if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext());
  }

  /* ---------- map (lazy) ---------- */
  function mapContext() {
    return {
      t: T, lang: state.lang, bands: BANDS, bandFor,
      bandLabel: (b) => T.bands[b.key].label,
      stations: stations(), updated: state.data?.updated,
      coords: state.coords,
      onOpen: (id) => { closeMap(); openStation(id); },
      onClose: () => closeMap()
    };
  }
  let mapScript;
  function loadMapModule() {
    if (window.JerebuMap) return Promise.resolve();
    if (!mapScript) mapScript = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "map.js?v=2"; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    return mapScript;
  }
  async function openMap() {
    const view = $("mapView");
    document.body.classList.add("map-open");
    setView(view, true);
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
    window.JerebuMap?.close();
  }

  /* ---------- Add to Home Screen ---------- */
  let installPrompt = null;
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function syncInstallBtn() { $("installBtn").hidden = isStandalone(); }
  async function onInstall() {
    if (installPrompt) {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      if (choice?.outcome === "accepted") $("installBtn").hidden = true;
      return;
    }
    const ios = isIOS();
    $("installTitle").textContent = T.installTitle;
    $("installSub").textContent = T.installSub;
    $("installSteps").innerHTML = (ios ? T.installIOS : T.installOther).map((s) => `<li><span>${s}</span></li>`).join("")
      + (ios ? `<li class="note">${T.installIOSNote}</li>` : "");
    $("installDone").textContent = T.installOk;
    setView($("installSheet"), true);
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
    if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext());
  }
  async function refresh() {
    let data;
    try { data = await loadData(); }
    catch {
      if (!state.data) $("pager").innerHTML = `<section class="page sky sky-none"><div class="page-inner"><section class="card empty">
        <p>${T.loadError}</p><button class="pill" type="button" data-action="reload">${T.tryAgain}</button></section></div></section>`;
      return false;
    }
    const stamp = data.updated + ":" + (data.stations?.length || 0);
    if (stamp === state.dataStamp) return true;      // nothing new, keep the DOM as is
    state.data = data; state.dataStamp = stamp;
    render();
    if (window.JerebuMap?.isOpen()) window.JerebuMap.update(mapContext());
    return true;
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
    const open = t.closest("[data-open]"); if (open && !state.editing) { showList(false); return goTo(+open.dataset.open, false); }
    const rm = t.closest("[data-remove]"); if (rm) return removeStation(rm.dataset.remove);
    const add = t.closest("[data-add]"); if (add) return addStation(add.dataset.add);
    const act = t.closest("[data-action]");
    if (act?.dataset.action === "locate") return locate();
    if (act?.dataset.action === "reload") return refresh();
    if (t.closest("[data-close-install]")) return closeInstall();
    if (t.closest("[data-close]")) return closeSheet();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if ($("installSheet").classList.contains("open")) closeInstall();
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
  $("searchOpen").addEventListener("click", openSheet);
  $("listBtn").addEventListener("click", () => showList(true));
  $("editBtn").addEventListener("click", () => { state.editing = !state.editing; renderList(); });
  $("search").addEventListener("input", (ev) => renderSearch(ev.target.value));
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => goTo(state.page, false), 120); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  /* ---------- start ---------- */
  state.saved = store.get(SAVED_KEY, []);
  if (!Array.isArray(state.saved)) state.saved = [];
  state.page = Math.max(0, +store.get(PAGE_KEY, 0) || 0);
  const savedLang = store.get(LANG_KEY, null);
  state.lang = I18N[savedLang] ? savedLang : (navigator.language || "").toLowerCase().startsWith("ms") ? "ms" : "en";
  T = I18N[state.lang];
  [$("listView"), $("mapView"), sheet, $("installSheet")].forEach((v) => setView(v, false));
  syncInstallBtn();
  renderChrome();

  refresh().then((ok) => { if (ok) locate(); });
  setInterval(refresh, REFRESH_MS);
})();
