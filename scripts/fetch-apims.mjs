#!/usr/bin/env node
/* JerebuNow data job. Pulls the latest hourly readings from DOE's APIMS and
   the 7-day forecast from MET Malaysia (api.data.gov.my), then writes
   data/api.json in the shape the front end expects. Node 18+.

   Why a script instead of fetching from the browser: APIMS has no documented
   public JSON API and does not send CORS headers, so browsers block direct
   calls. Running this hourly (GitHub Actions, cron, or a serverless function)
   keeps a same-origin JSON file fresh.

   The endpoint below was confirmed in October 2026. If DOE changes it,
   find the new one like this:
   1. Open https://eqms.doe.gov.my/APIMS/main in Chrome.
   2. DevTools → Network → filter "Fetch/XHR", reload.
   3. Find the request that returns station readings as JSON
      (it usually goes through /api3/publicmapproxy/... and returns
      ArcGIS-style { features: [ { attributes, geometry } ] }).
   4. Put its URL in APIMS_URL below, or pass it as an env var:
        APIMS_URL="https://..." node scripts/fetch-apims.mjs
   5. Run once with DEBUG=1 to print the raw field names, then adjust FIELD
      if any of them differ.
*/
import { readFile, writeFile, mkdir } from "node:fs/promises";

// Public APIMS endpoints behind https://eqms.doe.gov.my/APIMS/main
const APIMS_BASE = "https://eqms.doe.gov.my/api3/publicportalapims";
const APIMS_URL = process.env.APIMS_URL || `${APIMS_BASE}/mapcaqm`;
const OUT = new URL("../data/api.json", import.meta.url);
const HISTORY_HOURS = 24;
const FORECAST_URL = "https://api.data.gov.my/weather/forecast";

// Optional: pin a station to a specific MET location name (district or town).
// Otherwise a station uses a forecast location with the same name, then its state.
const FORECAST_OVERRIDES = {
  // "CA22B": "Hulu Langat",
};

// Candidate field names, checked in order (case-insensitive).
const FIELD = {
  id:        ["station_id", "stationid", "id", "objectid"],
  name:      ["station_location", "location", "station_name", "name", "lokasi"],
  state:     ["state_name", "state", "negeri"],
  stateId:   ["state_id", "stateid"],
  api:       ["api", "ipu", "api_value", "reading", "value"],
  pollutant: ["param_symbol", "pollutant", "parameter", "dominant", "pencemar"],
  lat:       ["latitude", "lat", "y"],
  lon:       ["longitude", "lon", "long", "lng", "x"],
  time:      ["record_dt", "datetime", "date_time", "time", "timestamp", "masa"]
};

function pick(obj, keys) {
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) if (lower[k] !== undefined && lower[k] !== null && lower[k] !== "") return lower[k];
  return undefined;
}

// APIMS often marks values like "87*" or "87a" (pollutant flags); keep the number.
const toNum = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// APIMS marks the dominant pollutant with a symbol.
const POLLUTANT_SYMBOLS = { "*": "PM10", "**": "PM2.5", "a": "SO2", "b": "NO2", "c": "O3", "d": "CO", "&": "Multiple" };
function pollutantName(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (POLLUTANT_SYMBOLS[s]) return POLLUTANT_SYMBOLS[s];
  return s.toUpperCase().replace("PM25", "PM2.5");
}

const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/\bIpd\b/, "IPD").replace(/\bIlp\b/, "ILP");

// "Cheras, W.P. KUALA LUMPUR" -> "Cheras"; "JOHAN SETIA" -> "Johan Setia"
function stationName(raw) {
  const s = String(raw || "").split(",")[0].trim();
  return s === s.toUpperCase() ? titleCase(s) : s;
}
// "WP Kuala Lumpur" -> "Kuala Lumpur"
const stateName = (raw) => String(raw || "").replace(/^W\.?\s*P\.?\s+/i, "").trim();

function normalise(raw) {
  const rows = Array.isArray(raw) ? raw
    : raw.features ? raw.features.map((f) => ({ ...f.attributes, ...(f.geometry ? { x: f.geometry.x, y: f.geometry.y } : {}) }))
    : raw.data || raw.stations || [];

  return rows.filter((r) => String(pick(r, ["station_status"]) ?? "1") === "1").map((r) => {
    const api = toNum(pick(r, FIELD.api));
    return {
      id: String(pick(r, FIELD.id) ?? pick(r, FIELD.name)),
      name: stationName(pick(r, FIELD.name)),
      state: stateName(pick(r, FIELD.state)),
      stateId: pick(r, FIELD.stateId) ?? null,
      lat: toNum(pick(r, FIELD.lat)),
      lon: toNum(pick(r, FIELD.lon)),
      api: api != null && api >= 0 ? api : null,   // negative = station offline
      pollutant: pollutantName(pick(r, FIELD.pollutant)),
      time: pick(r, FIELD.time) ?? null
    };
  }).filter((s) => s.name && s.lat != null && s.lon != null);
}

