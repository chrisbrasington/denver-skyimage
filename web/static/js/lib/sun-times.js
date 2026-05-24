/*
 * sun-times.js — small loader for /api/anchors (sunrise/sunset).
 *
 * Used by index, live, split, last_hour. Exposes a single async helper that
 * returns `{sunrise: 'HH:MM', sunset: 'HH:MM', ...}` or null on failure.
 */
(function () {
  'use strict';

  async function load(camera) {
    try {
      const url = camera
        ? `/api/anchors?camera=${encodeURIComponent(camera)}`
        : '/api/anchors';
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  window.SkySunTimes = { load };
})();
