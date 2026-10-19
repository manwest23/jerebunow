#!/usr/bin/env node
/* JerebuNow · IQAir city snapshot for the map.
   Fetches a fixed list of cities from IQAir's official API (Community plan)
   and writes data/world.json. Runs every 3 hours on GitHub Actions so the
   map costs users no API calls. Calls are spaced to stay under 5 per minute.
   Key: IQAIR_KEY env var, otherwise the key in config.js. Node 18+. */
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../data/world.json", import.meta.url);
const CITIES = [
  // Malaysia (IQAir city readings, alongside DOE stations)
  ["Kuala Lumpur", 3.1390, 101.6869], ["Johor Bahru", 1.4927, 103.7414], ["George Town", 5.4141, 100.3288],
  ["Ipoh", 4.5975, 101.0901], ["Kota Kinabalu", 5.9804, 116.0735], ["Kuching", 1.5533, 110.3592],
  ["Melaka", 2.1896, 102.2501], ["Miri", 4.3995, 113.9914],
  // Neighbours (haze often drifts across borders)
  ["Singapore", 1.3521, 103.8198], ["Jakarta", -6.2088, 106.8456], ["Bangkok", 13.7563, 100.5018],
  ["Medan", 3.5952, 98.6722], ["Pekanbaru", 0.5071, 101.4478], ["Palembang", -2.9761, 104.7754],
  ["Pontianak", -0.0263, 109.3425], ["Bandar Seri Begawan", 4.9031, 114.9398]
];
const SPACING_MS = 13000;                       // 5 calls/minute limit
const POLLUTANT = { p2: "PM2.5", p1: "PM10", o3: "O3", n2: "NO2", s2: "SO2", co: "CO" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function key() {
  if (process.env.IQAIR_KEY) return process.env.IQAIR_KEY.trim();
  const cfg = await readFile(new URL("../config.js", import.meta.url), "utf8");
  return (cfg.match(/iqairKey:\s*"([^"]*)"/) || [])[1] || "";
}

async function main() {
  // Runs can be started both by GitHub's schedule and by the Worker: don't spend
  // IQAir calls twice in a row (free plan: 10,000 a month).
  if (!process.env.FORCE) {
    try {
      const prev = JSON.parse(await readFile(OUT, "utf8"));
      const mins = (Date.now() - new Date(prev.updated)) / 60000;
      if (mins < 150) { console.log(`IQAir cities refreshed ${Math.round(mins)} min ago; skipping.`); return; }
    } catch {}
  }
  const k = await key();
  if (!k) { console.log("No IQAir key; skipping."); return; }
  let prev = { places: [] };
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
  const prevByName = new Map((prev.places || []).map((p) => [p.label, p]));
  const places = [];
  let ok = 0;
  for (let i = 0; i < CITIES.length; i++) {
    const [label, lat, lon] = CITIES[i];
    if (i) await sleep(SPACING_MS);
    try {
      const res = await fetch(`https://api.airvisual.com/v2/nearest_city?lat=${lat}&lon=${lon}&key=${encodeURIComponent(k)}`);
      const body = await res.json();
      if (body.status !== "success") throw new Error(body?.data?.message || res.status);
      const d = body.data, p = d.current?.pollution || {}, w = d.current?.weather || {};
      const [clon, clat] = d.location?.coordinates || [lon, lat];
      if (!Number.isFinite(p.aqius)) throw new Error("no AQI");
      places.push({
        label, source: "iqair", name: label,             // familiar name (IQAir may name a district)
        state: [d.state, d.country].filter(Boolean).filter((v, j, a) => a.indexOf(v) === j).join(", "),
        country: d.country || "", lat: clat, lon: clon,
        api: p.aqius, pollutant: POLLUTANT[p.mainus] || null, readingTime: p.ts || null, history: [],
        weather: { tp: w.tp, hu: w.hu, ws: w.ws, ic: w.ic || "", ts: w.ts }
      });
      ok++;
    } catch (e) {
      console.warn(`${label}: ${e.message}`);
      const old = prevByName.get(label);
      if (old) places.push(old);                // keep the last good reading
    }
  }
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), source: "IQAir (US AQI)", places }, null, 1));
  console.log(`Wrote ${places.length} places (${ok} fresh)`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
