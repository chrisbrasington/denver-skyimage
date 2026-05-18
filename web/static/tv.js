(function () {
  'use strict';

  const STAGE = document.getElementById('stage');
  const FRAME = document.getElementById('frame');
  const IDLE = document.getElementById('idle');
  const CODE = document.getElementById('code');
  const STATUS = document.getElementById('status');

  let tvId = null;
  try { tvId = localStorage.getItem('tv_session_id'); } catch {}
  let es = null;
  let lastEventAt = Date.now();
  let lastFrameKey = null;

  function setStatus(msg, bad) {
    STATUS.textContent = msg;
    STATUS.classList.toggle('bad', !!bad);
  }

  function showIdle(code) {
    CODE.textContent = code || '----';
    IDLE.classList.remove('hidden');
    STAGE.classList.add('hidden');
    lastFrameKey = null;
  }

  function showPaired() {
    IDLE.classList.add('hidden');
    STAGE.classList.remove('hidden');
  }

  function showFrame(frame, camera) {
    if (!frame) { showPaired(); return; }
    const key = `${camera || ''}|${frame}`;
    if (key === lastFrameKey) { showPaired(); return; }
    lastFrameKey = key;
    const q = camera ? `?camera=${encodeURIComponent(camera)}` : '';
    FRAME.src = `/image/${encodeURIComponent(frame)}${q}`;
    showPaired();
  }

  async function register() {
    const body = tvId ? { id: tvId } : {};
    const r = await fetch('/api/sessions/tv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('register failed');
    const data = await r.json();
    tvId = data.id;
    try { localStorage.setItem('tv_session_id', tvId); } catch {}
    return data;
  }

  function connect() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource(`/api/sse/tv/${encodeURIComponent(tvId)}`);
    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      lastEventAt = Date.now();
      if (d.paired) showPaired();
      else showIdle(d.pairing_code);
      setStatus('connected');
    });
    es.addEventListener('pair', (e) => {
      const d = JSON.parse(e.data);
      lastEventAt = Date.now();
      if (d.frame) showFrame(d.frame, d.camera);
      else showPaired();
    });
    es.addEventListener('frame', (e) => {
      const d = JSON.parse(e.data);
      lastEventAt = Date.now();
      showFrame(d.frame, d.camera);
    });
    es.addEventListener('unpair', (e) => {
      const d = JSON.parse(e.data);
      lastEventAt = Date.now();
      showIdle(d.pairing_code);
    });
    es.addEventListener('keepalive', () => { lastEventAt = Date.now(); });
    es.addEventListener('error', (e) => {
      const d = JSON.parse(e.data || '{}');
      setStatus(d.detail || 'error', true);
    });
    es.onerror = () => setStatus('reconnecting…', true);
  }

  setInterval(() => {
    if (Date.now() - lastEventAt > 40000) {
      setStatus('stale — reconnecting', true);
      connect();
    }
  }, 5000);

  setInterval(() => {
    if (!tvId) return;
    fetch('/api/sessions/tv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: tvId }),
    }).catch(() => {});
  }, 60000);

  (async () => {
    try {
      await register();
      connect();
    } catch (e) {
      setStatus('register failed', true);
      setTimeout(() => location.reload(), 5000);
    }
  })();
})();
