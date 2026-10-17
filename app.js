/* JerebuNow — shows the Malaysian Air Pollutant Index (API / IPU) for the
   monitoring station closest to you, whether it's a good time to run
   outside, and MET Malaysia's 7-day forecast. Reads data/api.json, which
   scripts/fetch-apims.mjs refreshes every hour.
   Developed by manwest. */
(() => {
  "use strict";

  const DATA_URL = "data/api.json";
  const REFRESH_MS = 15 * 60 * 1000;
  const STORE_KEY = "jerebunow.station";

  // DOE API bands. Advice follows the Ministry of Health's general guidance.
  const BANDS = [
    { key: "good",      max: 50,  label: "Good",           ms: "Baik",
      color: "var(--good)",
      advice: "Air quality is good. Enjoy outdoor activities as usual." },
    { key: "moderate",  max: 100, label: "Moderate",       ms: "Sederhana",
      color: "var(--moderate)",
      advice: "Acceptable for most people. If you are unusually sensitive, cut back long or heavy outdoor exertion." },
    { key: "unhealthy", max: 200, label: "Unhealthy",      ms: "Tidak Sihat",
      color: "var(--unhealthy)",
      advice: "Limit prolonged outdoor activity. Children, older adults and people with heart or lung conditions should stay indoors and keep windows closed." },
    { key: "very",      max: 300, label: "Very Unhealthy", ms: "Sangat Tidak Sihat",
      color: "var(--very)",
      advice: "Avoid outdoor activity. Stay indoors with windows closed and wear an N95 mask if you must go out. Seek medical help if you feel unwell." },
    { key: "hazard",    max: Infinity, label: "Hazardous", ms: "Berbahaya",
      color: "var(--hazard)",
      advice: "Stay indoors. Follow instructions from the authorities and seek medical attention if you have symptoms." }
  ];
  const bandFor = (v) => BANDS.find((b) => v <= b.max) || BANDS[BANDS.length - 1];

  const POLLUTANT_NOTES = {
    "PM2.5": "Fine particles, the main haze component",
    "PM10": "Coarse dust and smoke particles",
    "O3": "Ground-level ozone",
    "CO": "Carbon monoxide",
    "NO2": "Nitrogen dioxide",
    "SO2": "Sulphur dioxide"
  };

  const $ = (id) => document.getElementById(id);
  const state = { data: null, coords: null, current: null };

  /* ---------- helpers ---------- */
  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtKm = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + " km";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(STORE_KEY, v); } catch {} }
  };

  function timeAgo(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return "";
    const mins = Math.round((Date.now() - t) / 60000);
    const clock = t.toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" });
    if (mins < 1) return "Updated just now";
    if (mins < 60) return `Updated ${mins} min ago · ${clock}`;
    if (mins < 24 * 60) return `Updated ${Math.round(mins / 60)} h ago · ${clock}`;
    return `Updated ${t.toLocaleDateString("en-MY")} ${clock}`;
  }


  /* ---------- weather (MET Malaysia text is in Bahasa Melayu) ---------- */
  function weather(t) {
    const s = String(t || "").toLowerCase();
    const extent = /kebanyakan/.test(s) ? "Widespread" : /beberapa/.test(s) ? "Scattered" : /satu dua/.test(s) ? "Isolated" : "";
    if (/ribut petir/.test(s)) return { kind: "storm", en: `${extent} thunderstorms`.trim(), ms: t };
    if (/tiada hujan/.test(s) || /cerah/.test(s)) return { kind: "clear", en: "No rain", ms: t };
    if (/hujan/.test(s)) return { kind: "rain", en: `${extent} rain`.trim(), ms: t };
    if (/jerebu/.test(s)) return { kind: "haze", en: "Hazy", ms: t };
    if (/mendung|berawan/.test(s)) return { kind: "cloud", en: "Cloudy", ms: t };
    return { kind: "cloud", en: t || "--", ms: t };
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const ICONS = {
    clear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6" fill="#ffd23f"/><g stroke="#ffd23f" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18.5h10.2a3.8 3.8 0 0 0 .4-7.6 5.6 5.6 0 0 0-10.8 1.4A3.1 3.1 0 0 0 7 18.5Z" fill="#fff"/></svg>',
    rain:  '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.2a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.8 8.3 3.1 3.1 0 0 0 7 14.5Z" fill="#fff"/><g stroke="#7cc4ff" stroke-width="1.8" stroke-linecap="round"><path d="m8.5 17-1 3M12.5 17l-1 3M16.5 17l-1 3"/></g></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M7 14.5h10.2a3.8 3.8 0 0 0 .4-7.6A5.6 5.6 0 0 0 6.8 8.3 3.1 3.1 0 0 0 7 14.5Z" fill="#fff"/><path d="M12.6 14 10 18.2h2.6L11.4 22l3.8-5.2h-2.6l1.2-2.8Z" fill="#ffd23f"/></svg>',
    haze:  '<svg viewBox="0 0 24 24"><g stroke="#e6d8b8" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 8h17M5.5 12h13M3.5 16h17M7.5 20h9"/></g></svg>'
  };

  const PERIODS = [
    { key: "morning",   en: "morning",   ms: "Pagi" },
    { key: "afternoon", en: "afternoon", ms: "Petang" },
    { key: "night",     en: "evening",   ms: "Malam" }
  ];
  // Before noon (including pre-dawn) counts as the morning slot.
  const periodIndexNow = () => { const h = new Date().getHours(); return h < 12 ? 0 : h < 19 ? 1 : 2; };

  const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function forecastFor(s) {
    const f = state.data?.forecasts?.[s.forecastKey];
    return f && Array.isArray(f.days) ? f : null;
  }
  function todayIndex(days) {
    const t = localISO(new Date());
    const i = days.findIndex((d) => d.date >= t);
    return i >= 0 ? i : 0;
  }

  function notice(msg) {
    const n = $("notice");
    n.textContent = msg || "";
    n.hidden = !msg;
  }

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
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 }
      );
    });
  }

  function stations() {
    return (state.data?.stations || []).filter((s) => Number.isFinite(s.api));
  }

  function byDistanceFrom(origin) {
    return stations()
      .map((s) => ({ s, d: km(origin, s) }))
      .sort((a, b) => a.d - b.d);
  }

  /* ---------- render ---------- */
  function render() {
    const s = state.current;
    if (!s) return;
    const band = bandFor(s.api);
    document.body.dataset.cat = band.key;

    const origin = state.coords || s;
    const dist = state.coords ? km(state.coords, s) : null;

    $("placeName").textContent = s.name;
    $("placeSub").textContent = dist != null
      ? `${s.state} · nearest station, ${fmtKm(dist)} away`
      : s.state;
    $("apiValue").textContent = s.api;
    $("catLabel").textContent = `${band.label} · ${band.ms}`;
    $("heroMeta").textContent = timeAgo(state.data.updated);

    $("pollutant").textContent = s.pollutant || "--";
    $("pollutantNote").textContent = POLLUTANT_NOTES[s.pollutant] || "Pollutant with the highest sub-index";

    renderTrend(s);
    renderRun(s, band);
    renderForecast(s);
    renderChart(s.history || []);
    $("advice").textContent = band.advice;
    renderScale(band);
    renderNear(origin);
    renderAll($("search").value);

    $("sourceNote").textContent = state.data.sample
      ? "Showing sample data. Run the fetch script to load live DOE readings."
      : "Air quality: Department of Environment Malaysia (APIMS), hourly.";
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
    const p = PERIODS[pi], w = weather(day[p.key]);
    const when = pi === 0 && new Date().getHours() < 12 ? "this morning" : pi === 1 ? "this afternoon" : "this evening";
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

  // Next slot (today or later) with no rain or storms in the forecast.
  function nextDryWindow(days, startDay, startPeriod) {
    for (let d = startDay; d < Math.min(days.length, startDay + 3); d++) {
      for (let p = d === startDay ? startPeriod : 0; p < 3; p++) {
        if (weather(days[d][PERIODS[p].key]).kind === "clear") {
          const dayName = d === startDay ? (p === startPeriod ? "now" : "today") : d === startDay + 1 ? "tomorrow" : new Date(days[d].date).toLocaleDateString("en-MY", { weekday: "long" });
          return dayName === "now" ? null : `${dayName} ${PERIODS[p].en}`;
        }
      }
    }
    return null;
  }

  function renderRun(s, band) {
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

    const card = $("runCard");
    card.dataset.level = level;
    $("runBadge").textContent = level === "go" ? "Go run" : level === "care" ? "Run with care" : "Skip it";
    $("runVerdict").textContent = level === "go" ? "Good conditions for a run right now."
      : level === "care" ? "You can run, but adjust your plan."
      : airBad ? "Not a good time to run outside." : "Hold off for now.";

    $("runFactors").innerHTML = factors.map((f) =>
      `<li><span class="k">${f.k}</span><span class="v"><i style="background:${DOT[f.level]}"></i>${esc(f.text)}</span></li>`).join("");

    let best = "";
    if (airBad) best = "Run on a treadmill or do an indoor session. Head out again once the API is 100 or below.";
    else if (fc && level !== "go") {
      const w = nextDryWindow(fc.days, ti, pi);
      if (w) best = `Next dry window: ${w}. Check the API again before you head out.`;
    }
    if (!fc && !airBad) best = "No weather forecast for this station, so check the sky before you go.";
    $("runBest").textContent = best;
  }

  /* ---------- forecast ---------- */
  function bestRunSlot(day) {
    const dry = PERIODS.filter((p) => weather(day[p.key]).kind === "clear");
    if (!dry.length) return "Wet all day";
    if (dry.length === 3) return "Dry all day";
    return `Dry ${dry.map((p) => p.en).join(" & ")}`;
  }

  function renderForecast(s) {
    const fc = forecastFor(s);
    const list = $("forecast");
    if (!fc) {
      list.innerHTML = '<li><p class="small">No forecast available for this station.</p></li>';
      $("fcSource").textContent = "";
      return;
    }
    const ti = todayIndex(fc.days);
    list.innerHTML = fc.days.slice(ti, ti + 7).map((d, i) => {
      const w = weather(d.summary);
      const name = i === 0 ? "Today" : new Date(d.date + "T00:00:00").toLocaleDateString("en-MY", { weekday: "short" });
      const when = d.summary_when && w.kind !== "clear" ? ` (${String(d.summary_when).toLowerCase()})` : "";
      return `<li>
        <span class="day">${name}</span>
        <span class="ic" aria-hidden="true">${ICONS[w.kind]}</span>
        <span class="desc"><b>${esc(cap(w.en))}</b><span>${esc(bestRunSlot(d))} · ${esc(d.summary + when)}</span></span>
        <span class="tmp"><span>${d.min}°</span>${d.max}°</span>
      </li>`;
    }).join("");
    $("fcSource").textContent = `MET Malaysia forecast for ${fc.location}.`;
  }

  function renderTrend(s) {
    const h = s.history || [];
    if (h.length < 4) { $("trend").textContent = "--"; $("trendNote").textContent = "Not enough readings"; return; }
    const diff = h[h.length - 1] - h[h.length - 4];
    $("trend").textContent = diff > 3 ? "Rising" : diff < -3 ? "Falling" : "Steady";
    $("trendNote").textContent = `${diff > 0 ? "+" : ""}${diff} over the last 3 hours`;
  }

  function renderChart(hist) {
    const el = $("chart");
    if (!hist.length) { el.innerHTML = '<p class="small">No hourly history for this station.</p>'; return; }
    const W = 300, H = 110, top = 6;
    const max = Math.max(100, ...hist) * 1.08;
    const y = (v) => H - (v / max) * (H - top);
    const gap = 2, bw = (W - gap * (hist.length - 1)) / hist.length;

    const lines = [50, 100, 200, 300].filter((v) => v < max)
      .map((v) => `<line class="grid" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>` +
                  `<text class="gl" x="${W}" y="${y(v) - 3}" text-anchor="end">${v}</text>`).join("");

    const bars = hist.map((v, i) => {
      const x = i * (bw + gap), yy = y(v), last = i === hist.length - 1;
      return `<rect x="${x.toFixed(2)}" y="${yy.toFixed(2)}" width="${bw.toFixed(2)}" height="${(H - yy).toFixed(2)}"
        rx="${Math.min(3, bw / 2).toFixed(2)}" fill="${bandFor(v).color}" opacity="${last ? 1 : 0.7}"><title>${v}</title></rect>`;
    }).join("");

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Hourly API over the last 24 hours, from ${hist[0]} to ${hist[hist.length - 1]}">${lines}${bars}</svg>`;
  }

  function renderScale(active) {
    const ranges = ["0–50", "51–100", "101–200", "201–300", "300+"];
    $("scale").innerHTML = BANDS.map((b, i) =>
      `<div class="${b === active ? "on" : ""}"><i style="background:${b.color}"></i>${b.label}<br>${ranges[i]}</div>`
    ).join("");
  }

  function rowHTML(s, d) {
    const b = bandFor(s.api);
    const sub = d != null ? `${esc(s.state)} · ${fmtKm(d)}` : esc(s.state);
    const cur = state.current && state.current.id === s.id ? " current" : "";
    return `<li><button class="row${cur}" type="button" data-id="${esc(s.id)}">
      <span class="dot" style="background:${b.color}"></span>
      <span class="txt"><span class="nm">${esc(s.name)}</span><span class="st">${sub} · ${b.label}</span></span>
      <span class="val">${s.api}</span></button></li>`;
  }

  function renderNear(origin) {
    $("nearList").innerHTML = byDistanceFrom(origin).slice(0, 5)
      .map(({ s, d }) => rowHTML(s, state.coords ? km(state.coords, s) : (d > 0.01 ? d : null)))
      .join("");
  }

  function renderAll(q) {
    const needle = (q || "").trim().toLowerCase();
    const list = stations()
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.state.toLowerCase().includes(needle))
      .sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
    $("allList").innerHTML = list.length
      ? list.map((s) => rowHTML(s, state.coords ? km(state.coords, s) : null)).join("")
      : '<li><p class="small" style="padding:12px 0">No station matches that search.</p></li>';
  }

  /* ---------- flow ---------- */
  function choose(id, remember) {
    const s = stations().find((x) => x.id === id);
    if (!s) return;
    state.current = s;
    if (remember) store.set(id);
    render();
  }

  async function locate() {
    $("placeName").textContent = "Locating…";
    const coords = await getPosition();
    state.coords = coords;
    const list = stations();
    if (coords) {
      notice("");
      state.current = byDistanceFrom(coords)[0].s;
    } else {
      const saved = list.find((s) => s.id === store.get());
      state.current = saved || list.find((s) => s.name === "Cheras") || list[0];
      notice("Location is off, so this shows a chosen station. Allow location access, or pick a station under All stations.");
    }
    render();
  }

  async function refresh(keepStation) {
    try {
      state.data = await loadData();
    } catch {
      notice("Could not load air quality data. Check your connection and tap Refresh.");
      $("placeName").textContent = "No data";
      return;
    }
    if (keepStation && state.current) {
      const again = stations().find((s) => s.id === state.current.id);
      if (again) { state.current = again; render(); return; }
    }
    await locate();
  }

  /* ---------- events ---------- */
  const sheet = $("sheet");
  function openSheet() { sheet.hidden = false; $("search").value = ""; renderAll(""); setTimeout(() => $("search").focus(), 50); }
  function closeSheet() { sheet.hidden = true; }

  document.addEventListener("click", (e) => {
    const row = e.target.closest(".row[data-id]");
    if (row) { choose(row.dataset.id, true); closeSheet(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (e.target.closest("[data-close]")) closeSheet();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
  $("allBtn").addEventListener("click", openSheet);
  $("search").addEventListener("input", (e) => renderAll(e.target.value));
  $("locBtn").addEventListener("click", locate);
  $("refreshBtn").addEventListener("click", () => refresh(true));

  refresh(false);
  setInterval(() => refresh(true), REFRESH_MS);
})();
