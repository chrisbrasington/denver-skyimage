/*
 * home.js — camera grid, multi-view picker, TV pairing, and admin reveal.
 *
 * Reads window.__SKY = { cameras: [...], autoAdmin: bool } injected by
 * templates/home.html. Requires lib/controller.js and lib/admin-keypad.js.
 *
 * The admin reveal flow (corner-touch hold, keyboard shortcut, optional
 * auto-open on /admin) is home-specific and intentionally stays out of the
 * shared lib/admin-gate.js, which is the simpler "you must PIN to view"
 * gate used by other pages.
 */
(function () {
  'use strict';

  const ctx = window.__SKY || {};
  const CAMERAS = ctx.cameras || [];

  // ── DOM refs ───────────────────────────────────────────────
  const grid          = document.getElementById('grid');
  const compareBar    = document.getElementById('compareBar');
  const comparePicks  = document.getElementById('comparePicks');
  const compareGoBtn  = document.getElementById('compareGoBtn');
  const compareClrBtn = document.getElementById('compareClearBtn');

  // ── camera card ────────────────────────────────────────────
  function imgUrl(cam, name) {
    return `/image/${encodeURIComponent(name)}?camera=${encodeURIComponent(cam)}`;
  }

  function fmtTs(iso) {
    try {
      return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Denver', hour12: false });
    } catch { return iso; }
  }

  function cardFor(cam) {
    const name = cam.name;
    const label = cam.label || cam.name;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <label class="pick" data-pick title="Select for multi-view">
        <input type="checkbox" data-cam="${name}">
        <span>multi-view</span>
      </label>
      <a class="thumb" href="/touch/${encodeURIComponent(name)}">
        <div class="ph" data-ph>loading…</div>
      </a>
      <div class="meta">
        <span class="name">${label}</span>
        <span class="ts" data-ts></span>
      </div>
      <div class="touch-ranges" data-ranges>
        <div class="empty">loading days…</div>
      </div>
      <div class="actions admin-hidden">
        <a href="/touch/${encodeURIComponent(name)}/last-hour">Last hour</a>
        <a href="/last/${encodeURIComponent(name)}">Last image</a>
        <a href="/camera/${encodeURIComponent(name)}">Admin / TV</a>
        <a href="/browse/${encodeURIComponent(name)}">Browse</a>
      </div>
    `;
    return card;
  }

  // ── day-range buttons ──────────────────────────────────────
  const WD_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'short' });
  const MD_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric' });

  function parseDay(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function rangeLabel(days, latestDay) {
    const todayWd = WD_FMT.format(latestDay);
    if (days === 1) return `Today (${todayWd})`;
    const start = new Date(latestDay);
    start.setDate(start.getDate() - (days - 1));
    if (days <= 6) return `${WD_FMT.format(start)} – Today (${todayWd})`;
    return `${MD_FMT.format(start)} – Today (${todayWd})`;
  }

  async function renderRanges(cam, card) {
    const box = card.querySelector('[data-ranges]');
    try {
      const r = await fetch(`/api/days?camera=${encodeURIComponent(cam)}`, { cache: 'no-store' });
      if (!r.ok) { box.innerHTML = `<div class="empty">no days</div>`; return; }
      const data = await r.json();
      if (!data.length) { box.innerHTML = `<div class="empty">no images yet</div>`; return; }
      const latestDay = parseDay(data[0].day);
      box.innerHTML = '';
      for (let n = 1; n <= data.length; n++) {
        const a = document.createElement('a');
        a.href = `/touch/${encodeURIComponent(cam)}?days=${n}`;
        a.textContent = rangeLabel(n, latestDay);
        box.appendChild(a);
      }
    } catch {
      box.innerHTML = `<div class="empty">error</div>`;
    }
  }

  async function refreshThumb(cam, card) {
    try {
      const r = await fetch(`/api/latest/${encodeURIComponent(cam)}`, { cache: 'no-store' });
      const thumb = card.querySelector('.thumb');
      const ph = card.querySelector('[data-ph]');
      const ts = card.querySelector('[data-ts]');
      if (!r.ok) {
        if (ph) ph.textContent = r.status === 404 ? 'no images yet' : `error ${r.status}`;
        return;
      }
      const data = await r.json();
      let img = thumb.querySelector('img');
      if (!img) { img = document.createElement('img'); thumb.appendChild(img); }
      img.src = imgUrl(cam, data.name);
      img.alt = `${cam} latest`;
      if (ph) ph.remove();
      if (ts) ts.textContent = fmtTs(data.ts);
    } catch {
      const ph = card.querySelector('[data-ph]');
      if (ph) ph.textContent = 'error';
    }
  }

  // ── populate grid ──────────────────────────────────────────
  const cardByCam = new Map();
  const labelByCam = new Map();
  for (const cam of CAMERAS) {
    const name = cam.name;
    labelByCam.set(name, cam.label || cam.name);
    const card = cardFor(cam);
    grid.appendChild(card);
    cardByCam.set(name, card);
    refreshThumb(name, card);
    renderRanges(name, card);
    setInterval(() => refreshThumb(name, card), 30_000);
    setInterval(() => renderRanges(name, card), 5 * 60_000);
  }

  // ── multi-view picker (pick 2 cameras) ─────────────────────
  const compareSel = [];
  const MAX_COMPARE = 2;

  function renderCompareUI() {
    for (const [cam, card] of cardByCam) {
      const cb = card.querySelector('input[data-cam]');
      if (!cb) continue;
      const picked = compareSel.includes(cam);
      card.classList.toggle('picked', picked);
      const full = compareSel.length >= MAX_COMPARE && !picked;
      card.classList.toggle('disabled-pick', full);
      cb.disabled = full;
      cb.checked = picked;
    }
    const lbl = (n) => labelByCam.get(n) || n;
    if (compareSel.length === MAX_COMPARE) {
      comparePicks.innerHTML = `Multi-view <strong>${lbl(compareSel[0])}</strong> + <strong>${lbl(compareSel[1])}</strong>`;
      compareBar.classList.add('show');
    } else if (compareSel.length === 1) {
      comparePicks.innerHTML = `Selected <strong>${lbl(compareSel[0])}</strong> — pick one more`;
      compareBar.classList.add('show');
    } else {
      compareBar.classList.remove('show');
    }
  }

  grid.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.dataset.cam) return;
    const cam = t.dataset.cam;
    const i = compareSel.indexOf(cam);
    if (t.checked) {
      if (i < 0 && compareSel.length < MAX_COMPARE) compareSel.push(cam);
    } else {
      if (i >= 0) compareSel.splice(i, 1);
    }
    renderCompareUI();
  });

  compareGoBtn.addEventListener('click', () => {
    if (compareSel.length !== MAX_COMPARE) return;
    const q = new URLSearchParams();
    q.set('left', compareSel[0]);
    q.set('right', compareSel[1]);
    window.location.href = `/split?${q.toString()}`;
  });

  compareClrBtn.addEventListener('click', () => {
    compareSel.length = 0;
    renderCompareUI();
  });

  // ── TV pairing (controller side) ───────────────────────────
  let controllerId = null;
  let pairedTvId = null;
  let pairedTvCode = null;

  const badgeEl   = document.getElementById('pairBadge');
  const labelEl   = document.getElementById('pairLabel');
  const pairBtn   = document.getElementById('pairBtn');
  const unpairBtn = document.getElementById('unpairBtn');
  const overlay   = document.getElementById('pairOverlay');
  const overlayX  = document.getElementById('pairCloseBtn');
  const tvListEl  = document.getElementById('tvList');

  function renderPairState() {
    if (pairedTvId) {
      badgeEl.textContent = 'Paired';
      badgeEl.classList.remove('not');
      labelEl.innerHTML = pairedTvCode
        ? `TV <strong>${pairedTvCode}</strong> (<span style="font-family:monospace">${pairedTvId.slice(0, 8)}</span>) — tap a touch link below to drive it.`
        : `TV <strong>${pairedTvId.slice(0, 8)}</strong> — tap a touch link below to drive it.`;
      pairBtn.style.display = 'none';
      unpairBtn.style.display = '';
    } else {
      badgeEl.textContent = 'Not paired';
      badgeEl.classList.add('not');
      labelEl.textContent = 'Pair this device to a TV to mirror playback.';
      pairBtn.style.display = '';
      unpairBtn.style.display = 'none';
    }
  }

  async function fetchSessions() {
    try {
      const r = await fetch('/api/sessions', { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function refreshPairStatus() {
    const data = await fetchSessions();
    if (!data) return;
    const me = (data.touches || []).find((t) => t.id === controllerId);
    pairedTvId = me?.paired_tv_id || null;
    if (pairedTvId) {
      const tv = (data.tvs || []).find((t) => t.id === pairedTvId);
      pairedTvCode = tv?.pairing_code || pairedTvCode;
    } else {
      pairedTvCode = null;
    }
    renderPairState();
    if (!overlay.classList.contains('hidden')) renderTvList(data);
  }

  function renderTvList(data) {
    const tvs = data.tvs || [];
    tvListEl.innerHTML = '';
    if (!tvs.length) {
      tvListEl.innerHTML = `<div class="modal-empty">No TVs registered. Open <a href="/tv" target="_blank">/tv</a> on a display and try again.</div>`;
      return;
    }
    for (const tv of tvs) {
      const row = document.createElement('div');
      row.className = 'tv-row';
      const codeText = tv.pairing_code || '----';
      const stateText = tv.paired_touch_id
        ? (tv.paired_touch_id === controllerId
            ? 'paired with this device'
            : `paired with another (${tv.paired_touch_id.slice(0, 6)})`)
        : 'awaiting pair';
      row.innerHTML = `
        <div class="code">${codeText}</div>
        <div class="info">
          <div class="id">${tv.id.slice(0, 12)}</div>
          <div class="state">${stateText}</div>
        </div>
        <div class="arrow">›</div>`;
      if (tv.paired_touch_id === controllerId) {
        row.classList.add('disabled');
      } else {
        row.addEventListener('click', () => pairWith(tv.id));
      }
      tvListEl.appendChild(row);
    }
  }

  async function openPairOverlay() {
    overlay.classList.remove('hidden');
    tvListEl.innerHTML = `<div class="modal-empty">scanning…</div>`;
    const data = await fetchSessions();
    if (data) renderTvList(data);
  }

  function closePairOverlay() { overlay.classList.add('hidden'); }

  async function pairWith(tvId) {
    if (!controllerId) return;
    try {
      const r = await fetch('/api/sessions/pair-tv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touch_id: controllerId, tv_id: tvId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.detail || `pair failed (${r.status})`);
        return;
      }
    } catch {
      alert('network error');
      return;
    }
    closePairOverlay();
    await refreshPairStatus();
  }

  async function unpairSelf() {
    if (!controllerId) return;
    try {
      await fetch('/api/sessions/unpair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touch_id: controllerId }),
      });
    } catch {}
    await refreshPairStatus();
  }

  pairBtn.addEventListener('click', openPairOverlay);
  unpairBtn.addEventListener('click', unpairSelf);
  overlayX.addEventListener('click', closePairOverlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePairOverlay(); });

  (async () => {
    if (window.SkyController) controllerId = await window.SkyController.init(null);
    await refreshPairStatus();
    setInterval(refreshPairStatus, 3000);
  })();

  // ── admin reveal (corner-touch hold, keyboard, auto-admin) ─
  // The home page hides chrome from public viewers; this flow uncovers it
  // for staff. Two-finger top-corner hold for 5s opens the keypad; typing
  // "admin" on a keyboard works for desktop testing; /admin auto-opens.
  const CORNER = 140;
  const HOLD_MS = 5000;
  let holdTimer = null;
  let keypadOpen = false;

  const inTL = (t) => t.clientX <= CORNER && t.clientY <= CORNER;
  const inTR = (t) => t.clientX >= window.innerWidth - CORNER && t.clientY <= CORNER;

  function bothCorners(touches) {
    if (!touches || touches.length < 2) return false;
    let tl = false, tr = false;
    for (const t of touches) {
      if (inTL(t)) tl = true;
      else if (inTR(t)) tr = true;
    }
    return tl && tr;
  }

  function revealAdmin() {
    document.getElementById('topHeader').classList.remove('admin-hidden');
    document.getElementById('pairBanner').classList.remove('admin-hidden');
    document.querySelectorAll('.card .actions.admin-hidden')
      .forEach((el) => el.classList.remove('admin-hidden'));
  }

  function openKeypad() {
    if (keypadOpen || !window.AdminKeypad) return;
    keypadOpen = true;
    window.AdminKeypad.show({
      title: 'Admin Access',
      sub: 'Enter PIN',
      mode: 'gate',
      timeoutMs: 10000,
      onSuccess: () => {
        keypadOpen = false;
        revealAdmin();
        if (location.pathname === '/admin') history.replaceState(null, '', '/');
      },
      onFail:    () => { keypadOpen = false; },
      onTimeout: () => { keypadOpen = false; },
    });
  }

  // When admin is unlocked, show all chrome immediately and skip the PIN flow
  // (corner-hold, keyboard shortcut, /admin auto-open).
  if (ctx.adminLocked === false) {
    revealAdmin();
    return;
  }

  function startHold() {
    if (holdTimer || keypadOpen) return;
    holdTimer = setTimeout(() => { holdTimer = null; openKeypad(); }, HOLD_MS);
  }

  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  }

  function onTouch(e) {
    if (keypadOpen) return;
    if (bothCorners(e.touches)) startHold(); else cancelHold();
  }

  window.addEventListener('touchstart',  onTouch, { passive: true });
  window.addEventListener('touchmove',   onTouch, { passive: true });
  window.addEventListener('touchend',    onTouch, { passive: true });
  window.addEventListener('touchcancel', cancelHold, { passive: true });

  let kbBuf = '';
  window.addEventListener('keydown', (e) => {
    kbBuf = (kbBuf + e.key).slice(-5);
    if (kbBuf === 'admin') openKeypad();
  });

  if (ctx.autoAdmin) {
    window.addEventListener('load', () => openKeypad());
  }
})();
