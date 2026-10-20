/* JerebuNow alerts · Cloudflare Worker (free plan).
   - POST /subscribe    save a phone's push subscription + chosen station and rules
   - POST /unsubscribe  remove it
   - GET  /vapid        public key the app needs to subscribe
   - Cron (hourly)      read the latest DOE data and send a notification when a
                        station crosses a level someone asked about
   - POST /hit          visitor check-in {id}; returns { live, total }
   - GET  /stats        { live, total } without checking in
   - GET  /iq?lat=&lon= IQAir nearest city, shared by everyone in the same ~11 km
                        square for 1 hour (KV), so one call serves many users and
                        the key stays secret. Needs IQAIR_KEY (secret).
   - GET  /warnings     MET Malaysia weather warnings that are in force now
                        (from api.data.gov.my, cached 10 minutes)
   - Cron also starts the GitHub data jobs on time (GitHub's own schedule can
     run hours late on small repos). Optional: needs GH_TOKEN, a fine-grained
     token for this repo with "Actions: read and write".
   - Telegram (optional) daily 7 am summary by state, plus a post when a
                        state's worst reading crosses 100, 200 or 300.
                        Needs TG_TOKEN (secret, from @BotFather) and TG_CHAT
                        (e.g. @jerebunow) as variables.
   Needs one KV namespace bound as SUBS. Signing keys (VAPID) are created on
   first use and kept in KV, so there are no secrets to set up.
   Visitor counts need a D1 database bound as DB (tables are created
   automatically). IDs are random and anonymous; no IP or location is kept.
   Developed by manwest. */

const SITE = "https://jerebunow.online/";
// Read data straight from the repo so alerts keep working whatever the site address is.
const DATA_URL = "https://raw.githubusercontent.com/manwest23/jerebunow/main/data/api.json";
const MAX_SUBS = 5000;

const TEXT = {
  en: {
    above100: (n, v) => [`Unhealthy air in ${n}`, `API ${v}. Limit time outdoors and close your windows.`],
    above200: (n, v) => [`Very unhealthy air in ${n}`, `API ${v}. Stay indoors and wear an N95 mask if you go out.`],
    runOk: (n, v) => [`Good to run again in ${n}`, `API ${v}. The air is back to 100 or below.`],
    school: (n, v) => [`School closure level in ${n}`, `API ${v}. KPM closes schools above 180, so check your school's announcement.`],
    on: (n, v) => ["Haze alerts are on", `You'll be notified about ${n} (API ${v} now).`]
  },
  ms: {
    above100: (n, v) => [`Udara tidak sihat di ${n}`, `IPU ${v}. Hadkan masa di luar dan tutup tingkap.`],
    above200: (n, v) => [`Udara sangat tidak sihat di ${n}`, `IPU ${v}. Kekal di dalam rumah dan pakai pelitup N95 jika keluar.`],
    runOk: (n, v) => [`Sesuai berlari semula di ${n}`, `IPU ${v}. Udara kembali 100 atau ke bawah.`],
    school: (n, v) => [`Paras penutupan sekolah di ${n}`, `IPU ${v}. KPM menutup sekolah melebihi 180, jadi semak makluman sekolah anda.`],
    on: (n, v) => ["Amaran jerebu dihidupkan", `Anda akan dimaklumkan tentang ${n} (IPU ${v} sekarang).`]
  }
};
const RULES = ["above100", "above200", "runOk", "school"];

// Which levels a reading crossed going from prev to cur
function crossed(prev, cur) {
  const out = [];
  if (prev == null || cur == null) return out;
  if (prev <= 200 && cur > 200) out.push("above200");
  if (prev <= 180 && cur > 180) out.push("school");
  if (prev <= 100 && cur > 100) out.push("above100");
  if (prev > 100 && cur <= 100) out.push("runOk");
  return out;
}
// One notification per change: the most serious level this person asked for
const PRIORITY = ["above200", "school", "above100", "runOk"];
function pick(prev, cur, rules) {
  const hit = crossed(prev, cur).filter((r) => rules.includes(r));
  return PRIORITY.find((r) => hit.includes(r)) || null;
}

