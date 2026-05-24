/*
 * last-hour.js — loops the last 60 minutes of frames for a single camera.
 *
 * Reads window.__SKY = { camera: string } from templates/last_hour.html.
 * Public/kiosk view — no admin gate, no scrub bar. Click or press F to
 * toggle fullscreen. Publishes its state via SkyController for TV mirroring.
 */
(function () {
  'use strict';

  const ctx = window.__SKY || {};
  const CAMERA = ctx.camera;
  if (!CAMERA) return;

  const SP = window.SkyPlayback;
  const { imgUrl: _imgUrl, readableTs, describePartOfDay, PreloadCache } = SP;
  const imgUrl = (name) => _imgUrl(name, CAMERA);

  const FPS = 10;
  const WINDOW_MS = 60 * 60 * 1000;
  const camQS = `camera=${encodeURIComponent(CAMERA)}`;

  const img            = document.getElementById('frame');
  const stage          = document.getElementById('stage');
  const timeDescriptor = document.getElementById('timeDescriptor');
  const timeTs         = document.getElementById('timeTs');

  let frames = [];
  let idx = 0;
  let sunTimes = {};
  const cache = new PreloadCache({ camera: CAMERA, cap: 1200 });

  function updateTimeLabel(iso) {
    const day = iso.slice(0, 10);
    timeDescriptor.textContent = describePartOfDay(iso, sunTimes[day]);
    timeTs.textContent = readableTs(iso);
  }

  async function loadSunTimes() {
    try {
      const r = await fetch(`/api/anchors?${camQS}`);
      const data = await r.json();
      sunTimes = {};
      for (const d of data) sunTimes[d.day] = { sunrise: d.sunrise, sunset: d.sunset };
    } catch (e) { console.warn('sun times failed', e); }
  }

  async function loadFrames() {
    const r = await fetch(`/api/frames?${camQS}`);
    const all = await r.json();
    if (!all.length) { frames = []; return; }
    const lastMs = Date.parse(all[all.length - 1].ts);
    const cutoff = lastMs - WINDOW_MS;
    frames = all.filter((f) => Date.parse(f.ts) >= cutoff);
    if (idx >= frames.length) idx = Math.max(0, frames.length - 1);
    cache.preloadAll(frames);
  }

  function show(i) {
    if (!frames.length) return;
    idx = ((i % frames.length) + frames.length) % frames.length;
    const f = frames[idx];
    img.src = imgUrl(f.name);
    updateTimeLabel(f.ts);
    if (window.SkyController) {
      window.SkyController.publish({
        frame: f.name, ts: f.ts, camera: CAMERA, playing: true,
      });
    }
  }

  function tick() {
    if (!frames.length) return;
    idx = (idx + 1) % frames.length;
    show(idx);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  }

  stage.addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    e.preventDefault();
    toggleFullscreen();
  });

  (async () => {
    if (window.SkyController) await window.SkyController.init(CAMERA);
    await loadSunTimes();
    await loadFrames();
    if (frames.length) show(0);
    setInterval(tick, 1000 / FPS);
    setInterval(async () => { await loadSunTimes(); await loadFrames(); }, 30_000);
  })();
})();
