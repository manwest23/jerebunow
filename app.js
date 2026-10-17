/* JerebuNow — Malaysian Air Pollutant Index (API / IPU) in an Apple Weather
   style layout. Page 1 is the station nearest to you; you can add more
   stations and swipe between them. Reads data/api.json, which
   scripts/fetch-apims.mjs refreshes hourly from DOE APIMS and MET Malaysia.
   Developed by manwest. */
(() => {
  "use strict";

  const DATA_URL = "data/api.json";
  const REFRESH_MS = 15 * 60 * 1000;
  const SAVED_KEY = "jerebunow.saved";
  const PAGE_KEY = "jerebunow.page";

  /* ---------- API bands (DOE) + MOH-style advice ---------- */
  const BANDS = [
    { key: "good", max: 50, label: "Good", ms: "Baik", color: "var(--good)", sign: "✓",
      title: "Air quality is good",
      advice: "Enjoy outdoor activities as usual." },
    { key: "moderate", max: 100, label: "Moderate", ms: "Sederhana", color: "var(--moderate)", sign: "✓",
      title: "Acceptable for most people",
      advice: "If you are unusually sensitive to haze, cut back long or heavy outdoor exertion." },
    { key: "unhealthy", max: 200, label: "Unhealthy", ms: "Tidak Sihat", color: "var(--unhealthy)", sign: "!",
      title: "Limit time outdoors",
      advice: "Reduce prolonged outdoor activity. Children, older adults and people with heart or lung conditions should stay indoors and keep windows closed." },
    { key: "very", max: 300, label: "Very Unhealthy", ms: "Sangat Tidak Sihat", color: "var(--very)", sign: "!",
      title: "Avoid outdoor activity",
      advice: "Stay indoors with windows closed. Wear an N95 mask if you must go out, and seek medical help if you feel unwell." },
    { key: "hazard", max: Infinity, label: "Hazardous", ms: "Berbahaya", color: "var(--hazard)", sign: "!",
      title: "Stay indoors",
      advice: "Follow instructions from the authorities and seek medical attention if you have symptoms." }
  ];
  const bandFor = (v) => BANDS.find((b) => v <= b.max) || BANDS[BANDS.length - 1];
  const RANGES = ["0–50", "51–100", "101–200", "201–300", "300+"];

  const POLLUTANT_NOTES = {
    "PM2.5": "Fine particles, the main haze component",
    "PM10": "Coarse dust and smoke particles",
    "O3": "Ground-level ozone",
    "CO": "Carbon monoxide",
    "NO2": "Nitrogen dioxide",
    "SO2": "Sulphur dioxide",
    "Multiple": "More than one pollutant"
  };

  const $ = (id) => document.getElementById(id);
  const state = { data: null, coords: null, locating: true, saved: [], page: 0, editing: false };

  /* ---------- helpers ---------- */
  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtKm = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + " km";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const isNight = () => { const h = new Date().getHours(); return h < 7 || h >= 19; };
  const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function timeAgo(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return "";
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "Updated just now";
    if (mins < 60) return `Updated ${mins} min ago`;
    if (mins < 24 * 60) return `Updated ${Math.round(mins / 60)} h ago`;
    return `Updated ${t.toLocaleDateString("en-MY")}`;
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
  function weather(t) {
    const s = String(t || "").toLowerCase();
    const extent = /kebanyakan/.test(s) ? "Widespread" : /beberapa/.test(s) ? "Scattered" : /satu dua/.test(s) ? "Isolated" : "";
    if (/ribut petir/.test(s)) return { kind: "storm", en: `${extent} thunderstorms`.trim() };
    if (/tiada hujan/.test(s) || /cerah/.test(s)) return { kind: "clear", en: "No rain" };
    if (/hujan/.test(s)) return { kind: "rain", en: `${extent} rain`.trim() };
    if (/jerebu/.test(s)) return { kind: "haze", en: "Hazy" };
    if (/mendung|berawan/.test(s)) return { kind: "cloud", en: "Cloudy" };
    return { kind: "cloud", en: t || "--" };
  }
  const WX = {
    clear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6" fill="#ffd23f"/><g stroke="#ffd23f" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5h10.2a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.8 1.4A3.1 3.1 0 0 0 7 18.5Z" fill="#fff"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.2a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.8 8.3 3.1 3.1 0 0 0 7 14.5Z" fill="#fff"/><g stroke="#7cc4ff" stroke-width="1.8" stroke-linecap="round"><path d="m8.5 17-1 3M12.5 17l-1 3M16.5 17l-1 3"/></g></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.2a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.8 8.3 3.1 3.1 0 0 0 7 14.5Z" fill="#fff"/><path d="M12.6 14 10 18.2h2.6L11.4 22l3.8-5.2h-2.6l1.2-2.8Z" fill="#ffd23f"/></svg>',
    haze: '<svg viewBox="0 0 24 24"><g stroke="#e6d8b8" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h17M5.5 12h13M3.5 16h17M7.5 20h9"/></g></svg>'
  };
  const PERIODS = [
    { key: "morning", en: "morning" },
    { key: "afternoon", en: "afternoon" },
    { key: "night", en: "evening" }
  ];
  const WHEN_SHORT = { pagi: "AM", petang: "PM", malam: "Night" };
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
  function forecastFor(s) {
    const f = state.data?.forecasts?.[s.forecastKey];
    return f && Array.isArray(f.days) && f.days.length ? f : null;
  }
  function todayIndex(days) {
    const i = days.findIndex((d) => d.date >= localISO(new Date()));
    return i >= 0 ? i : 0;
  }

  // Page list: My Location first, then saved stations that still exist.
  function entries() {
    const list = [{ kind: "me" }];
    for (const id of state.saved) if (stationById(id)) list.push({ kind: "saved", id });
    return list.map((e) => {
      if (e.kind === "me") {
        const n = state.coords ? nearest(state.coords) : null;
        return { ...e, s: n?.s || null, d: n?.d ?? null };
      }
      return { ...e, s: stationById(e.id), d: state.coords ? km(state.coords, stationById(e.id)) : null };
    });
  }

  /* ---------- running advice ---------- */
  const LEVELS = { go: 0, care: 1, stop: 2 };
  const DOT = { go: "var(--run-go)", care: "var(--run-care)", stop: "var(--run-stop)" };

  function airFactor(s) {
    const h = s.history || [];
    const rising = h.length >= 4 && h[h.length - 1] - h[h.length - 4] > 3;
    if (s.api <= 50) return { level: "go", text: `API ${s.api}, clean air. Push the pace if you like.` };
    if (s.api <= 100) {
      if (s.api > 85 && rising) return { level: "care", text: `API ${s.api} and rising toward unhealthy. Keep it short and easy.` };
      return { level: "go", text: `API ${s.api}, fine for most runners. If you have asthma, keep the effort easy.` };
    }
    if (s.api <= 200) return { level: "stop", text: `API ${s.api}, unhealthy. Hard breathing pulls more haze into your lungs. Run indoors today.` };
    return { level: "stop", text: `API ${s.api}, ${s.api > 300 ? "hazardous" : "very unhealthy"}. Stay indoors and skip the run.` };
  }
  function weatherFactor(day, pi) {
    if (!day) return null;
    const w = weather(day[PERIODS[pi].key]);
    const when = ["this morning", "this afternoon", "this evening"][pi];
    if (w.kind === "storm") return { level: "stop", text: `${w.en} ${when}. Lightning risk on open roads and parks.` };
    if (w.kind === "rain") return { level: "care", text: `${w.en} ${when}. Expect wet, slippery paths.` };
    return { level: "go", text: `No rain forecast ${when}.` };
  }
  function heatFactor(day, pi) {
    if (!day || !Number.isFinite(day.max)) return null;
    if (pi === 1 && day.max >= 33) return { level: "care", text: `Up to ${day.max}°C this afternoon. Go early morning or after sunset and carry water.` };
    if (day.max >= 35) return { level: "care", text: `Up to ${day.max}°C today. Run before 8am or after 7pm and hydrate well.` };
    return { level: "go", text: `${day.min}–${day.max}°C today. Normal tropical heat, hydrate as usual.` };
  }
  function nextDryWindow(days, startDay, startPeriod) {
    for (let d = startDay; d < Math.min(days.length, startDay + 3); d++) {
      for (let p = d === startDay ? startPeriod : 0; p < 3; p++) {
        if (weather(days[d][PERIODS[p].key]).kind !== "clear") continue;
        if (d === startDay && p === startPeriod) return null;
        const name = d === startDay ? "today" : d === startDay + 1 ? "tomorrow"
          : new Date(days[d].date + "T00:00:00").toLocaleDateString("en-MY", { weekday: "long" });
        return `${name} ${PERIODS[p].en}`;
      }
    }
    return null;
  }

  function runCard(s) {
    const fc = forecastFor(s);
    const ti = fc ? todayIndex(fc.days) : -1;
    const day = fc ? fc.days[ti] : null;
    const pi = periodIndexNow();
    const factors = [
      { k: "Air", ...airFactor(s) },
      weatherFactor(day, pi) && { k: "Weather", ...weatherFactor(day, pi) },
      heatFactor(day, pi) && { k: "Heat", ...heatFactor(day, pi) }
    ].filter(Boolean);
    const level = factors.reduce((m, f) => (LEVELS[f.level] > LEVELS[m] ? f.level : m), "go");
    const airBad = factors[0].level === "stop";
    const badge = level === "go" ? "Go run" : level === "care" ? "Run with care" : "Skip it";
    const verdict = level === "go" ? "Good conditions for a run right now."
      : level === "care" ? "You can run, but adjust your plan."
      : airBad ? "Not a good time to run outside." : "Hold off for now.";
    let best = "";
    if (airBad) best = "Run on a treadmill or do an indoor session. Head out again once the API is 100 or below.";
    else if (fc && level !== "go") {
      const w = nextDryWindow(fc.days, ti, pi);
      if (w) best = `Next dry window: ${w}. Check the API again before you head out.`;
    } else if (!fc) best = "No weather forecast for this station, so check the sky before you go.";

    return `<section class="card run" data-level="${level}">
      <h2 class="card-head">${ICON.run}Running outside</h2>
      <div class="run-top"><span class="run-badge">${badge}</span><p class="run-verdict">${verdict}</p></div>
      <ul class="run-factors">${factors.map((f) =>
        `<li><span class="k">${f.k}</span><span class="v"><i style="background:${DOT[f.level]}"></i>${esc(f.text)}</span></li>`).join("")}</ul>
      <p class="run-best">${esc(best)}</p>
    </section>`;
  }

  /* ---------- page sections ---------- */
  function adviceCard(band) {
    return `<section class="card">
      <h2 class="card-head">${ICON.advice}Health advice</h2>
      <div class="advice-row">
        <span class="advice-sign" style="background:${band.color}" aria-hidden="true">${band.sign}</span>
        <p class="advice-text"><b>${band.title}</b>${band.advice}</p>
      </div>
      <div class="scale" aria-label="API scale">${BANDS.map((b, i) =>
        `<div class="${b === band ? "on" : ""}"><i style="background:${b.color}"></i>${b.label}<br>${RANGES[i]}</div>`).join("")}</div>
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
      const label = now ? "Now" : isNaN(t) ? "" : String(t.getHours()).padStart(2, "0");
      return `<div class="hr${now ? " now" : ""}">
        <span class="t">${label}</span>
        <span class="bar" aria-hidden="true"><i style="height:${Math.max(6, (v / max) * 100).toFixed(0)}%;background:${bandFor(v).color}"></i></span>
        <span class="v">${v}</span>
      </div>`;
    }).join("");
    const note = h.length < 24 ? `<p class="small">History builds up hour by hour (${h.length} of 24 readings so far).</p>` : "";
    return `<section class="card">
      <h2 class="card-head">${ICON.clock}Hourly API · last ${h.length} h</h2>
      <div class="hours" data-scroll-end>${cells}</div>${note}
    </section>`;
  }

  function bestRunSlot(day) {
    const dry = PERIODS.filter((p) => weather(day[p.key]).kind === "clear");
    if (!dry.length) return "Wet all day";
    if (dry.length === 3) return "Dry all day";
    return `Dry ${dry.map((p) => p.en).join(" & ")}`;
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
      const name = i === 0 ? "Today" : new Date(d.date + "T00:00:00").toLocaleDateString("en-MY", { weekday: "short" });
      const when = w.kind !== "clear" ? WHEN_SHORT[String(d.summary_when || "").toLowerCase()] || "" : "";
      const left = ((d.min - lo) / span) * 100, width = Math.max(8, ((d.max - d.min) / span) * 100);
      return `<li>
        <span class="day">${name}</span>
        <span class="ic" title="${esc(d.summary)}">${WX[w.kind]}${when ? `<span>${when}</span>` : ""}</span>
        <span class="lo">${d.min}°</span>
        <span class="range" aria-hidden="true"><i style="left:${left.toFixed(0)}%;width:${Math.min(100 - left, width).toFixed(0)}%"></i></span>
        <span class="hi">${d.max}°</span>
        <span class="note">${esc(cap(w.en))} · ${esc(bestRunSlot(d))}</span>
      </li>`;
    }).join("");
    return `<section class="card">
      <h2 class="card-head">${ICON.cal}${days.length}-day forecast</h2>
      <ul class="fc">${rows}</ul>
      <p class="small fc-src">MET Malaysia forecast for ${esc(fc.location)}.</p>
    </section>`;
  }

  function tiles(s) {
    const h = s.history || [];
    let trend = "--", tnote = "Not enough readings yet";
    if (h.length >= 4) {
      const diff = h[h.length - 1] - h[h.length - 4];
      trend = diff > 3 ? "Rising" : diff < -3 ? "Falling" : "Steady";
      tnote = `${diff > 0 ? "+" : ""}${diff} over the last 3 hours`;
    }
    return `<div class="grid2">
      <section class="card"><h2 class="card-head">${ICON.pol}Main pollutant</h2>
        <p class="big">${esc(s.pollutant || "--")}</p><p class="small">${esc(POLLUTANT_NOTES[s.pollutant] || "Pollutant with the highest sub-index")}</p></section>
      <section class="card"><h2 class="card-head">${ICON.trend}Trend</h2>
        <p class="big">${trend}</p><p class="small">${tnote}</p></section>
    </div>`;
  }

  function footer() {
    const src = state.data?.sample
      ? "Showing sample data until the hourly update runs."
      : "Air quality: Department of Environment Malaysia (APIMS), hourly.";
    return `<footer class="foot">
      <p>${src}</p>
      <p>Forecast: MET Malaysia via data.gov.my.</p>
      <p>Official readings: <a href="https://eqms.doe.gov.my/APIMS/main" target="_blank" rel="noopener">eqms.doe.gov.my</a></p>
      <p class="credit">Developed by <b>manwest</b></p>
    </footer>`;
  }

  function hiLo(s) {
    const h = (s.history || []).slice(-24);
    return h.length > 1 ? `H:${Math.max(...h)}  L:${Math.min(...h)}` : "";
  }

  function pageHTML(e, i) {
    const night = isNight() ? " night" : "";
    const tag = e.kind === "me" ? `<p class="hero-tag">${ARROW}My Location</p>` : `<p class="hero-tag">&nbsp;</p>`;

    if (!e.s) {
      const msg = state.locating ? "Finding the station nearest to you…"
        : "Location is off. Allow location access to see the station nearest to you, or add a station with the + button.";
      return `<section class="page sky sky-none${night}" data-index="${i}" aria-label="My Location">
        <div class="page-inner">
          <header class="hero">${tag}<p class="hero-name">${state.locating ? "Locating…" : "Location off"}</p>
            <p class="hero-api">--</p></header>
          <section class="card empty"><p>${msg}</p>
            ${state.locating ? "" : '<button class="pill" type="button" data-action="locate">Try again</button>'}</section>
          ${footer()}
        </div></section>`;
    }

    const s = e.s, band = bandFor(s.api);
    const meta = [
      e.kind === "me" ? `Nearest station${e.d != null ? `, ${fmtKm(e.d)} away` : ""}` : s.state,
      timeAgo(s.readingTime || state.data.updated)
    ].filter(Boolean).join(" · ");

    return `<section class="page sky sky-${band.key}${night}" data-index="${i}" aria-label="${esc(s.name)}">
      <div class="page-inner">
        <header class="hero">
          ${tag}
          <p class="hero-name">${esc(s.name)}</p>
          <p class="hero-api">${s.api}<small>API</small></p>
          <p class="hero-cat">${band.label} · ${band.ms}</p>
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
  function render() {
    const list = entries();
    state.page = Math.min(state.page, list.length - 1);

    const pager = $("pager");
    const keepScroll = [...pager.querySelectorAll(".page")].map((p) => p.scrollTop);
    pager.innerHTML = list.map(pageHTML).join("");
    pager.querySelectorAll(".page").forEach((p, i) => { if (keepScroll[i]) p.scrollTop = keepScroll[i]; });
    pager.querySelectorAll("[data-scroll-end]").forEach((el) => { el.scrollLeft = el.scrollWidth; });
    pager.scrollLeft = state.page * pager.clientWidth;

    $("dots").innerHTML = list.map((e, i) =>
      `<button class="dot-btn" type="button" role="tab" data-goto="${i}" aria-selected="${i === state.page}"
        aria-label="${esc(e.kind === "me" ? "My Location" : e.s?.name || "Station")}">${e.kind === "me" ? ARROW : "<i></i>"}</button>`).join("");

    renderList(list);
    $("listSource").textContent = state.data?.sample
      ? "Showing sample data until the hourly update runs."
      : "Air quality: DOE Malaysia (APIMS). Forecast: MET Malaysia.";
  }

  function renderList(list = entries()) {
    $("editBtn").textContent = state.editing ? "Done" : "Edit";
    $("locCards").innerHTML = list.map((e, i) => {
      const s = e.s, night = isNight() ? " night" : "";
      const sky = s ? `sky-${bandFor(s.api).key}` : "sky-none";
      const sub = e.kind === "me" ? `${ARROW}My Location${s ? ` · ${esc(s.state)}` : ""}` : esc(s.state);
      const name = e.kind === "me" ? (s ? s.name : state.locating ? "Locating…" : "Location off") : s.name;
      const remove = state.editing && e.kind === "saved"
        ? `<button class="remove-btn" type="button" data-remove="${esc(e.id)}" aria-label="Remove ${esc(s.name)}"><svg viewBox="0 0 14 14"><path d="M3 7h8"/></svg></button>` : "";
      return `<li class="loc-card">${remove}
        <button class="loc-open sky ${sky}${night}" type="button" data-open="${i}">
          <span class="nm">${esc(name)}</span>
          <span class="sub">${sub}</span>
          <span class="val">${s ? s.api : "--"}</span>
          <span class="cat">${s ? bandFor(s.api).label : ""}</span>
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
      const added = state.saved.includes(s.id) ? '<span class="added">Added</span>' : "";
      return `<li><button class="row" type="button" data-add="${esc(s.id)}">
        <span class="dot" style="background:${b.color}"></span>
        <span class="txt"><span class="nm">${esc(s.name)}${added}</span><span class="st">${esc(s.state)}${d != null ? ` · ${fmtKm(d)}` : ""} · ${b.label}</span></span>
        <span class="val">${s.api}</span></button></li>`;
    }).join("") : '<li><p class="small" style="padding:12px 0">No station matches that search.</p></li>';
  }

  /* ---------- navigation ---------- */
  function goTo(i, smooth) {
    const pager = $("pager");
    state.page = i;
    store.set(PAGE_KEY, i);
    pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth ? "smooth" : "auto" });
    markDot();
  }
  function markDot() {
    document.querySelectorAll(".dot-btn").forEach((d, i) => d.setAttribute("aria-selected", String(i === state.page)));
  }
  function showList(show) {
    $("listView").hidden = !show;
    $("toolbar").hidden = show;
    if (!show) { state.editing = false; }
    renderList();
  }
  const sheet = $("sheet");
  function openSheet() { sheet.hidden = false; $("search").value = ""; renderSearch(""); setTimeout(() => $("search").focus(), 60); }
  function closeSheet() { sheet.hidden = true; }

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

  async function locate() {
    state.locating = true; render();
    state.coords = await getPosition();
    state.locating = false;
    render();
  }

  async function refresh() {
    try { state.data = await loadData(); }
    catch {
      $("pager").innerHTML = `<section class="page sky sky-none"><div class="page-inner"><section class="card empty">
        <p>Could not load air quality data. Check your connection and try again.</p>
        <button class="pill" type="button" data-action="reload">Try again</button></section></div></section>`;
      return false;
    }
    render();
    return true;
  }

  /* ---------- events ---------- */
  let scrollT;
  $("pager").addEventListener("scroll", () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const p = $("pager");
      const i = Math.round(p.scrollLeft / Math.max(1, p.clientWidth));
      if (i !== state.page) { state.page = i; store.set(PAGE_KEY, i); markDot(); }
    }, 60);
  }, { passive: true });

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const go = t.closest("[data-goto]"); if (go) return goTo(+go.dataset.goto, true);
    const open = t.closest("[data-open]"); if (open && !state.editing) { showList(false); return goTo(+open.dataset.open, false); }
    const rm = t.closest("[data-remove]"); if (rm) return removeStation(rm.dataset.remove);
    const add = t.closest("[data-add]"); if (add) return addStation(add.dataset.add);
    const act = t.closest("[data-action]");
    if (act?.dataset.action === "locate") return locate();
    if (act?.dataset.action === "reload") return refresh();
    if (t.closest("[data-close]")) return closeSheet();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { if (!sheet.hidden) closeSheet(); else if (!$("listView").hidden) showList(false); }
    if (sheet.hidden && $("listView").hidden && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) {
      const max = entries().length - 1;
      goTo(Math.max(0, Math.min(max, state.page + (ev.key === "ArrowRight" ? 1 : -1))), true);
    }
  });
  $("addBtn").addEventListener("click", openSheet);
  $("searchOpen").addEventListener("click", openSheet);
  $("listBtn").addEventListener("click", () => showList(true));
  $("editBtn").addEventListener("click", () => { state.editing = !state.editing; renderList(); });
  $("search").addEventListener("input", (ev) => renderSearch(ev.target.value));
  window.addEventListener("resize", () => goTo(state.page, false));

  /* ---------- start ---------- */
  state.saved = store.get(SAVED_KEY, []);
  if (!Array.isArray(state.saved)) state.saved = [];
  state.page = Math.max(0, +store.get(PAGE_KEY, 0) || 0);

  refresh().then((ok) => { if (ok) locate(); });
  setInterval(refresh, REFRESH_MS);
})();