/* ---------- helpers ---------- */
const enc = new TextEncoder();
const b64u = {
  enc(buf) {
    let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function sha256Hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cors = (origin = "*") => ({
  "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type", "access-control-max-age": "86400", "vary": "origin"
});
const json = (body, status = 200, origin = "*") => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...cors(origin) }
});

/* ---------- VAPID keys (created once, stored in KV) ---------- */
async function vapid(env) {
  const saved = await env.SUBS.get("vapid", "json");
  if (saved) return saved;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = {
    publicKey: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey)
  };
  await env.SUBS.put("vapid", JSON.stringify(keys));
  return keys;
}
async function vapidHeader(keys, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

/* ---------- Web Push payload encryption (RFC 8291, aes128gcm) ---------- */
async function encryptPayload(sub, plaintext, salt = crypto.getRandomValues(new Uint8Array(16)), asKeys) {
  const uaPublic = b64u.dec(sub.keys.p256dh);
  const auth = b64u.dec(sub.keys.auth);
  const as = asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const data = concat(enc.encode(plaintext), new Uint8Array([2]));        // last-record delimiter
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const rs = new Uint8Array([0, 0, 16, 0]);                                // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(env, sub, message) {
  const keys = await vapid(env);
  const body = await encryptPayload(sub, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidHeader(keys, sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "21600",
      urgency: "high"
    },
    body
  });
  return res.status;
}

/* ---------- data ---------- */
async function readings() {
  const res = await fetch(DATA_URL + "?t=" + Date.now(), { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error("data " + res.status);
  const d = await res.json();
  const map = new Map();
  for (const s of d.stations || []) if (Number.isFinite(s.api)) map.set(s.id, { api: s.api, name: s.name });
  return map;
}
function message(lang, rule, name, api, station) {
  const [title, body] = (TEXT[lang] || TEXT.en)[rule](name, api);
  return { title, body, tag: `jerebunow-${station}`, url: SITE };
}

/* ---------- Visitor counter (D1) ----------
   visitors: one row per anonymous ID, with when it was last seen.
   counters: the running total of distinct visitors (so totals never need a
   full table scan). "Live" = seen in the last 5 minutes, read via an index. */
const LIVE_MS = 5 * 60 * 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS visitors_last_seen ON visitors (last_seen)"),
    db.prepare("CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
  ]);
  schemaReady = true;
}
async function visitorStats(env, id) {
  const db = env.DB;
  await ensureSchema(db);
  const now = Date.now();
  if (id) {
    const ins = await db.prepare("INSERT OR IGNORE INTO visitors (id, first_seen, last_seen) VALUES (?1, ?2, ?2)").bind(id, now).run();
    if (ins.meta && ins.meta.changes === 1) {
      await db.prepare("INSERT INTO counters (k, v) VALUES ('total', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1").run();
    } else {
      // Returning visitor: refresh at most once a minute to save writes
      await db.prepare("UPDATE visitors SET last_seen = ?2 WHERE id = ?1 AND last_seen < ?3").bind(id, now, now - 60000).run();
    }
  }
  const [live, total] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE last_seen > ?1").bind(now - LIVE_MS),
    db.prepare("SELECT v FROM counters WHERE k = 'total'")
  ]);
  const liveN = (live.results && live.results[0] && live.results[0].n) || 0;
  const totalN = (total.results && total.results[0] && total.results[0].v) || 0;
  return { live: Math.max(liveN, id ? 1 : 0), total: Math.max(totalN, liveN) };
}


/* ---------- MET Malaysia warnings ----------
   api.data.gov.my has no location field, so the app matches each warning to a
   page by the state names in its text. Times are Malaysia time without a zone. */
