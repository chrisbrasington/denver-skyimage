/*
 * camera-switcher.js — floating camera selector mounted on live and index.
 *
 * mount(el, opts) replaces el's contents with one button per camera. The
 * caller supplies `hrefFor(cameraName)` so each page can route differently
 * (e.g. live links to /touch/<name>, index links to /camera/<name>).
 */
(function () {
  'use strict';

  function mount(el, opts) {
    if (!el) return;
    const cameras = opts.cameras || [];
    const current = opts.current || null;
    const hrefFor = opts.hrefFor || ((name) => `/camera/${encodeURIComponent(name)}`);

    el.innerHTML = '';
    if (cameras.length < 2) return;  // no switcher when only one camera

    for (const cam of cameras) {
      const btn = document.createElement('a');
      btn.href = hrefFor(cam.name);
      btn.className = 'camera-switcher-btn';
      btn.textContent = cam.label || cam.alias || cam.name;
      if (cam.name === current) btn.classList.add('active');

      // wrap as <button>-like element (uses theme button styling via parent CSS)
      const wrap = document.createElement('button');
      wrap.type = 'button';
      wrap.className = cam.name === current ? 'active' : '';
      wrap.textContent = btn.textContent;
      wrap.addEventListener('click', () => { window.location.href = btn.href; });
      el.appendChild(wrap);
    }
  }

  window.SkyCameraSwitcher = { mount };
})();