// Best effort: fill a station's last 24 hours on its first run.
// Keeps only rows for the requested station, so a wrong response is ignored.
async function backfillHistory(s) {
  if (!s.stateId || !s.time) return null;
  const url = `${APIMS_BASE}/datatrendchart?stateid=${s.stateId}&stationid=${encodeURIComponent(s.id)}&datetime=${encodeURIComponent(s.time)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = await res.json();
    const rows = (json.highcharts_bar || json.data || []).filter((r) => r.STATION_ID === s.id);
    if (rows.length < 2) return null;
    return rows.sort((a, b) => String(a.DATETIME).localeCompare(String(b.DATETIME)))
      .map((r) => toNum(r.API)).filter((v) => v != null && v >= 0);
  } catch { return null; }
}


const clean = (s) => String(s || "").toLowerCase()
  .replace(/^(w\.?\s*p\.?|wilayah persekutuan)\s*/, "").replace(/[^a-z ]/g, "").trim();

// MET forecast: one record per location per day. Group by location name.
async function fetchForecasts() {
  const groups = {};
  for (const prefix of ["St", "Ds", "Tn"]) {
    const url = `${FORECAST_URL}?contains=${prefix}@location__location_id&limit=5000`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) { console.warn(`Forecast ${prefix}: HTTP ${res.status}`); continue; }
      for (const r of await res.json()) {
        const name = r.location?.location_name;
        if (!name) continue;
        // A name can exist as both a state and a district; keep the first type seen.
        const g = (groups[name] ??= { location: name, type: prefix, id: r.location?.location_id, days: [] });
        if (g.id !== r.location?.location_id) continue;
        if (g.days.some((d) => d.date === r.date)) continue;
        g.days.push({
          date: r.date,
          morning: r.morning_forecast, afternoon: r.afternoon_forecast, night: r.night_forecast,
          summary: r.summary_forecast, summary_when: r.summary_when,
          min: r.min_temp, max: r.max_temp
        });
      }
    } catch (e) { console.warn(`Forecast ${prefix}: ${e.message}`); }
  }
  for (const g of Object.values(groups)) g.days.sort((a, b) => a.date.localeCompare(b.date));
  return groups;
}

function forecastKeyFor(station, groups) {
  const names = Object.keys(groups);
  const want = FORECAST_OVERRIDES[station.id];
  if (want && groups[want]) return want;
  const byName = names.find((n) => groups[n].type !== "St" && clean(n) === clean(station.name));
  if (byName) return byName;
  const byState = names.find((n) => groups[n].type === "St" && clean(n) === clean(station.state));
  return byState || null;
}

async function main() {
  const res = await fetch(APIMS_URL, {
    headers: { "Accept": "application/json", "User-Agent": "JerebuNow/1.0 (+personal project)" }
  });
  if (!res.ok) throw new Error(`APIMS responded ${res.status}`);
  const raw = await res.json();

  if (process.env.DEBUG) {
    const sample = raw.features?.[0]?.attributes ?? raw.data?.[0] ?? (Array.isArray(raw) ? raw[0] : raw);
    console.log("Raw fields:", Object.keys(sample || {}));
  }

  const fresh = normalise(raw);
  if (!fresh.length) throw new Error("No stations parsed. Run with DEBUG=1 and update FIELD.");

  // Merge with the previous file to keep a rolling 24-hour history.
  let prev = { stations: [] };
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
  const prevById = new Map((prev.sample ? [] : prev.stations).map((s) => [s.id, s]));
  const sameHour = prev.updated && new Date(prev.updated).getHours() === new Date().getHours()
    && Date.now() - new Date(prev.updated) < 3600_000;

  const stations = [];
  let backfilled = 0;
  for (const s of fresh) {
    const old = prevById.get(s.id);
    let history = old?.history ? [...old.history] : [];
    if (history.length < 6) {
      const filled = await backfillHistory(s);
      if (filled && filled.length) { history = filled; backfilled++; }
      else if (s.api != null) history.push(s.api);
    } else if (s.api != null) {
      if (sameHour) history[history.length - 1] = s.api;
      else history.push(s.api);
    }
    history = history.slice(-HISTORY_HOURS);
    const { time, stateId, ...rest } = s;
    stations.push({ ...rest, readingTime: time, history });
  }
  if (backfilled) console.log(`Backfilled 24h history for ${backfilled} stations`);

  // Forecast is optional: if MET is down, keep the previous one.
  let groups = await fetchForecasts();
  if (!Object.keys(groups).length && prev.forecasts && !prev.sample) groups = prev.forecasts;
  const forecasts = {};
  for (const s of stations) {
    const key = forecastKeyFor(s, groups);
    s.forecastKey = key;
    if (key) forecasts[key] = groups[key];
  }

  const out = {
    updated: new Date().toISOString(),
    source: "Air: DOE Malaysia APIMS (eqms.doe.gov.my). Forecast: MET Malaysia (api.data.gov.my)",
    sample: false,
    stations,
    forecasts
  };
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${stations.length} stations at ${out.updated}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