const WARN_URL = "https://api.data.gov.my/weather/warning";
const myt = (t) => (t && !/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? new Date(t + "+08:00") : new Date(t));
const mytStamp = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
async function metWarnings(now = new Date()) {
  const get = async (q) => {
    const r = await fetch(WARN_URL + q, { cf: { cacheTtl: 300 } });
    if (!r.ok) throw new Error("warning " + r.status);
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error("warning shape");
    return d;
  };
  let rows;
  try { rows = await get(`?limit=100&timestamp_start=${encodeURIComponent(mytStamp(now))}@valid_to`); }
  catch { rows = await get("?limit=200"); }        // filter unsupported: filter here instead
  const str = (v) => (typeof v === "string" ? v.trim().slice(0, 2000) : "");
  const seen = new Set();
  return rows
    .filter((w) => w && myt(w.valid_to) > now)
    .map((w) => ({
      issued: str(w.warning_issue && w.warning_issue.issued), from: str(w.valid_from), to: str(w.valid_to),
      title_en: str(w.warning_issue && w.warning_issue.title_en), title_bm: str(w.warning_issue && w.warning_issue.title_bm),
      heading_en: str(w.heading_en), heading_bm: str(w.heading_bm),
      text_en: str(w.text_en), text_bm: str(w.text_bm),
      instruction_en: str(w.instruction_en), instruction_bm: str(w.instruction_bm)
    }))
    .filter((w) => { const k = w.title_en + w.from + w.text_en.slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => myt(b.issued) - myt(a.issued))
    .slice(0, 20);
}
async function warningsResponse(req, origin) {
  const cache = caches.default;
  const key = new Request("https://jerebunow-cache/warnings");
  const hit = await cache.match(key);
  if (hit) { const r = new Response(hit.body, hit); r.headers.set("access-control-allow-origin", origin); return r; }
  let body;
  try { body = { warnings: await metWarnings(), at: new Date().toISOString() }; }
  catch (e) { return json({ warnings: [], error: "met_unavailable" }, 200, origin); }
  const res = json(body, 200, origin);
  res.headers.set("cache-control", "public, max-age=600");
  await cache.put(key, res.clone());
  return res;
}


/* ---------- IQAir, shared cache ----------
   Everyone in the same 0.1° square (~11 km) shares one reading for an hour.
   Readings are kept for 24 h so a recent one can be shown if IQAir's limit
   (5 calls a minute, 10,000 a month) is hit. Stored in KV: global, and about
   one write per IQAir call. */
const IQ_FRESH_MS = 60 * 60 * 1000;
const iqInflight = new Map();
async function iqNearest(env, lat, lon) {
  if (!env.IQAIR_KEY) return { http: 503, body: { status: "fail", data: { message: "no_key" } } };
  const clat = Math.round(lat * 10) / 10, clon = Math.round(lon * 10) / 10;
  const kvKey = `iq:${clat.toFixed(1)},${clon.toFixed(1)}`;
  const rec = await env.SUBS.get(kvKey, "json");
  if (rec && Date.now() - rec.t < IQ_FRESH_MS) {
    return { http: 200, body: { status: "success", data: rec.d, cached: true, age: Math.round((Date.now() - rec.t) / 60000) } };
  }
  if (iqInflight.has(kvKey)) return iqInflight.get(kvKey);
  const job = (async () => {
    let message = "network";
    try {
      const r = await fetch(`https://api.airvisual.com/v2/nearest_city?lat=${clat}&lon=${clon}&key=${encodeURIComponent(env.IQAIR_KEY)}`);
      const b = await r.json().catch(() => null);
      if (b && b.status === "success" && b.data && b.data.current && b.data.current.pollution) {
        await env.SUBS.put(kvKey, JSON.stringify({ t: Date.now(), d: b.data }), { expirationTtl: 24 * 3600 });
        return { http: 200, body: { status: "success", data: b.data, cached: false } };
      }
      message = (b && b.data && b.data.message) || `http_${r.status}`;
    } catch { /* network */ }
    if (rec) return { http: 200, body: { status: "success", data: rec.d, cached: true, stale: true, age: Math.round((Date.now() - rec.t) / 60000) } };
    return { http: 502, body: { status: "fail", data: { message } } };
  })().finally(() => iqInflight.delete(kvKey));
  iqInflight.set(kvKey, job);
  return job;
}

/* ---------- HTTP ---------- */
async function handle(req, env) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "*";
  // Browser pre-check before a POST: an empty 204 (a 204 can't carry a body)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (url.pathname === "/vapid") return json({ publicKey: (await vapid(env)).publicKey }, 200, origin);
  if (url.pathname === "/warnings") return warningsResponse(req, origin);
  if (url.pathname === "/iq") {
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ status: "fail", data: { message: "bad_request" } }, 400, origin);
    const r = await iqNearest(env, lat, lon);
    const res = json(r.body, r.http, origin);
    if (r.http === 200) res.headers.set("cache-control", "public, max-age=300");
    return res;
  }

  if (url.pathname === "/hit" || url.pathname === "/stats") {
    if (!env.DB) return json({ error: "no_db" }, 503, origin);
    let id = null;
    if (req.method === "POST" && url.pathname === "/hit") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400, origin); }
      id = b && typeof b.id === "string" && ID_RE.test(b.id) ? b.id.toLowerCase() : null;
      if (!id) return json({ error: "bad_id" }, 400, origin);
    }
    try { return json(await visitorStats(env, id), 200, origin); }
    catch (e) { return json({ error: "db_error" }, 500, origin); }
  }

  if (req.method === "POST" && url.pathname === "/subscribe") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400, origin); }
    const sub = b && b.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000 ||
        !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return json({ error: "bad_subscription" }, 400, origin);
    const station = String(b.station || "").slice(0, 20);
    const rules = (Array.isArray(b.rules) ? b.rules : []).filter((r) => RULES.includes(r));
    const lang = b.lang === "ms" ? "ms" : "en";
    if (!station || !rules.length) return json({ error: "bad_request" }, 400, origin);
    let data; try { data = await readings(); } catch { return json({ error: "data_unavailable" }, 503, origin); }
    const cur = data.get(station);
    if (!cur) return json({ error: "unknown_station" }, 400, origin);
    const id = "sub:" + await sha256Hex(sub.endpoint);
    const exists = await env.SUBS.get(id);
    if (!exists) {
      const count = (await env.SUBS.get("count", "json")) || 0;
      if (count >= MAX_SUBS) return json({ error: "full" }, 503, origin);
      await env.SUBS.put("count", JSON.stringify(count + 1));
    }
    const record = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, station, rules, lang, last: cur.api, at: Date.now() };
    await env.SUBS.put(id, JSON.stringify(record));
    let push = null;
    if (b.confirm) { try { push = await sendPush(env, record.sub, message(lang, "on", cur.name, cur.api, station)); } catch (e) { push = String(e.message || e); } }
    return json({ ok: true, station, api: cur.api, push }, 200, origin);
  }

  if (req.method === "POST" && url.pathname === "/unsubscribe") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400, origin); }
    if (!b || typeof b.endpoint !== "string") return json({ error: "bad_request" }, 400, origin);
    const id = "sub:" + await sha256Hex(b.endpoint);
    if (await env.SUBS.get(id)) {
      await env.SUBS.delete(id);
      const count = (await env.SUBS.get("count", "json")) || 1;
      await env.SUBS.put("count", JSON.stringify(Math.max(0, count - 1)));
    }
    return json({ ok: true }, 200, origin);
  }
  return json({ name: "JerebuNow alerts", ok: true }, 200, origin);
}


