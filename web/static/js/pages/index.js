/*
 * index.js — single-camera timelapse player + event tagging.
 *
 * Used by templates/index.html (admin /camera/<name> route). Reads
 * window.__SKY = { camera: string|null }. Requires lib/playback.js.
 *
 * Differences from live.js: this page exposes the event-tagging UI (only
 * shown after admin gate passes), an FPS control, and Save MP4 / day-video
 * download links. No touch_mode here — that flow lives in live.js.
 */
(function () {
  'use strict';

  const ctx = window.__SKY || {};
  const SERVER_CAMERA = ctx.camera || null;
  const urlParams = new URLSearchParams(window.location.search);
  const CAMERA = SERVER_CAMERA || urlParams.get('camera') || urlParams.get('cam') || '';
  const camQS = CAMERA ? `camera=${encodeURIComponent(CAMERA)}` : '';

  function withCam(url) {
    if (!CAMERA) return url;
    return url + (url.includes('?') ? '&' : '?') + camQS;
  }

  const SP = window.SkyPlayback;
  const {
    imgUrl: _imgUrl,
    formatTs, fmtTsHuman, fmtMD, fmt12hm, hhmmToMin,
    buildGradientFor, frameTimeColor, PreloadCache,
  } = SP;

  const imgUrl = (name) => _imgUrl(name, CAMERA);

  // ── state ──────────────────────────────────────────────────
  const cache = new PreloadCache({ camera: CAMERA, ahead: 60, behind: 30, cap: 600 });
  let frames = [];
  let idx = 0;
  let playing = true;
  let timer = null;
  let anchors = [];
  let sunTimes = {};
  let shiftDown = false;
  let rangeLo = 0, rangeHi = 0;
  let dragging = false;
  let activeDrag = null;
  let dragWasPlaying = true;
  let tagMode = false;
  let pendingClick = null;
  let events = [];
  let lastHourLock = false;
  let activePresetLabel = null;
  let eventsInitialized = false;
  const shownEvents = new Set();
  const eventTimers = new Map();

  const SUNRISE_HEAD = 30, SUNRISE_TAIL = 60;
  const DAY_PAD = 30;
  const SUNSET_HEAD = 30, SUNSET_TAIL = 60;
  const FRAME_TOL = 60;
  const EVENT_VISIBLE_MS = 10_000;
  const EVENT_FADE_OUT_MS = 1500;

  // ── DOM refs ───────────────────────────────────────────────
  const img            = document.getElementById('frame');
  const imgLoader      = document.getElementById('imgLoader');
  const tsLabel        = document.getElementById('tsLabel');
  const playBtn        = document.getElementById('playBtn');
  const fpsInput       = document.getElementById('fps');
  const saveLink       = document.getElementById('saveLink');
  const daySel         = document.getElementById('daySel');
  const saveDay        = document.getElementById('saveDay');
  const fsBtn          = document.getElementById('fsBtn');
  const stage          = document.querySelector('.stage');
  const rangePresets   = document.getElementById('rangePresets');
  const thumbTooltip   = document.getElementById('thumbTooltip');
  const dual           = document.getElementById('dual');
  const thumbLo        = document.getElementById('thumbLo');
  const thumbHi        = document.getElementById('thumbHi');
  const playhead       = document.getElementById('playhead');
  const selBar         = document.getElementById('selBar');
  const dayMarks       = document.getElementById('dayMarks');
  const anchorLabels   = document.getElementById('anchorLabels');
  const rangeStartLbl  = document.getElementById('rangeStartLabel');
  const rangeEndLbl    = document.getElementById('rangeEndLabel');

  const logEventBtn  = document.getElementById('logEventBtn');
  const eventOverlay = document.getElementById('eventOverlay');
  const evMsg        = document.getElementById('evMsg');
  const evStart      = document.getElementById('evStart');
  const evEnd        = document.getElementById('evEnd');
  const evSubmit     = document.getElementById('evSubmit');
  const evCancel     = document.getElementById('evCancel');
  const evPosHint    = document.getElementById('evPosHint');

  const setLoading = (on) => imgLoader && imgLoader.classList.toggle('show', !!on);
  const preloadAround = (i) => cache.around(i, rangeLo, rangeHi);

  // ── thumb tooltip + fullscreen ─────────────────────────────
  function showThumbTooltip(i, clientX, anchorEl) {
    if (!frames.length) return;
    thumbTooltip.textContent = formatTs(frames[i].ts);
    const rect = anchorEl.getBoundingClientRect();
    thumbTooltip.style.left = `${clientX}px`;
    thumbTooltip.style.top = `${rect.top}px`;
    thumbTooltip.classList.add('show');
  }
  const hideThumbTooltip = () => thumbTooltip.classList.remove('show');

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  }
  fsBtn.addEventListener('click', toggleFullscreen);
  stage.addEventListener('click', (e) => {
    if (e.target.closest('button, input, select, a')) return;
    if (tagMode) { handleTagClick(e); return; }
    toggleFullscreen();
  });

  // ── event tagging ──────────────────────────────────────────
  function setTagMode(on) {
    tagMode = on;
    stage.classList.toggle('tag-mode', on);
    logEventBtn.textContent = on ? 'Cancel tagging' : 'Log event';
    logEventBtn.style.background = on ? '#5a2a2a' : '';
  }
  logEventBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setTagMode(!tagMode);
  });

  const tsToInputValue = (iso) => (iso.length >= 19 ? iso.slice(0, 19) : iso);

  function handleTagClick(e) {
    const rect = img.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    pendingClick = { x_pct: x, y_pct: y };
    evPosHint.textContent = `pixel at ${(x*100).toFixed(1)}%, ${(y*100).toFixed(1)}%`;
    const startTs = frames[idx]?.ts ? tsToInputValue(frames[idx].ts) : '';
    const endTs   = frames[rangeHi]?.ts ? tsToInputValue(frames[rangeHi].ts) : startTs;
    evMsg.value = '';
    evStart.value = startTs;
    evEnd.value = endTs;
    eventOverlay.classList.add('show');
    evMsg.focus();
  }

  evCancel.addEventListener('click', () => {
    eventOverlay.classList.remove('show');
    pendingClick = null;
    setTagMode(false);
  });

  evSubmit.addEventListener('click', async () => {
    if (!pendingClick) return;
    const msg = evMsg.value.trim();
    if (!msg) { alert('Message required'); return; }
    const startTs = evStart.value.length === 16 ? evStart.value + ':00' : evStart.value;
    const endTs   = evEnd.value.length   === 16 ? evEnd.value   + ':00' : evEnd.value;
    if (!startTs || !endTs) { alert('Start and end required'); return; }
    if (startTs > endTs)    { alert('Start must be before end'); return; }
    const payload = {
      camera: CAMERA || null,
      x_pct: pendingClick.x_pct,
      y_pct: pendingClick.y_pct,
      message: msg,
      start_ts: startTs,
      end_ts: endTs,
    };
    try {
      const r = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      eventOverlay.classList.remove('show');
      pendingClick = null;
      setTagMode(false);
      await loadEvents();
    } catch (e) {
      alert(`Submit failed: ${e.message}`);
    }
  });

  // ── event dialogs ──────────────────────────────────────────
  function fadeOutDialog(el) {
    if (!el || el.classList.contains('fading')) return;
    el.classList.remove('shown');
    el.classList.add('fading');
    setTimeout(() => el.remove(), EVENT_FADE_OUT_MS + 100);
  }

  function positionDialog(dialog, ev) {
    const imgRect = img.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const xpx = imgRect.left - stageRect.left + ev.x_pct * imgRect.width;
    const ypx = imgRect.top  - stageRect.top  + ev.y_pct * imgRect.height;
    dialog.style.left = `${xpx}px`;
    dialog.style.top  = `${ypx - 14}px`;
  }

  function repositionAllDialogs() {
    for (const d of stage.querySelectorAll('.event-dialog')) {
      const ev = events.find((e) => e.id === d.dataset.eventId);
      if (ev) positionDialog(d, ev);
    }
  }
  window.addEventListener('resize', repositionAllDialogs);
  document.addEventListener('fullscreenchange', repositionAllDialogs);

  function spawnEventDialog(ev) {
    const dialog = document.createElement('div');
    dialog.className = 'event-dialog';
    dialog.dataset.eventId = ev.id;
    dialog.textContent = ev.message;
    positionDialog(dialog, ev);
    stage.appendChild(dialog);
    requestAnimationFrame(() => dialog.classList.add('shown'));
    const t = setTimeout(() => { fadeOutDialog(dialog); eventTimers.delete(ev.id); }, EVENT_VISIBLE_MS);
    eventTimers.set(ev.id, t);
  }

  function renderActiveEvents() {
    if (!events.length || !frames.length) return;
    const tMs = Date.parse(frames[idx].ts);
    const active = new Set();
    for (const ev of events) {
      const sMs = Date.parse(ev.start_ts);
      const eMs = Date.parse(ev.end_ts);
      if (isNaN(tMs) || isNaN(sMs) || isNaN(eMs)) continue;
      if (tMs >= sMs && tMs <= eMs) {
        active.add(ev.id);
        if (!shownEvents.has(ev.id)) {
          if (eventsInitialized) spawnEventDialog(ev);
          shownEvents.add(ev.id);
        }
      }
    }
    for (const id of [...shownEvents]) {
      if (!active.has(id)) {
        const t = eventTimers.get(id);
        if (t) { clearTimeout(t); eventTimers.delete(id); }
        shownEvents.delete(id);
        const el = document.querySelector(`.event-dialog[data-event-id="${id}"]`);
        fadeOutDialog(el);
      }
    }
    eventsInitialized = true;
  }

  // ── keyboard ───────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
      e.preventDefault();
      playing = !playing;
      playBtn.textContent = playing ? 'Pause' : 'Play';
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftDown = true; });
  document.addEventListener('keyup',   (e) => { if (e.key === 'Shift') shiftDown = false; });

  // ── data loading ───────────────────────────────────────────
  async function loadFrames() {
    const r = await fetch(withCam('/api/frames'));
    const data = await r.json();
    const prevLen = frames.length;
    const wasAtEnd = rangeHi === Math.max(0, prevLen - 1);
    frames = data;
    cache.setFrames(frames);
    const max = Math.max(0, frames.length - 1);
    computeAnchors();
    if (prevLen === 0) {
      rangeLo = 0; rangeHi = max; idx = max;
    } else if (wasAtEnd) {
      rangeHi = max;
    }
    applyRangeUI();
    updateSaveLink();
    if (lastHourLock) applyLastHour(false);
    buildPresets();
    applyTimelineGradient();
  }

  async function loadEvents() {
    try {
      const r = await fetch(withCam('/api/events'));
      events = await r.json();
      if (frames.length) { computeAnchors(); buildPresets(); }
    } catch (e) { console.warn('events load failed', e); }
  }

  async function loadSunTimes() {
    try {
      const r = await fetch(withCam('/api/anchors'));
      const data = await r.json();
      sunTimes = {};
      for (const d of data) sunTimes[d.day] = { sunrise: d.sunrise, sunset: d.sunset };
    } catch (e) { console.warn('sun times failed', e); }
  }

  // ── presets ────────────────────────────────────────────────
  function computeLastHourIdx() {
    if (frames.length < 2) return -1;
    const lastTsMs = new Date(frames[frames.length - 1].ts).getTime();
    const targetMs = lastTsMs - 60 * 60 * 1000;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (new Date(frames[i].ts).getTime() <= targetMs) return i;
    }
    return -1;
  }

  function applyLastHour(fromClick) {
    const idxLo = computeLastHourIdx();
    if (idxLo < 0 || idxLo >= frames.length - 1) return;
    rangeLo = idxLo;
    rangeHi = frames.length - 1;
    applyRangeUI();
    if (fromClick) resumeFromStart();
  }

  function findIdxAtMin(dayIndices, targetMin, tol = FRAME_TOL) {
    let best = -1, bestDiff = Infinity;
    for (const i of dayIndices) {
      const [hh, mm] = frames[i].ts.slice(11).split(':').map(Number);
      const min = hh * 60 + mm;
      const diff = Math.abs(min - targetMin);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return bestDiff <= tol ? best : -1;
  }

  function eventToRange(ev) {
    let lo = -1, hi = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].ts >= ev.start_ts) { lo = i; break; }
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].ts <= ev.end_ts) { hi = i; break; }
    }
    if (lo < 0 || hi < 0 || lo > hi) return null;
    return { lo, hi };
  }

  function refreshActivePreset() {
    for (const b of rangePresets.querySelectorAll('button')) {
      b.classList.toggle('active', activePresetLabel && b.dataset.label === activePresetLabel);
    }
  }

  function addPresetButton(label, cls, lo, hi) {
    const btn = document.createElement('button');
    if (cls) btn.className = cls;
    btn.textContent = label;
    btn.dataset.label = label;
    btn.addEventListener('click', () => {
      activePresetLabel = label;
      refreshActivePreset();
      applyPreset(lo, hi);
    });
    rangePresets.appendChild(btn);
  }

  function applyPreset(lo, hi) {
    const wasLocked = lastHourLock;
    lastHourLock = false;
    rangeLo = lo;
    rangeHi = hi;
    for (const id of [...shownEvents]) {
      const t = eventTimers.get(id);
      if (t) { clearTimeout(t); eventTimers.delete(id); }
      shownEvents.delete(id);
      const el = document.querySelector(`.event-dialog[data-event-id="${id}"]`);
      fadeOutDialog(el);
    }
    applyRangeUI();
    resumeFromStart();
    if (wasLocked) buildPresets();
  }

  function buildPresets() {
    rangePresets.innerHTML = '';
    if (!frames.length) return;

    const allBtn = document.createElement('button');
    allBtn.className = 'preset-everything';
    allBtn.textContent = 'Everything';
    allBtn.addEventListener('click', () => applyPreset(0, frames.length - 1));
    rangePresets.appendChild(allBtn);

    const byDay = {};
    frames.forEach((f, i) => {
      const day = f.ts.slice(0, 10);
      (byDay[day] ||= []).push(i);
    });
    const days = Object.keys(byDay).sort();
    const todayKey = days[days.length - 1];

    const chrono = [];
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      const dayIdx = byDay[day];
      const sun = sunTimes[day] || {};
      const sr = sun.sunrise ? hhmmToMin(sun.sunrise) : null;
      const ss = sun.sunset  ? hhmmToMin(sun.sunset)  : null;
      const md = fmtMD(day);

      if (sr !== null) {
        const lo = findIdxAtMin(dayIdx, sr - SUNRISE_HEAD);
        const hi = findIdxAtMin(dayIdx, sr + SUNRISE_TAIL);
        if (lo >= 0 && hi >= 0 && lo < hi) chrono.push({ label: `${md} sunrise`, cls: 'preset-sunrise', lo, hi });
      }
      if (sr !== null || ss !== null) {
        const tryLo = sr !== null ? findIdxAtMin(dayIdx, sr + SUNRISE_TAIL, 240) : -1;
        const tryHi = ss !== null ? findIdxAtMin(dayIdx, ss - DAY_PAD, 240) : -1;
        const lo = tryLo >= 0 ? tryLo : dayIdx[0];
        const hi = tryHi >= 0 ? tryHi : dayIdx[dayIdx.length - 1];
        if (lo < hi) chrono.push({ label: `${md} day`, cls: 'preset-day', lo, hi });
      }
      if (ss !== null) {
        const lo = findIdxAtMin(dayIdx, ss - SUNSET_HEAD);
        const hi = findIdxAtMin(dayIdx, ss + SUNSET_TAIL);
        if (lo >= 0 && hi >= 0 && lo < hi) chrono.push({ label: `${md} sunset`, cls: 'preset-sunset', lo, hi });
      }
      if (di < days.length - 1) {
        const nextDay = days[di + 1];
        const sunNext = sunTimes[nextDay] || {};
        const srNext = sunNext.sunrise ? hhmmToMin(sunNext.sunrise) : null;
        if (ss !== null && srNext !== null) {
          const lo = findIdxAtMin(dayIdx, ss + SUNSET_TAIL);
          const hi = findIdxAtMin(byDay[nextDay], srNext - SUNRISE_HEAD);
          if (lo >= 0 && hi >= 0 && lo < hi) chrono.push({ label: `Night ${md} → ${fmtMD(nextDay)}`, cls: 'preset-night', lo, hi });
        }
      }
    }
    for (const ev of events) {
      const r = eventToRange(ev);
      if (!r) continue;
      const md = fmtMD(ev.start_ts.slice(0, 10));
      const msg = ev.message.length > 28 ? ev.message.slice(0, 25) + '…' : ev.message;
      chrono.push({ label: `★ ${md} ${msg}`, cls: 'preset-event', lo: r.lo, hi: r.hi });
    }
    chrono.sort((a, b) => a.lo - b.lo);
    for (const b of chrono) addPresetButton(b.label, b.cls, b.lo, b.hi);

    if (sunTimes[todayKey]?.sunrise) {
      const sr = hhmmToMin(sunTimes[todayKey].sunrise);
      const srIdx = findIdxAtMin(byDay[todayKey], sr - SUNRISE_HEAD, 240);
      if (srIdx >= 0) addPresetButton(`Today (${fmtMD(todayKey)}): sunrise → NOW`, 'preset-today', srIdx, frames.length - 1);
    }

    const hourIdx = computeLastHourIdx();
    if (hourIdx >= 0 && hourIdx < frames.length - 1) {
      const startLabel = fmt12hm(frames[hourIdx].ts.slice(11, 16));
      const hourBtn = document.createElement('button');
      hourBtn.className = 'preset-today';
      const lockGlyph = lastHourLock ? '🔒 ' : '';
      hourBtn.textContent = `${lockGlyph}Last hour (${startLabel} → NOW)`;
      hourBtn.addEventListener('click', () => {
        if (lastHourLock) { lastHourLock = false; buildPresets(); return; }
        lastHourLock = true;
        applyLastHour(true);
        buildPresets();
      });
      rangePresets.appendChild(hourBtn);
    }

    refreshActivePreset();
  }

  function applyTimelineGradient() {
    const track = document.querySelector('.rangebar .track');
    if (track) track.style.background = buildGradientFor(frames, 0, frames.length - 1);
  }

  // ── timeline rendering ─────────────────────────────────────
  function frameToPct(i) {
    const total = Math.max(1, frames.length - 1);
    return (Math.max(0, Math.min(total, i)) / total) * 100;
  }

  function renderThumbs() {
    if (!frames.length) return;
    thumbLo.style.left = frameToPct(rangeLo) + '%';
    thumbHi.style.left = frameToPct(rangeHi) + '%';
    playhead.style.left = frameToPct(idx) + '%';
    thumbLo.style.setProperty('--thumb-color', frameTimeColor(frames, rangeLo));
    thumbHi.style.setProperty('--thumb-color', frameTimeColor(frames, rangeHi));
    playhead.style.setProperty('--thumb-color', frameTimeColor(frames, idx));
  }

  function computeAnchors() {
    anchors = [];
    if (!frames.length) { renderAnchors(); return; }
    const byDay = {};
    frames.forEach((f, i) => {
      const day = f.ts.slice(0, 10);
      (byDay[day] ||= []).push({ i, ts: f.ts });
    });
    for (const day of Object.keys(byDay)) {
      const monthDay = day.slice(5);
      const sun = sunTimes[day] || {};
      const targets = [{ time: '00:00', suffix: '' }];
      if (sun.sunrise) targets.push({ time: sun.sunrise, suffix: ` sunrise ${fmt12hm(sun.sunrise)}` });
      if (sun.sunset)  targets.push({ time: sun.sunset,  suffix: ` sunset ${fmt12hm(sun.sunset)}` });
      for (const t of targets) {
        const [th, tm] = t.time.split(':').map(Number);
        const targetMin = th * 60 + tm;
        let best = null, bestDiff = Infinity;
        for (const f of byDay[day]) {
          const [hh, mm] = f.ts.slice(11).split(':').map(Number);
          const min = hh * 60 + mm;
          const diff = Math.abs(min - targetMin);
          if (diff < bestDiff) { bestDiff = diff; best = f; }
        }
        if (best && bestDiff <= 120) {
          anchors.push({ idx: best.i, label: monthDay + t.suffix });
        }
      }
    }
    for (const ev of events) {
      const r = eventToRange(ev);
      if (!r) continue;
      anchors.push({ idx: r.lo, label: '★', kind: 'event', title: ev.message });
    }
    anchors.sort((a, b) => a.idx - b.idx);
    renderAnchors();
  }

  function renderAnchors() {
    dayMarks.innerHTML = '';
    anchorLabels.innerHTML = '';
    if (frames.length < 2) return;
    const total = frames.length - 1;
    for (const a of anchors) {
      const pct = (a.idx / total) * 100;
      const m = document.createElement('span');
      m.style.left = `${pct}%`;
      if (a.kind === 'event') m.classList.add('event-mark');
      dayMarks.appendChild(m);
      const lbl = document.createElement('span');
      lbl.style.left = `${pct}%`;
      lbl.textContent = a.label;
      if (a.kind === 'event') lbl.classList.add('event-anchor');
      lbl.title = a.title ? `${a.title} — ${frames[a.idx].ts.replace('T', ' ')}` : frames[a.idx].ts.replace('T', ' ');
      anchorLabels.appendChild(lbl);
    }
  }

  function snapToDay(val) {
    if (shiftDown || frames.length < 2) return val;
    const tol = Math.max(2, Math.floor(frames.length * 0.01));
    for (const a of anchors) {
      if (Math.abs(val - a.idx) <= tol) return a.idx;
    }
    return val;
  }

  function applyRangeUI() {
    if (frames.length < 2) {
      selBar.style.left = '0%';
      selBar.style.width = '100%';
      rangeStartLbl.textContent = '--';
      rangeEndLbl.textContent = '--';
      return;
    }
    const total = frames.length - 1;
    const loPct = (rangeLo / total) * 100;
    const hiPct = (rangeHi / total) * 100;
    selBar.style.left = `${loPct}%`;
    selBar.style.width = `${hiPct - loPct}%`;
    rangeStartLbl.textContent = fmtTsHuman(frames[rangeLo].ts);
    const atCurrent = rangeHi === frames.length - 1;
    rangeEndLbl.textContent = atCurrent
      ? `NOW (${fmtTsHuman(frames[rangeHi].ts)})`
      : fmtTsHuman(frames[rangeHi].ts);
    rangeEndLbl.style.color = atCurrent ? '#7fd17a' : '#788';
    if (idx < rangeLo) idx = rangeLo;
    if (idx > rangeHi) idx = rangeHi;
    updateSaveLink();
    renderThumbs();
    preloadAround(idx);
  }

  function resumeFromStart() {
    idx = rangeLo;
    show(idx);
    playing = true;
    playBtn.textContent = 'Pause';
  }

  function pointerToFrame(clientX) {
    const rect = dual.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * Math.max(0, frames.length - 1));
  }

  function pickActive(clientX) {
    const r = dual.getBoundingClientRect();
    const total = Math.max(1, frames.length - 1);
    const xLo = r.left + (rangeLo / total) * r.width;
    const xHi = r.left + (rangeHi / total) * r.width;
    const xPh = r.left + (idx     / total) * r.width;
    const HIT = 22;
    const cands = [
      ['playhead', Math.abs(clientX - xPh)],
      ['lo',       Math.abs(clientX - xLo)],
      ['hi',       Math.abs(clientX - xHi)],
    ].sort((a, b) => a[1] - b[1]);
    return cands[0][1] <= HIT ? cands[0][0] : 'playhead';
  }

  function updateDrag(clientX) {
    if (!activeDrag || !frames.length) return;
    let v = snapToDay(pointerToFrame(clientX));
    v = Math.max(0, Math.min(frames.length - 1, v));
    if (activeDrag === 'lo') {
      rangeLo = Math.min(v, Math.max(0, rangeHi - 1));
      if (idx < rangeLo) idx = rangeLo;
    } else if (activeDrag === 'hi') {
      rangeHi = Math.max(v, Math.min(frames.length - 1, rangeLo + 1));
      if (idx > rangeHi) idx = rangeHi;
    } else {
      if (v < rangeLo) rangeLo = v;
      if (v > rangeHi) rangeHi = v;
      idx = v;
    }
    applyRangeUI();
    show(idx);
    const anchor = activeDrag === 'lo' ? rangeLo : activeDrag === 'hi' ? rangeHi : idx;
    showThumbTooltip(anchor, clientX, dual);
  }

  dual.addEventListener('pointerdown', (e) => {
    if (!frames.length) return;
    e.preventDefault();
    try { dual.setPointerCapture(e.pointerId); } catch {}
    activeDrag = pickActive(e.clientX);
    dragWasPlaying = playing;
    playing = false;
    playBtn.textContent = 'Play';
    dragging = true;
    updateDrag(e.clientX);

    const onMove = (ev) => updateDrag(ev.clientX);
    const onUp = () => {
      activeDrag = null;
      dragging = false;
      hideThumbTooltip();
      dual.removeEventListener('pointermove', onMove);
      dual.removeEventListener('pointerup', onUp);
      dual.removeEventListener('pointercancel', onUp);
      cache.abortPending();
      show(idx);
      playing = true;
      playBtn.textContent = 'Pause';
    };
    dual.addEventListener('pointermove', onMove);
    dual.addEventListener('pointerup', onUp);
    dual.addEventListener('pointercancel', onUp);
  });

  // ── save MP4 link + day select ─────────────────────────────
  function updateSaveLink() {
    const fps = parseInt(fpsInput.value, 10) || 10;
    let saveUrl = `/save?fps=${fps}`;
    if (frames.length && (rangeLo > 0 || rangeHi < frames.length - 1)) {
      const s = frames[rangeLo].ts.replace('T', '_').replace(/:/g, '-');
      const e = frames[rangeHi].ts.replace('T', '_').replace(/:/g, '-');
      saveUrl += `&start=${s}&end=${e}`;
    }
    saveLink.href = withCam(saveUrl);
    const day = daySel.value;
    saveDay.href = day
      ? withCam(`/save?fps=${fps}&start=${day}_00-00-00&end=${day}_23-59-59`)
      : '#';
  }

  async function loadDays() {
    const r = await fetch(withCam('/api/days'));
    const days = await r.json();
    const prev = daySel.value;
    daySel.innerHTML = '';
    for (const d of days) {
      const opt = document.createElement('option');
      opt.value = d.day;
      opt.textContent = `${d.day} (${d.count})`;
      daySel.appendChild(opt);
    }
    if (prev && [...daySel.options].some((o) => o.value === prev)) {
      daySel.value = prev;
    }
    updateSaveLink();
  }
  daySel.addEventListener('change', updateSaveLink);

  // ── frame display + playback loop ──────────────────────────
  function show(i) {
    if (!frames.length) return;
    idx = Math.max(rangeLo, Math.min(rangeHi, i));
    const f = frames[idx];
    img.src = imgUrl(f.name);
    setLoading(!(img.complete && img.naturalWidth > 0));
    tsLabel.textContent = fmtTsHuman(f.ts);
    renderThumbs();
    renderActiveEvents();
    if (!dragging) preloadAround(idx);
  }

  img.addEventListener('load',  () => setLoading(false));
  img.addEventListener('error', () => setLoading(false));

  function tick() {
    if (!playing || !frames.length) return;
    const next = idx >= rangeHi ? rangeLo : idx + 1;
    if (!cache.ready(next)) { setLoading(true); preloadAround(next); return; }
    idx = idx >= rangeHi ? rangeLo : idx + 1;
    show(idx);
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    const fps = Math.max(1, Math.min(60, parseInt(fpsInput.value, 10) || 10));
    timer = setInterval(tick, 1000 / fps);
  }

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
  });

  fpsInput.addEventListener('change', () => {
    playing = true;
    playBtn.textContent = 'Pause';
    restartTimer();
    updateSaveLink();
  });

  // ── camera switcher ────────────────────────────────────────
  async function buildCameraSwitcher() {
    try {
      const r = await fetch('/api/cameras');
      const data = await r.json();
      const cams = data.cameras_public || (data.cameras || []).map((n) => ({ name: n, label: n }));
      const def = data.default;
      const container = document.getElementById('cameraSwitcher');
      container.innerHTML = '';
      const active = CAMERA || def;
      for (const cam of cams) {
        const name = cam.name;
        const btn = document.createElement('button');
        btn.textContent = cam.label || name;
        if (name === active) btn.classList.add('active');
        btn.addEventListener('click', () => {
          if (name === active) return;
          window.location.href = `/camera/${encodeURIComponent(name)}`;
        });
        container.appendChild(btn);
      }
    } catch (e) { console.warn('camera switcher failed', e); }
  }

  // ── boot ───────────────────────────────────────────────────
  (async () => {
    await buildCameraSwitcher();
    await loadSunTimes();
    await loadFrames();
    await loadDays();
    await loadEvents();
    if (frames.length) show(idx);
    restartTimer();
    setInterval(async () => { await loadSunTimes(); await loadFrames(); await loadEvents(); }, 30_000);
    setInterval(loadDays, 60_000);
  })();
})();
