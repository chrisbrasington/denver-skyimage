/*
 * last-live.js — shows the single newest frame for a camera, polled every 30s.
 *
 * Reads window.__SKY = { camera: string } from templates/last_live.html.
 * Public/kiosk view — no admin gate, no scrub bar. Press F or click to
 * toggle fullscreen. Publishes its state via SkyController for TV mirroring.
 */
(function () {
  'use strict';

  const ctx = window.__SKY || {};
  const CAMERA = ctx.camera;
  if (!CAMERA) return;

  const SP = window.SkyPlayback;
  const { imgUrl: _imgUrl, readableTs, describePartOfDay } = SP;
  const camQS = `camera=${encodeURIComponent(CAMERA)}`;

  const img            = document.getElementById('frame');
  const stage          = document.getElementById('stage');
  const timeDescriptor = document.getElementById('timeDescriptor');
  const timeTs         = document.getElementById('timeTs');

  let sunTimes = {};
  let currentName = null;

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

  async function refreshLatest() {
    try {
      const r = await fetch(`/api/latest/${encodeURIComponent(CAMERA)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      if (data.name === currentName) return;
      currentName = data.name;
      img.src = _imgUrl(data.name, CAMERA);
      updateTimeLabel(data.ts);
      if (window.SkyController) {
        window.SkyController.publish({
          frame: data.name, ts: data.ts, camera: CAMERA, playing: true,
        });
      }
    } catch { /* swallow */ }
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
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    toggleFullscreen();
  });

  (async () => {
    if (window.SkyController) await window.SkyController.init(CAMERA);
    await loadSunTimes();
    await refreshLatest();
    setInterval(refreshLatest, 30_000);
    setInterval(loadSunTimes, 30 * 60 * 1000);
  })();
})();