/* ---------- Telegram channel ----------
   Daily summary at 7 am Malaysia time, and a post when a state's worst
   station moves into a new band (101+, 201+, 301+) or back to 100 or below.
   Going down needs a 10-point margin so a reading wobbling on a line doesn't
   post every hour. Band per state is kept in KV under "tg:bands". */
const TG_BANDS = [
  { max: 50, dot: "🟢", ms: "Baik", en: "Good" },
  { max: 100, dot: "🟡", ms: "Sederhana", en: "Moderate" },
  { max: 200, dot: "🟠", ms: "Tidak sihat", en: "Unhealthy" },
  { max: 300, dot: "🔴", ms: "Sangat tidak sihat", en: "Very unhealthy" },
  { max: Infinity, dot: "🟣", ms: "Berbahaya", en: "Hazardous" }
];
const tgBand = (v) => TG_BANDS.find((b) => v <= b.max);
const tgLevel = (v) => (v > 300 ? 3 : v > 200 ? 2 : v > 100 ? 1 : 0);   // alert levels
const escTG = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function worstByState(data) {
  const states = new Map();
  for (const [, s] of data) {
    if (!s.state) continue;
    const cur = states.get(s.state);
    if (!cur || s.api > cur.api) states.set(s.state, { api: s.api, name: s.name });
  }
  return states;
}

