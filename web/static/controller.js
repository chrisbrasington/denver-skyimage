(function () {
  'use strict';

  const KEY = 'controller_id';
  let id = null;
  let lastFrame = null;
  let lastPublishAt = 0;
  let heartbeatTimer = null;

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (!id) return;
      if (Date.now() - lastPublishAt < 8000) return;
      fetch(`/api/sessions/touch/${id}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: '{}',
      }).catch(() => {});
    }, 10000);
  }

  async function init(camera) {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch {}
    try {
      const r = await fetch('/api/sessions/touch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stored || null, camera: camera || null }),
      });
      if (!r.ok) return null;
      const data = await r.json();
      id = data.id;
      try { localStorage.setItem(KEY, id); } catch {}
      startHeartbeat();
      return id;
    } catch {
      return null;
    }
  }

  function publish(state) {
    if (!id || !state || !state.frame) return;
    if (state.frame === lastFrame) return;
    lastFrame = state.frame;
    lastPublishAt = Date.now();
    fetch(`/api/sessions/touch/${id}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(state),
    }).catch(() => {});
  }

  function getId() { return id; }

  window.SkyController = { init, publish, getId };
})();
