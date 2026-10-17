/* JerebuNow map — Apple Weather style air quality map.
   Dark basemap (CARTO Dark Matter, OpenStreetMap data) drawn by MapLibre GL.
   The colour layer is interpolated (inverse-distance weighting) from DOE's
   station readings and fades out away from stations. A timeline replays the
   last 24 hours of readings. Loaded on first open by app.js. */
window.JerebuMap = (() => {
  "use strict";

  const LIB = window.JEREBU_MAPLIBRE_BASE || "https://unpkg.com/maplibre-gl@4.7.1/dist/";
  const STYLE = window.JEREBU_MAP_STYLE || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

  // Raster covering Peninsular Malaysia and Borneo (Sabah, Sarawak, Labuan)
  const W = 99.2, E = 119.8, N = 7.8, S = 0.4;
  const RES = 0.045;                                   // degrees per pixel
  const GW = Math.round((E - W) / RES), GH = Math.round((N - S) / RES);
  const REACH_KM = 95, FADE_KM = 55;                    // colour reach around stations

  // API -> colour (DOE bands, blended like Apple's heat maps)
  const STOPS = [
    [0, [58, 139, 234]], [50, [58, 139, 234]], [80, [63, 181, 96]], [100, [120, 196, 80]],
    [130, [242, 194, 48]], [200, [240, 138, 36]], [260, [229, 68, 58]], [320, [168, 40, 90]], [500, [110, 20, 60]]
  ];
  function colour(v) {
    for (let i = 1; i < STOPS.length; i++) {
      if (v <= STOPS[i][0]) {
        const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
        const t = (v - a) / (b - a || 1);
        return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
      }
    }
    return STOPS[STOPS.length - 1][1];
  }

  let root, ctx, map, canvas, c2d, imgData, markers = new Map(), meMarker = null;
  let step = 0, steps = 1, playing = false, playTimer = 0, openState = false, selected = null, built = false;
  const el = {};

  /* ---------- library ---------- */
  let libPromise;
  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((res, rej) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = LIB + "maplibre-gl.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = LIB + "maplibre-gl.js"; js.onload = res; js.onerror = rej;
      document.head.appendChild(js);
    });
    return libPromise;
  }

  /* ---------- UI shell ---------- */
  const PLAY = '<svg viewBox="0 0 18 18"><path d="M5 3.2v11.6c0 .6.6.9 1.1.6l9-5.8a.7.7 0 0 0 0-1.2l-9-5.8C5.6 2.3 5 2.6 5 3.2Z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 18 18"><rect x="4" y="3" width="3.6" height="12" rx="1.2"/><rect x="10.4" y="3" width="3.6" height="12" rx="1.2"/></svg>';

  function buildShell() {
    root.insertAdjacentHTML("beforeend", `
      <div class="map-canvas" id="mapCanvas"></div>
      <button class="map-float map-close" type="button" data-map="close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <button class="map-float map-loc" type="button" data-map="me"><svg viewBox="0 0 24 24"><path d="M20.5 3.5 3.5 10.8l7.2 1.8 1.8 7.2Z"/></svg></button>
      <div class="map-float map-legend" aria-hidden="true"><h3></h3><div class="lg"><i></i><ul></ul></div><p class="lg-src"></p></div>
      <div class="map-float map-card" aria-live="polite"></div>
      <div class="map-float timeline">
        <div class="tl-top">
          <button class="tl-play" type="button" data-map="play"></button>
          <div class="tl-title"><b></b><span></span></div>
          <span class="tl-now"></span>
        </div>
        <input class="tl-range" type="range" min="0" max="0" step="1" value="0">
        <div class="tl-ticks"></div>
        <p class="tl-note" hidden></p>
      </div>`);
    el.close = root.querySelector(".map-close");
    el.me = root.querySelector(".map-loc");
    el.legend = root.querySelector(".map-legend");
    el.card = root.querySelector(".map-card");
    el.play = root.querySelector(".tl-play");
    el.title = root.querySelector(".tl-title b");
    el.date = root.querySelector(".tl-title span");
    el.now = root.querySelector(".tl-now");
    el.range = root.querySelector(".tl-range");
    el.ticks = root.querySelector(".tl-ticks");
    el.note = root.querySelector(".tl-note");
    el.status = root.querySelector(".map-status");

    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-map]");
      if (!b) return;
      const a = b.dataset.map;
      if (a === "close") ctx.onClose();
      else if (a === "me") flyToMe();
      else if (a === "play") togglePlay();
      else if (a === "open" && selected) {
        const m = markers.get(selected);
        if (m && m.it && m.it.iq) ctx.onOpenWorld(m.it.s); else ctx.onOpen(selected);
      }
    });
    el.range.addEventListener("input", () => { stopPlay(); setStep(+el.range.value); });
  }

  function labels() {
    const t = ctx.t;
    el.close.setAttribute("aria-label", t.close);
    el.me.setAttribute("aria-label", t.showMyLocation);
    el.me.hidden = !ctx.coords;
    el.legend.querySelector("h3").textContent = t.mapTitle;
    el.legend.querySelector("ul").innerHTML = ctx.bands.slice().reverse().map((b) => `<li>${ctx.bandLabel(b)}</li>`).join("");
    const fireCount = (ctx.fires && ctx.fires.count) || 0;
    el.legend.querySelector(".lg-src").innerHTML = `<span><i class="k-doe"></i>${t.legendDoe}</span>` +
      ((ctx.world || []).length ? `<span><i class="k-iq"></i>${t.legendIQ}</span>` : "") +
      (fireCount ? `<span><i class="k-fire"><svg viewBox="0 0 24 30" aria-hidden="true"><path d="M12 1c3 7 10 11 9 19-.5 6-4.5 9-9 9s-8.5-3-9-8.5C2.5 15 7 13 8 7c2 3 2.5 6 2 8 3-3 3.5-9 2-14Z" fill="#ff7a1a" stroke="rgba(60,16,0,.5)"/><path d="M12 16c1.5 3.5 5 5.5 4.5 9.5-.3 2.5-2.2 3.5-4.5 3.5s-4.2-1-4.5-3.5c-.3-3 2-4 2.5-7 1 1.5 1.3 3 1 4 1.5-1.5 1.7-4.5 1-6.5Z" fill="#ffd84a"/></svg></i>${t.legendFires(fireCount)}</span>` : "");
    el.title.textContent = t.timelineTitle;
    el.range.setAttribute("aria-label", t.last24);
    root.setAttribute("aria-label", t.openMap);
    el.play.innerHTML = playing ? PAUSE : PLAY;
    el.play.setAttribute("aria-label", playing ? t.pause : t.play);
  }

  /* ---------- data per time step ---------- */
  // History arrays end at "now"; step k of (steps-1) is k hours after the oldest.
  function valueAt(s, k) {
    const h = s.history && s.history.length ? s.history : [s.api];
    const idx = h.length - (steps - k);
    return idx >= 0 ? h[idx] : null;
  }
  function stepTime(k) {
    const base = new Date(ctx.updated || Date.now());
    base.setMinutes(0, 0, 0);
    return new Date(base.getTime() - (steps - 1 - k) * 3600000);
  }

  /* ---------- colour raster ---------- */
  const cosLat = Math.cos(4 * Math.PI / 180);
  function drawRaster() {
    const pts = [];
    for (const s of ctx.stations) {
      const v = valueAt(s, step);
      if (v != null && v >= 0) pts.push([s.lon, s.lat, v]);
    }
    const d = imgData.data;
    const reach2 = REACH_KM * REACH_KM;
    for (let y = 0; y < GH; y++) {
      const lat = N - (y + 0.5) * RES;
      for (let x = 0; x < GW; x++) {
        const lon = W + (x + 0.5) * RES;
        let ws = 0, vs = 0, nearest = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const dx = (lon - pts[i][0]) * 111.32 * cosLat, dy = (lat - pts[i][1]) * 110.57;
          const d2 = dx * dx + dy * dy;
          if (d2 > reach2) continue;
          if (d2 < nearest) nearest = d2;
          const w = 1 / (d2 + 25);
          ws += w; vs += w * pts[i][2];
        }
        const o = (y * GW + x) * 4;
        if (!ws) { d[o + 3] = 0; continue; }
        const dist = Math.sqrt(nearest);
        const fade = dist < REACH_KM - FADE_KM ? 1 : Math.max(0, (REACH_KM - dist) / FADE_KM);
        const c = colour(vs / ws);
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
        d[o + 3] = Math.round(200 * fade * fade * (3 - 2 * fade));
      }
    }
    c2d.putImageData(imgData, 0, 0);
    const src = map && map.getSource("api");
    if (src) src.updateImage({ url: canvas.toDataURL() });
  }

  /* ---------- markers ---------- */
  // Everything with a bubble: DOE stations (Malaysian API) and IQAir cities (US AQI)
  function items() {
    const list = ctx.stations.map((s) => ({ key: s.id, s, iq: false }));
    for (const s of ctx.world || []) list.push({ key: "iq:" + s.lat.toFixed(2) + "," + s.lon.toFixed(2), s, iq: true });
    return list;
  }
  function syncMarkers() {
    const seen = new Set();
    for (const it of items()) {
      seen.add(it.key);
      let m = markers.get(it.key);
      if (!m) {
        const node = document.createElement("div");
        node.className = it.iq ? "mk iq" : "mk";
        node.innerHTML = `<b></b><em></em>`;
        const key = it.key;
        node.addEventListener("click", (e) => { e.stopPropagation(); select(key); });
        m = { node, marker: new maplibregl.Marker({ element: node, anchor: "bottom" }).setLngLat([it.s.lon, it.s.lat]).addTo(map) };
        markers.set(it.key, m);
      }
      m.it = it;
      m.node.lastChild.textContent = it.s.name;
      m.node.setAttribute("aria-label", it.s.name);
    }
    for (const [id, m] of markers) if (!seen.has(id)) { m.marker.remove(); markers.delete(id); }
    paintMarkers();
  }
  const nowStep = () => step === steps - 1;
  // IQAir cities have no hourly history here, so they show only at "Now"
  function valueOf(it) { return it.iq ? (nowStep() ? it.s.api : null) : valueAt(it.s, step); }
  function bandOfIt(it, v) { return it.iq ? ctx.usBandFor(v) : ctx.bandFor(v); }
  function paintMarkers() {
    for (const [key, m] of markers) {
      const it = m.it;
      if (!it) continue;
      const v = valueOf(it);
      m.node.hidden = v == null;
      if (v == null) continue;
      m.node.firstChild.textContent = v;
      m.node.style.setProperty("--c", bandOfIt(it, v).hex);
      m.node.classList.toggle("sel", key === selected);
    }
    declutter();
  }
  function syncMe() {
    if (!ctx.coords) { if (meMarker) { meMarker.remove(); meMarker = null; } return; }
    if (!meMarker) {
      const node = document.createElement("div");
      node.className = "me-dot";
      node.innerHTML = '<span class="me-label"></span>';
      meMarker = new maplibregl.Marker({ element: node }).setLngLat([ctx.coords.lon, ctx.coords.lat]).addTo(map);
    } else meMarker.setLngLat([ctx.coords.lon, ctx.coords.lat]);
    meMarker.getElement().querySelector(".me-label").textContent = ctx.t.myLocation;
  }
  // Apple-style decluttering: keep a bubble only where it doesn't overlap
  // another; the rest shrink to coloured dots. Centre-most stations win.
  const BUBBLE_GAP = 46;
  function declutter() {
    if (!map) return;
    const c = map.project(map.getCenter());
    const items = [];
    root.classList.toggle("names", map.getZoom() >= 8.2);
    for (const [key, m] of markers) {
      if (!m.it || m.node.hidden) continue;
      const p = map.project([m.it.s.lon, m.it.s.lat]);
      // DOE stations win ties near the centre; IQAir fills the gaps
      items.push({ m, p, pri: key === selected ? -1 : Math.hypot(p.x - c.x, p.y - c.y) + (m.it.iq ? 24 : 0) });
    }
    items.sort((a, b) => a.pri - b.pri);
    const placed = [];
    for (const it of items) {
      const free = placed.every((q) => Math.abs(q.x - it.p.x) > BUBBLE_GAP || Math.abs(q.y - it.p.y) > BUBBLE_GAP);
      if (free) placed.push(it.p);
      if (it.m.node.classList.contains("dot") === free) it.m.node.classList.toggle("dot", !free);
    }
  }

  /* ---------- selection card ---------- */
  function select(id) {
    selected = id;
    const m = markers.get(id), it = m && m.it;
    if (!it) return hideCard();
    const s = it.s;
    const v = valueOf(it) ?? s.api, b = bandOfIt(it, v);
    const label = it.iq ? `${ctx.usLabel(b)} · ${ctx.t.usAqi}` : `${ctx.bandLabel(b)} · ${ctx.t.api}`;
    el.card.innerHTML = `<span class="mc-api" style="background:${b.hex}">${v}</span>
      <span class="mc-txt"><b>${escapeHTML(s.name)}</b><span>${escapeHTML(s.state)}</span><span>${escapeHTML(label)}${it.iq ? " · IQAir" : ""}</span></span>
      <button class="pill" type="button" data-map="open">${ctx.t.open}</button>`;
    // Sit just above the timeline, whose height follows the text size
    const tl = root.querySelector(".timeline");
    el.card.style.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${(tl ? tl.offsetHeight : 130) + 26}px)`;
    el.card.classList.add("show");
    paintMarkers();
  }
  function hideCard() { selected = null; el.card.classList.remove("show"); paintMarkers(); }
  const escapeHTML = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- timeline ---------- */
  function setupTimeline() {
    steps = Math.min(24, Math.max(1, ...ctx.stations.map((s) => (s.history || []).length)));
    el.range.max = String(steps - 1);
    el.range.disabled = steps < 2;
    el.play.disabled = steps < 2;
    el.note.hidden = steps >= 6;
    el.note.textContent = ctx.t.noHistory;
    const t = ctx.t, marks = [];
    const n = Math.min(5, steps);
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0 : Math.round((i * (steps - 1)) / (n - 1));
      marks.push(`<span data-k="${k}">${k === steps - 1 ? t.now : String(stepTime(k).getHours()).padStart(2, "0")}</span>`);
    }
    el.ticks.innerHTML = marks.join("");
  }
  function setStep(k, skipRaster) {
    step = Math.max(0, Math.min(steps - 1, k));
    el.range.value = String(step);
    el.range.style.setProperty("--p", steps > 1 ? `${(step / (steps - 1)) * 100}%` : "100%");
    const t = stepTime(step);
    el.date.textContent = t.toLocaleDateString(ctx.t.locale, { weekday: "long", day: "numeric", month: "long" });
    el.now.textContent = step === steps - 1 ? ctx.t.now : `${String(t.getHours()).padStart(2, "0")}:00`;
    el.ticks.querySelectorAll("span").forEach((s) => s.classList.toggle("on", +s.dataset.k === step));
    if (!skipRaster) drawRaster();
    paintMarkers();
    if (selected) select(selected);
  }
  function togglePlay() { playing ? stopPlay() : startPlay(); }
  function startPlay() {
    if (steps < 2) return;
    playing = true; labels();
    if (step >= steps - 1) setStep(0);
    const tick = () => {
      if (!playing) return;
      if (step >= steps - 1) { stopPlay(); return; }
      setStep(step + 1);
      playTimer = setTimeout(tick, 650);
    };
    playTimer = setTimeout(tick, 450);
  }
  function stopPlay() { playing = false; clearTimeout(playTimer); if (el.play) labels(); }

  /* ---------- camera ---------- */
  function flyToMe() {
    if (!ctx.coords) return;
    map.flyTo({ center: [ctx.coords.lon, ctx.coords.lat], zoom: 8.6, speed: 1.4, essential: true });
  }
  function initialView() {
    if (ctx.coords) return { center: [ctx.coords.lon, ctx.coords.lat], zoom: 7.1 };
    return { center: [102.0, 4.2], zoom: 5.9 };
  }

  /* ---------- public ---------- */
  async function open(container, context) {
    root = container; ctx = context; openState = true;
    if (!built) {
      buildShell(); built = true;
      el.status.textContent = ctx.t.mapLoading;
    }
    labels();
    setupTimeline();
    await loadLib();
    if (!map) {
      canvas = document.createElement("canvas");
      canvas.width = GW; canvas.height = GH;
      c2d = canvas.getContext("2d");
      imgData = c2d.createImageData(GW, GH);
      step = steps - 1;
      setStep(step, true);
      drawRasterLocal();
      const v = initialView();
      map = new maplibregl.Map({
        container: root.querySelector("#mapCanvas"),
        style: STYLE,
        // Whole world: pan anywhere, zoom out to see all continents
        center: v.center, zoom: v.zoom, minZoom: 1, maxZoom: 13,
        renderWorldCopies: true,
        attributionControl: { compact: true },
        dragRotate: false, pitchWithRotate: false, touchPitch: false,
        fadeDuration: 150
      });
      map.touchZoomRotate.disableRotation();
      map.on("click", hideCard);
      map.on("moveend", declutter);
      map.on("load", () => {
        el.status.textContent = "";
        const before = firstLabelLayer();
        map.addSource("api", {
          type: "image", url: canvas.toDataURL(),
          coordinates: [[W, N], [E, N], [E, S], [W, S]]
        });
        map.addLayer({ id: "api", type: "raster", source: "api",
          paint: { "raster-opacity": 0.9, "raster-saturation": 0.25, "raster-resampling": "linear", "raster-fade-duration": 0 } }, before);
        // NASA FIRMS fire hotspots (24 h), as soft glowing points over the colour layer
        map.addSource("fires", { type: "geojson", data: firesGeoJSON() });
        map.addLayer({ id: "fires-glow", type: "circle", source: "fires", paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 4, ["min", 9, ["+", 3, ["*", 0.6, ["get", "n"]]]], 9, ["min", 22, ["+", 8, ["*", 1.2, ["get", "n"]]]]],
          "circle-color": "#ff7a1a", "circle-opacity": 0.22, "circle-blur": 0.9 } }, before);
        // Flame icons, bigger when zoomed in and for stronger fires (FRP)
        if (!map.hasImage("flame")) map.addImage("flame", flameImage(), { pixelRatio: 2 });
        map.addLayer({ id: "fires", type: "symbol", source: "fires", layout: {
          "icon-image": "flame", "icon-anchor": "bottom",
          "icon-allow-overlap": true, "icon-ignore-placement": true,
          "symbol-sort-key": ["get", "frp"],
          "icon-size": ["interpolate", ["linear"], ["zoom"],
            1, 0.12,
            3, ["*", 0.26, ["interpolate", ["linear"], ["get", "frp"], 0, 0.8, 300, 1.25]],
            4, ["*", 0.42, ["interpolate", ["linear"], ["get", "frp"], 0, 0.8, 300, 1.25]],
            7, ["*", 0.7, ["interpolate", ["linear"], ["get", "frp"], 0, 0.8, 300, 1.25]],
            10, ["*", 1.0, ["interpolate", ["linear"], ["get", "frp"], 0, 0.8, 300, 1.25]]]
        } }, before);
        syncMarkers(); syncMe(); declutter();
      });
      map.on("error", (e) => { if (!map.loaded() && String(e?.error?.message || "").match(/style|fetch/i)) el.status.textContent = ctx.t.mapError; });
    } else {
      map.resize();
      setStep(steps - 1);
      syncMarkers(); syncMe();
    }
  }
  // First draw before the source exists
  function drawRasterLocal() { const keep = map; map = null; drawRaster(); map = keep; }
  // Put the colour layer under place labels, like Apple's maps
  function firstLabelLayer() {
    const layers = map.getStyle().layers || [];
    const l = layers.find((x) => x.type === "symbol");
    return l ? l.id : undefined;
  }
  // A small flame drawn once on a canvas (24 x 30 points at 2x)
  function flameImage() {
    const w = 48, h = 60, c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const flame = (sx, sy, ox, oy) => {
      g.beginPath();
      g.moveTo(ox + 24 * sx, oy + 2 * sy);
      g.bezierCurveTo(ox + 30 * sx, oy + 16 * sy, ox + 44 * sx, oy + 24 * sy, ox + 42 * sx, oy + 40 * sy);
      g.bezierCurveTo(ox + 41 * sx, oy + 52 * sy, ox + 33 * sx, oy + 58 * sy, ox + 24 * sx, oy + 58 * sy);
      g.bezierCurveTo(ox + 15 * sx, oy + 58 * sy, ox + 7 * sx, oy + 52 * sy, ox + 6 * sx, oy + 41 * sy);
      g.bezierCurveTo(ox + 5 * sx, oy + 30 * sy, ox + 14 * sx, oy + 26 * sy, ox + 16 * sx, oy + 14 * sy);
      g.bezierCurveTo(ox + 20 * sx, oy + 20 * sy, ox + 21 * sx, oy + 26 * sy, ox + 20 * sx, oy + 30 * sy);
      g.bezierCurveTo(ox + 26 * sx, oy + 24 * sy, ox + 27 * sx, oy + 12 * sy, ox + 24 * sx, oy + 2 * sy);
      g.closePath();
    };
    let gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, "#ffb02e"); gr.addColorStop(1, "#e8380d");
    flame(1, 1, 0, 0); g.fillStyle = gr; g.fill();
    g.lineWidth = 2; g.strokeStyle = "rgba(60,16,0,.55)"; g.stroke();
    gr = g.createLinearGradient(0, 28, 0, h);
    gr.addColorStop(0, "#fff3a8"); gr.addColorStop(1, "#ffc93a");
    flame(0.5, 0.5, 12, 29); g.fillStyle = gr; g.fill();
    const d = g.getImageData(0, 0, w, h);
    return { width: w, height: h, data: new Uint8Array(d.data.buffer) };
  }
  function firesGeoJSON() {
    const pts = (ctx.fires && ctx.fires.points) || [];
    return { type: "FeatureCollection", features: pts.map((p) => ({ type: "Feature", properties: { n: p.n, frp: p.frp }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) };
  }
  function update(context) {
    ctx = context;
    if (!built) return;
    labels();
    const fs = map && map.getSource && map.getSource("fires");
    if (fs) fs.setData(firesGeoJSON());
    const atNow = step === steps - 1;
    setupTimeline();
    setStep(atNow ? steps - 1 : Math.min(step, steps - 1), !map);
    if (map && map.loaded()) { syncMarkers(); syncMe(); }
  }
  function close() { openState = false; stopPlay(); hideCardSafe(); }
  function hideCardSafe() { if (el.card) hideCard(); }
  const isOpen = () => openState;

  return { open, update, close, isOpen };
})();