async function tgSend(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error("telegram " + res.status + " " + (await res.text()).slice(0, 200));
  return res.status;
}

function myTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kuala_Lumpur", hour: "numeric", hourCycle: "h23", weekday: "short", day: "numeric", month: "short"
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), label: new Intl.DateTimeFormat("ms-MY", { timeZone: "Asia/Kuala_Lumpur", weekday: "long", day: "numeric", month: "long" }).format(date) };
}

function tgSummary(states, now, morning) {
  const rows = [...states].sort((a, b) => b[1].api - a[1].api);
  const worst = rows[0];
  const lines = rows.map(([state, w]) => `${tgBand(w.api).dot} <b>${w.api}</b>  ${escTG(state)} <i>(${escTG(w.name)})</i>`);
  const unhealthy = rows.filter(([, w]) => w.api > 100).length;
  const head = unhealthy
    ? `⚠️ ${unhealthy} negeri tidak sihat · ${unhealthy} ${unhealthy === 1 ? "state" : "states"} unhealthy`
    : `✅ Semua negeri baik atau sederhana · All states good or moderate`;
  return [
    morning ? `🌫️ <b>Jerebu pagi ini · Haze this morning</b>` : `🌫️ <b>Jerebu sekarang · Haze right now</b>`,
    `${escTG(myTime(now).label)}`,
    ``,
    head,
    ``,
    ...lines,
    ``,
    `Bacaan tertinggi setiap negeri (IPU) · Worst reading per state (API)`,
    worst && worst[1].api > 180 ? `🏫 IPU melebihi 180: semak pengumuman penutupan sekolah. API above 180: check school closure notices.` : null,
    `📍 Lokasi anda · Your location: ${SITE}`
  ].filter((l) => l !== null).join("\n");
}

function tgChange(state, w, from, to) {
  const b = tgBand(w.api);
  const up = to > from;
  const icon = up ? (to >= 2 ? "🚨" : "⚠️") : "✅";
  const ms = up ? `${b.ms} di ${escTG(state)}` : `Udara kembali sederhana di ${escTG(state)}`;
  const en = up ? `${b.en} in ${escTG(state)}` : `Air back to moderate in ${escTG(state)}`;
  const tip = up
    ? (to >= 2 ? "Duduk di dalam rumah, pakai N95 jika keluar. Stay indoors, wear an N95 outside."
               : "Hadkan aktiviti luar. Limit time outdoors.")
    : "Sesuai berlari semula. OK to run again.";
  return `${icon} <b>${ms}</b>\n${en}\n${b.dot} IPU/API <b>${w.api}</b> · ${escTG(w.name)}\n${tip}`;
}

