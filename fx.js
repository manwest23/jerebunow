/* JerebuNow weather effects, drawn over the haze-coloured sky.
   Sun, moon and stars, clouds and haze are CSS (cheap transforms). Rain and
   thunderstorms use one shared <canvas> that runs only on the page you are
   looking at, and pauses when the page is hidden. Honors reduced motion. */
window.JerebuFX = (() => {
  "use strict";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Small seeded random so a page's stars and clouds don't jump on re-render
  function rng(seed) {
    let s = 0;
    for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function stars(r, n) {
    let out = "";
    for (let i = 0; i < n; i++) {
      const sz = r() < 0.15 ? 3 : 2;
      out += `<i style="left:${(r() * 100).toFixed(1)}%;top:${(r() * 55).toFixed(1)}%;width:${sz}px;height:${sz}px;animation-delay:${(r() * 4).toFixed(2)}s;animation-duration:${(2.5 + r() * 3).toFixed(2)}s;opacity:${(0.35 + r() * 0.55).toFixed(2)}"></i>`;
    }
    return `<div class="fx-stars">${out}</div>`;
  }

  function clouds(r, n, tone) {
    let out = "";
    for (let i = 0; i < n; i++) {
      const top = -6 + i * (34 / n) + r() * 8;
      const left = -30 + r() * 60;
      const scale = 0.8 + r() * 0.7;
      const dur = 70 + r() * 70;
      out += `<span class="fx-cloud ${tone}" style="top:${top.toFixed(1)}%;left:${left.toFixed(1)}%;--s:${scale.toFixed(2)};animation-duration:${dur.toFixed(0)}s;animation-delay:-${(r() * dur).toFixed(0)}s"></span>`;
    }
    return out;
  }

  const fog = (n) => Array.from({ length: n }, (_, i) =>
    `<span class="fx-fog" style="top:${18 + i * 22}%;animation-duration:${38 + i * 14}s;animation-delay:-${i * 9}s"></span>`).join("");

  /**
   * kind: storm | rain | snow | clear | cloud | haze | none
   * night: boolean; hazy: 0 (clean), 1 (moderate), 2 (unhealthy or worse)
   */
  function markup(kind, night, hazy, seed) {
    const r = rng(seed + kind + night);
    let parts = "";
    if (kind === "clear") {
      parts = night ? `${stars(r, 46)}<div class="fx-moon"></div>`
        : `<div class="fx-sun"><i class="glow"></i><i class="rays"></i><i class="disc"></i></div>`;
    } else if (kind === "cloud") {
      parts = (night ? stars(r, 18) : `<div class="fx-sun peek"><i class="glow"></i><i class="disc"></i></div>`) + clouds(r, 5, night ? "night" : "");
    } else if (kind === "haze") {
      parts = (night ? "" : `<div class="fx-sun dim"><i class="glow"></i><i class="disc"></i></div>`) + fog(4);
    } else if (kind === "rain") {
      parts = clouds(r, 4, "dark") + `<canvas class="fx-drops" data-intensity="1"></canvas>`;
    } else if (kind === "snow") {
      parts = clouds(r, 3, night ? "night" : "") + `<canvas class="fx-drops" data-intensity="0.9" data-mode="snow"></canvas>`;
    } else if (kind === "storm") {
      parts = clouds(r, 5, "dark") + `<canvas class="fx-drops" data-intensity="1.7"></canvas>`
        + `<div class="fx-flash" style="animation-delay:-${(r() * 9).toFixed(1)}s"></div>`;
    }
    const smog = hazy ? `<div class="fx-smog l${hazy}"></div>` : "";
    return `<div class="fx wx-${kind}${night ? " is-night" : ""}" aria-hidden="true">${parts}${smog}</div>`;
  }

  /* ---------- rain canvas ---------- */
  let canvas = null, ctx = null, drops = [], raf = 0, last = 0, running = false, W = 0, H = 0, dpr = 1, intensity = 1, mode = "rain";

  function size() {
    if (!canvas) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((W * H) / (mode === "snow" ? 7000 : 5200) * intensity);
    drops = Array.from({ length: n }, () => newDrop(true));
  }
  function newDrop(anywhere) {
    const z = Math.random();                         // depth: 0 far .. 1 near
    if (mode === "snow") return {
      x: Math.random() * W, y: anywhere ? Math.random() * H : -10 - Math.random() * 40,
      r: 1 + z * 2.6, v: 30 + z * 70, a: 0.35 + z * 0.5, ph: Math.random() * 6.28, sw: 10 + z * 22
    };
    return {
      x: Math.random() * (W + 80) - 40,
      y: anywhere ? Math.random() * H : -20 - Math.random() * 80,
      len: 10 + z * 16 * intensity,
      v: (520 + z * 620) * (0.85 + intensity * 0.15),
      a: 0.16 + z * 0.32,
      w: 0.6 + z * 0.9
    };
  }
  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    ctx.clearRect(0, 0, W, H);
    if (mode === "snow") { drawSnow(dt, t); raf = requestAnimationFrame(frame); return; }
    const slant = 0.18;
    for (const d of drops) {
      d.y += d.v * dt; d.x += d.v * dt * slant;
      if (d.y - d.len > H) Object.assign(d, newDrop(false));
      ctx.strokeStyle = `rgba(200,220,255,${d.a})`;
      ctx.lineWidth = d.w;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * slant, d.y - d.len);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }
  function drawSnow(dt, t) {
    for (const d of drops) {
      d.y += d.v * dt;
      const x = d.x + Math.sin(t / 1400 + d.ph) * d.sw;
      if (d.y - d.r > H) Object.assign(d, newDrop(false));
      ctx.fillStyle = `rgba(255,255,255,${d.a})`;
      ctx.beginPath(); ctx.arc(x, d.y, d.r, 0, 6.2832); ctx.fill();
    }
  }
  function start() {
    if (!canvas || running) return;
    if (reduce.matches) { drawStill(); return; }
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }
  function drawStill() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (mode === "snow") { drawSnow(0, 0); return; }
    for (const d of drops) {
      ctx.strokeStyle = `rgba(200,220,255,${d.a})`; ctx.lineWidth = d.w;
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - d.len * 0.18, d.y - d.len); ctx.stroke();
    }
  }

  // Point the renderer at the visible page (or nothing).
  function activate(slide) {
    const c = slide ? slide.querySelector("canvas.fx-drops") : null;
    if (c === canvas) { if (c && !running && !document.hidden && !paused) start(); return; }
    stop();
    canvas = c; ctx = c ? c.getContext("2d") : null;
    if (!c) return;
    intensity = parseFloat(c.dataset.intensity) || 1;
    mode = c.dataset.mode === "snow" ? "snow" : "rain";
    size();
    if (!document.hidden && !paused) start();
  }
  let paused = false;
  function pause() { paused = true; stop(); }
  function resume() { paused = false; if (!document.hidden) start(); }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : !paused && start()));
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (canvas) { size(); if (running) return; drawStill(); } }, 150); });

  return { markup, activate, pause, resume };
})();
