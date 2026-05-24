/*
 * event-dialog.js — transient annotation bubble that appears above the image
 * stage when an event marker is hit during playback.
 *
 * Used by index and live. The bubble fades in, holds, then fades out on its
 * own; callers just call spawn() with the stage element, text, and x position
 * (in CSS pixels relative to the stage).
 */
(function () {
  'use strict';

  const SHOW_MS = 2200;
  const FADE_MS = 1500;

  function spawn(stage, text, xPx) {
    if (!stage || !text) return;
    const el = document.createElement('div');
    el.className = 'event-dialog';
    el.textContent = text;
    el.style.left = `${xPx}px`;
    el.style.top = '50%';
    stage.appendChild(el);

    requestAnimationFrame(() => el.classList.add('shown'));

    setTimeout(() => {
      el.classList.remove('shown');
      el.classList.add('fading');
      setTimeout(() => el.remove(), FADE_MS);
    }, SHOW_MS);
  }

  window.SkyEventDialog = { spawn };
})();