async function telegram(env, data, now = new Date()) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return { skipped: "not_configured" };
  // Don't post old readings (e.g. if the data job stopped)
  if (data.updated && now - new Date(data.updated) > 3 * 3600 * 1000) return { skipped: "stale" };
  const states = worstByState(data);
  if (!states.size) return { skipped: "no_data" };
  const out = { summary: false, changes: 0 };

  // Changes since last hour
  const saved = (await env.SUBS.get("tg:bands", "json")) || null;
  const bands = {};
  const changes = [];
  for (const [state, w] of states) {
    const prev = saved ? saved[state] : undefined;
    // Up as soon as a line is crossed; down only once 10 points below it
    const lvl = prev === undefined ? tgLevel(w.api) : Math.max(tgLevel(w.api), Math.min(prev, tgLevel(w.api + 10)));
    bands[state] = lvl;
    if (saved && prev !== undefined && lvl !== prev && (lvl > prev || lvl === 0)) changes.push(tgChange(state, w, prev, lvl));
  }
  const t = myTime(now);
  const firstRun = !(await env.SUBS.get("tg:hello"));
  if (t.hour === 7 || firstRun) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(now);   // Malaysian date
    if ((await env.SUBS.get("tg:day")) !== day || firstRun) {
      await tgSend(env, tgSummary(states, now, t.hour === 7));
      await env.SUBS.put("tg:day", day);
      if (firstRun) await env.SUBS.put("tg:hello", "1");
      out.summary = true;
    }
  }
  if (changes.length && !out.summary) {
    await tgSend(env, changes.slice(0, 6).join("\n\n") + `\n\n📍 ${SITE}`);
    out.changes = changes.length;
  }
  if (!saved || JSON.stringify(saved) !== JSON.stringify(bands)) await env.SUBS.put("tg:bands", JSON.stringify(bands));
  return out;
}


/* ---------- start the GitHub data jobs on time ---------- */
const GH_REPO = "manwest23/jerebunow";
async function dispatch(env, workflow) {
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28", "user-agent": "jerebunow-worker", "content-type": "application/json"
    },
    body: JSON.stringify({ ref: "main" })
  });
  return res.status;            // 204 = started
}
async function startJobs(env, when = new Date()) {
  if (!env.GH_TOKEN) return { skipped: "no_token" };
  const out = { api: await dispatch(env, "update-api.yml").catch((e) => String(e.message || e)) };
  if (when.getUTCHours() % 3 === 0) out.world = await dispatch(env, "update-world.yml").catch((e) => String(e.message || e));
  return out;
}

/* ---------- hourly check ---------- */
async function check(env) {
  const data = await readings();
  let tg = null;
  try { tg = await telegram(env, data); } catch (e) { tg = { error: String(e.message || e) }; }
  let cursor, sent = 0, removed = 0;
  do {
    const page = await env.SUBS.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, "json");
      if (!rec) continue;
      const cur = data.get(rec.station);
      if (!cur || cur.api === rec.last) continue;
      const rule = pick(rec.last, cur.api, rec.rules);
      const fire = rule ? [rule] : [];
      let gone = false;
      if (rule) {
        try {
          const status = await sendPush(env, rec.sub, message(rec.lang, rule, cur.name, cur.api, rec.station));
          if (status === 404 || status === 410) gone = true;
          else if (status < 300) sent++;
        } catch { /* try again next hour */ }
      }
      if (gone) {
        await env.SUBS.delete(k.name); removed++;
        const count = (await env.SUBS.get("count", "json")) || 1;
        await env.SUBS.put("count", JSON.stringify(Math.max(0, count - 1)));
        continue;
      }
      // Only write when the band side changes, to stay within KV's free writes
      const side = (v) => (v > 200 ? 3 : v > 180 ? 2 : v > 100 ? 1 : 0);
      if (side(cur.api) !== side(rec.last) || fire.length) { rec.last = cur.api; await env.SUBS.put(k.name, JSON.stringify(rec)); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, removed, tg };
}

export default {
  fetch: (req, env) => handle(req, env).catch((e) => json({ error: String(e.message || e) }, 500)),
  scheduled: (event, env, ctx) => ctx.waitUntil(Promise.all([
    check(env),
    startJobs(env, new Date(event.scheduledTime || Date.now())).catch(() => {})
  ]))
};
