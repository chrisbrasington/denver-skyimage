(function () {
  'use strict';

  const KEY = 'controller_id';
  let id = null;
  let lastFrame = null;
  let lastPreview = false;
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

  let lastCamera = null;
  let reregistering = false;

  async function reregister() {
    if (reregistering) return;
    reregistering = true;
    try {
      id = null;
      try { localStorage.removeItem(KEY); } catch {}
      await init(lastCamera);
    } finally {
      reregistering = false;
    }
  }

  function publish(state) {
    if (!id || !state || !state.frame) return;
    const preview = !!state.preview;
    if (state.frame === lastFrame && preview === lastPreview) return;
    lastFrame = state.frame;
    lastPreview = preview;
    lastCamera = state.camera || lastCamera;
    lastPublishAt = Date.now();
    fetch(`/api/sessions/touch/${id}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(state),
    }).then((r) => {
      if (r.status === 404) reregister();
    }).catch(() => {});
  }

  function getId() { return id; }

  window.SkyController = { init, publish, getId };
})();
