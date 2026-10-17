#!/usr/bin/env node
/* JerebuNow · fire hotspots for the map.
   NASA FIRMS publishes free 24-hour hotspot files per region (no key).
   We keep South East Asia around Malaysia, drop low-confidence detections,
   and group nearby points into 0.1° cells so the file stays small.
   Writes data/fires.json. Node 18+. */
import { writeFile } from "node:fs/promises";

const OUT = new URL("../data/fires.json", import.meta.url);
const FEEDS = [
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_24h.csv",
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv"
];
const BOX = { w: 94, e: 120, s: -7, n: 9 };          // Sumatra, Kalimantan, Malaysia, southern Thailand
const CELL = 0.1;

function parse(csv) {
  const [head, ...rows] = csv.trim().split(/\r?\n/);
  const cols = head.split(",");
  const ix = (k) => cols.indexOf(k);
  const iLat = ix("latitude"), iLon = ix("longitude"), iConf = ix("confidence"), iFrp = ix("frp"), iDate = ix("acq_date"), iTime = ix("acq_time");
  return rows.map((r) => r.split(",")).map((c) => ({
    lat: +c[iLat], lon: +c[iLon], conf: String(c[iConf] || "").toLowerCase(), frp: +c[iFrp] || 0,
    t: c[iDate] && c[iTime] ? `${c[iDate]}T${String(c[iTime]).padStart(4, "0").replace(/(\d\d)(\d\d)/, "$1:$2")}:00Z` : null
  }));
}

async function main() {
  const cells = new Map();
  let total = 0, feedsOk = 0, latest = null;
  for (const url of FEEDS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      feedsOk++;
      for (const f of parse(await res.text())) {
        if (!(f.lat >= BOX.s && f.lat <= BOX.n && f.lon >= BOX.w && f.lon <= BOX.e)) continue;
        if (f.conf === "low" || f.conf === "l") continue;
        total++;
        if (f.t && (!latest || f.t > latest)) latest = f.t;
        const k = `${Math.floor(f.lat / CELL)},${Math.floor(f.lon / CELL)}`;
        const c = cells.get(k) || { lat: 0, lon: 0, n: 0, frp: 0 };
        c.lat += f.lat; c.lon += f.lon; c.n++; c.frp += f.frp;
        cells.set(k, c);
      }
    } catch (e) { console.warn(`${url}: ${e.message}`); }
  }
  if (!feedsOk) throw new Error("No FIRMS feed reachable");
  const points = [...cells.values()].map((c) => ({
    lat: +(c.lat / c.n).toFixed(3), lon: +(c.lon / c.n).toFixed(3), n: c.n, frp: Math.round(c.frp)
  })).sort((a, b) => b.frp - a.frp).slice(0, 4000);
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), latest, source: "NASA FIRMS VIIRS (24 h)", count: total, points }));
  console.log(`Wrote ${points.length} cells from ${total} hotspots`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
