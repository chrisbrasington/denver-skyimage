/*
 * live.js — timelapse player + timeline scrubber for /live and /touch.
 *
 * Reads window.__SKY = { camera: string|null, touchMode: bool, days: int }
 * injected by templates/live.html.
 *
 * Requires lib/playback.js (SkyPlayback) and lib/controller.js (SkyController,
 * touch_mode only). Mounts no external libs for camera switching because the
 * route logic (touch vs live) is page-specific.
 */
(function () {
  'use strict';

  // ── context from Jinja ─────────────────────────────────────
  const ctx = window.__SKY || {};
  const SERVER_CAMERA = ctx.camera || null;
  const TOUCH_MODE = !!ctx.touchMode;
  const DAYS = ctx.days || 0;

  const urlParams = new URLSearchParams(window.location.search);
  const CAMERA = SERVER_CAMERA || urlParams.get('camera') || urlParams.get('cam') || '';
  const instructionsOn = !['false', '0'].includes((urlParams.get('instruction') || '').toLowerCase());
  const camQS = CAMERA ? `camera=${encodeURIComponent(CAMERA)}` : '';
  const IS_MOBILE = window.matchMedia('(max-width: 768px)').matches;
  const MOBILE_TOUCH = TOUCH_MODE && IS_MOBILE;

  function withCam(url) {
    if (!CAMERA) return url;
    return url + (url.includes('?') ? '&' : '?') + camQS;
  }

  // ── SkyPlayback helpers ────────────────────────────────────
  const SP = window.SkyPlayback;
  const {
    imgUrl: _imgUrl, thumbUrl: _thumbUrl,
    readableTs, formatTs, fmtTsHuman, fmtMD, fmt12hm, hhmmToMin,
    describePartOfDay, frameTimeColor, buildGradientFor, PreloadCache,
  } = SP;

  function imgUrl(name)   { return _imgUrl(name, CAMERA); }
  function thumbUrl(name) { return _thumbUrl(name, CAMERA); }

  const cache = new PreloadCache({ camera: CAMERA, ahead: 60, behind: 30, cap: 600, thumbCap: 8000 });
  const FPS = 10;
  const FS_DURATION_MS = 30_000;
  const IDLE_MS = 120_000;
  const SUNRISE_HEAD = 30, SUNRISE_TAIL = 60;
  const DAY_PAD = 30;
  const SUNSET_HEAD = 30, SUNSET_TAIL = 60;
  const FRAME_TOL = 60;
  const EVENT_VISIBLE_MS = 10_000;
  const EVENT_FADE_OUT_MS = 1500;

  // ── state ──────────────────────────────────────────────────
  let frames = [];
  let idx = 0, rangeLo = 0, rangeHi = 0;
  let playing = true;
  let timer = null;
  let anchors = [];
  let sunTimes = {};
  let events = [];
  let dragging = false;
  let resetPending = false;
  let idleTimer = null, fsTimer = null;
  let presetActive = false;
  let activePresetLabel = null;
  let activeDrag = null;
  let _showToken = 0;
  let eventsInitialized = false;
  const shownEvents = new Set();
  const eventTimers = new Map();

  // ── DOM refs ───────────────────────────────────────────────
  const img            = document.getElementById('frame');
  const imgLoader      = document.getElementById('imgLoader');
  const stage          = document.getElementById('stage');
  const tsLabel        = document.getElementById('tsLabel');
  const playBtn        = document.getElementById('playBtn');
  const dual           = document.getElementById('dual');
  const thumbLo        = document.getElementById('thumbLo');
  const thumbHi        = document.getElementById('thumbHi');
  const playhead       = document.getElementById('playhead');
  const selBar         = document.getElementById('selBar');
  const dayMarks       = document.getElementById('dayMarks');
  const anchorLabels   = document.getElementById('anchorLabels');
  const rangePresets   = document.getElementById('rangePresets');
  const thumbTooltip   = document.getElementById('thumbTooltip');
  const thumbLabelLo   = document.getElementById('thumbLabelLo');
  const thumbLabelHi   = document.getElementById('thumbLabelHi');
  const braceGraphic   = document.querySelector('.brace-graphic');
  const touchHint      = document.getElementById('touchHint');
  const hitZoneLo      = document.getElementById('hitZoneLo');
  const hitZoneHi      = document.getElementById('hitZoneHi');
  const fsHint         = document.querySelector('.fs-hint');
  const timeDescriptor = document.getElementById('timeDescriptor');
  const timeTs         = document.getElementById('timeTs');
  const timeLabel      = document.querySelector('.time-label');
  const rangeStartLbl  = document.getElementById('rangeStartLabel');
  const rangeEndLbl    = document.getElementById('rangeEndLabel');

  // ── helpers ────────────────────────────────────────────────
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const setLoading = (on) => imgLoader && imgLoader.classList.toggle('show', !!on);
  const setPlayBtn = (text) => { if (playBtn) playBtn.textContent = text; };

  function buildSinceParam() {
    if (!(TOUCH_MODE && DAYS > 0)) return null;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1));
    return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}_00-00-00`;
  }

  function preloadAround(i)     { cache.around(i, rangeLo, rangeHi); }
  function preloadThumbRange()  { cache.preloadThumbRange(rangeLo, rangeHi, idx); }

  function updateTimeLabel(iso) {
    if (!timeDescriptor) return;
    const day = iso.slice(0, 10);
    const sun = sunTimes[day];
    timeDescriptor.textContent = describePartOfDay(iso, sun);
    timeTs.textContent = readableTs(iso);
  }

  // ── overlay positioning (relative to the rendered image) ───
  function positionOverlays() {
    if (document.fullscreenElement) {
      if (timeLabel) {
        timeLabel.style.top = '1.5rem';
        timeLabel.style.right = '1.5rem';
      }
      return;
    }
    const imgRect = img.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (imgRect.width === 0) return;
    const topPx = imgRect.top - stageRect.top + 16;
    const rightPx = stageRect.right - imgRect.right + 16;
    const leftPx = imgRect.left - stageRect.left + 16;
    if (fsHint) {
      fsHint.style.top = `${topPx}px`;
      fsHint.style.left = `${leftPx}px`;
    }
    if (timeLabel) {
      timeLabel.style.top = `${topPx}px`;
      timeLabel.style.right = `${rightPx}px`;
    }
    const switcher = document.getElementById('cameraSwitcher');
    if (switcher && switcher.children.length) {
      const tlVisible = timeLabel && getComputedStyle(timeLabel).display !== 'none';
      if (tlVisible) {
        const tlRect = timeLabel.getBoundingClientRect();
        switcher.style.top = `${tlRect.bottom + 12}px`;
        switcher.style.right = `${window.innerWidth - imgRect.right + 16}px`;
      } else {
        switcher.style.top = '';
        switcher.style.right = '';
      }
    }
  }
  img.addEventListener('load', positionOverlays);
  window.addEventListener('resize', positionOverlays);
  document.addEventListener('fullscreenchange', positionOverlays);

  function showThumbTooltip(i, clientX, anchorEl) {
    if (!frames.length) return;
    thumbTooltip.textContent = formatTs(frames[i].ts);
    const rect = anchorEl.getBoundingClientRect();
    thumbTooltip.style.left = `${clientX}px`;
    thumbTooltip.style.top = `${rect.top}px`;
    thumbTooltip.classList.add('show');
  }
  const hideThumbTooltip = () => thumbTooltip.classList.remove('show');

  // ── fullscreen + idle reset ─────────────────────────────────
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
      clearTimeout(fsTimer);
      if (!MOBILE_TOUCH) {
        fsTimer = setTimeout(() => {
          if (document.fullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
          }
        }, FS_DURATION_MS);
      }
    } else {
      clearTimeout(fsTimer);
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

  function resetIdle() {
    if (MOBILE_TOUCH) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { resetPending = true; }, IDLE_MS);
  }
  if (!MOBILE_TOUCH) {
    ['touchstart', 'click', 'mousemove', 'keydown', 'input'].forEach((ev) => {
      window.addEventListener(ev, resetIdle, { passive: true });
    });
    resetIdle();
  }

  // ── frame + event loading ──────────────────────────────────
  async function loadFrames() {
    const since = buildSinceParam();
    const baseUrl = since ? `/api/frames?since=${encodeURIComponent(since)}` : '/api/frames';
    const r = await fetch(withCam(baseUrl));
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

  // ── preset buttons ─────────────────────────────────────────
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
    btn.style.whiteSpace = 'pre-line';
    btn.textContent = label;
    btn.dataset.label = label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      presetActive = true;
      activePresetLabel = label;
      refreshActivePreset();
      applyPreset(lo, hi);
    });
    btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    rangePresets.appendChild(btn);
  }

  function applyPreset(lo, hi) {
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
  }

  function buildPresets() {
    rangePresets.innerHTML = '';
    if (!frames.length) return;

    const allBtn = document.createElement('button');
    allBtn.className = 'preset-everything';
    allBtn.textContent = 'Everything';
    allBtn.addEventListener('click', (e) => { e.stopPropagation(); applyPreset(0, frames.length - 1); });
    allBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
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
      const msg = ev.message.length > 24 ? ev.message.slice(0, 21) + '…' : ev.message;
      chrono.push({ label: `★ ${md}\n${msg}`, cls: 'preset-event', lo: r.lo, hi: r.hi });
    }
    chrono.sort((a, b) => a.lo - b.lo);
    for (const b of chrono) addPresetButton(b.label, b.cls, b.lo, b.hi);

    if (sunTimes[todayKey]?.sunrise) {
      const sr = hhmmToMin(sunTimes[todayKey].sunrise);
      const srIdx = findIdxAtMin(byDay[todayKey], sr - SUNRISE_HEAD, 240);
      if (srIdx >= 0) addPresetButton(`Today (${fmtMD(todayKey)})\nsunrise → NOW`, 'preset-today', srIdx, frames.length - 1);
    }

    const lastTsMs = new Date(frames[frames.length - 1].ts).getTime();
    const targetMs = lastTsMs - 60 * 60 * 1000;
    let hourIdx = 0;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (new Date(frames[i].ts).getTime() <= targetMs) { hourIdx = i; break; }
    }
    if (hourIdx < frames.length - 1) {
      const startLabel = fmt12hm(frames[hourIdx].ts.slice(11, 16));
      addPresetButton(`Last hour\n${startLabel} → NOW`, 'preset-today', hourIdx, frames.length - 1);
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
    if (thumbLabelLo && thumbLabelHi) {
      thumbLabelLo.style.left = frameToPct(rangeLo) + '%';
      thumbLabelHi.style.left = frameToPct(rangeHi) + '%';
      positionThumbLabels();
    }
    positionHitZones();
    if (braceGraphic) {
      const loPct = frameToPct(rangeLo);
      const hiPct = frameToPct(rangeHi);
      braceGraphic.style.marginLeft = loPct + '%';
      braceGraphic.style.marginRight = (100 - hiPct) + '%';
      if (touchHint && touchHint.parentElement) {
        const dualRect = dual.getBoundingClientRect();
        const parentRect = touchHint.parentElement.getBoundingClientRect();
        const midVp = dualRect.left + ((loPct + hiPct) / 200) * dualRect.width;
        const labelW = touchHint.offsetWidth;
        const m = 18;
        let leftVp = midVp - labelW / 2;
        if (leftVp < m) leftVp = m;
        if (leftVp + labelW > window.innerWidth - m) leftVp = window.innerWidth - m - labelW;
        touchHint.style.left = (leftVp - parentRect.left) + 'px';
      }
    }
  }

  function positionHitZones() {
    if (!hitZoneLo || !hitZoneHi || !dual || frames.length < 2) return;
    const dualRect = dual.getBoundingClientRect();
    const bottombar = document.querySelector('.bottombar');
    const bottombarRect = bottombar ? bottombar.getBoundingClientRect() : dualRect;
    const total = frames.length - 1;
    const xLo = dualRect.left + (rangeLo / total) * dualRect.width;
    const xHi = dualRect.left + (rangeHi / total) * dualRect.width;
    const mid = (xLo + xHi) / 2;
    const yTop = bottombarRect.top;
    const yBot = window.innerHeight;
    hitZoneLo.style.left = dualRect.left + 'px';
    hitZoneLo.style.top = yTop + 'px';
    hitZoneLo.style.width = Math.max(0, mid - dualRect.left) + 'px';
    hitZoneLo.style.height = Math.max(0, yBot - yTop) + 'px';
    hitZoneHi.style.left = mid + 'px';
    hitZoneHi.style.top = yTop + 'px';
    hitZoneHi.style.width = Math.max(0, dualRect.right - mid) + 'px';
    hitZoneHi.style.height = Math.max(0, yBot - yTop) + 'px';
  }

  function positionThumbLabels() {
    if (!thumbLabelLo || !thumbLabelHi || !dual) return;
    thumbLabelLo.style.marginLeft = '0px';
    thumbLabelHi.style.marginLeft = '0px';
    const dualRect = dual.getBoundingClientRect();
    if (!dualRect.width || frames.length < 2) return;
    const loW = thumbLabelLo.offsetWidth;
    const hiW = thumbLabelHi.offsetWidth;
    const loCenter = dualRect.left + (frameToPct(rangeLo) / 100) * dualRect.width;
    const hiCenter = dualRect.left + (frameToPct(rangeHi) / 100) * dualRect.width;
    const gap = 6;
    let loShift = 0, hiShift = 0;
    const overlap = (loCenter + loShift + loW / 2 + gap) - (hiCenter + hiShift - hiW / 2);
    if (overlap > 0) { loShift = -overlap / 2; hiShift = overlap / 2; }
    const vw = window.innerWidth;
    const m = 18;
    const loLeft = loCenter + loShift - loW / 2;
    const loRight = loCenter + loShift + loW / 2;
    if (loLeft < m) loShift += m - loLeft;
    else if (loRight > vw - m) loShift += vw - m - loRight;
    const hiLeft = hiCenter + hiShift - hiW / 2;
    const hiRight = hiCenter + hiShift + hiW / 2;
    if (hiLeft < m) hiShift += m - hiLeft;
    else if (hiRight > vw - m) hiShift += vw - m - hiRight;
    thumbLabelLo.style.marginLeft = loShift + 'px';
    thumbLabelHi.style.marginLeft = hiShift + 'px';
  }
  window.addEventListener('resize', renderThumbs);

  // ── event annotations ──────────────────────────────────────
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
    dialog.style.top  = `${ypx - 16}px`;
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
    const ts = frames[idx].ts;
    const tMs = Date.parse(ts);
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

  // ── anchors / day marks ────────────────────────────────────
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
      if (a.title) lbl.title = `${a.title} — ${frames[a.idx].ts.replace('T', ' ')}`;
      anchorLabels.appendChild(lbl);
    }
  }

  function snapToDay(val) {
    if (frames.length < 2) return val;
    const tol = Math.max(2, Math.floor(frames.length * 0.01));
    for (const a of anchors) {
      if (Math.abs(val - a.idx) <= tol) return a.idx;
    }
    return val;
  }

  // ── range UI + dragging ────────────────────────────────────
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
    rangeEndLbl.style.color = atCurrent ? '#7fd17a' : '#aab';
    if (idx < rangeLo) idx = rangeLo;
    if (idx > rangeHi) idx = rangeHi;
    renderThumbs();
    preloadAround(idx);
    preloadThumbRange();
  }

  function resumeFromStart() {
    idx = rangeLo;
    show(idx);
    playing = true;
    setPlayBtn('Pause');
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
    const HIT = 36;
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

  function startRangeDrag(e, forced) {
    if (!frames.length) return;
    e.preventDefault();
    e.stopPropagation();
    try { dual.setPointerCapture(e.pointerId); } catch {}
    activeDrag = forced || pickActive(e.clientX);
    playing = false;
    setPlayBtn('Play');
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
      setPlayBtn('Pause');
    };
    dual.addEventListener('pointermove', onMove);
    dual.addEventListener('pointerup', onUp);
    dual.addEventListener('pointercancel', onUp);
  }

  dual.addEventListener('pointerdown', (e) => startRangeDrag(e));
  if (thumbLabelLo) thumbLabelLo.addEventListener('pointerdown', (e) => startRangeDrag(e, 'lo'));
  if (thumbLabelHi) thumbLabelHi.addEventListener('pointerdown', (e) => startRangeDrag(e, 'hi'));
  if (hitZoneLo)    hitZoneLo.addEventListener('pointerdown',    (e) => startRangeDrag(e, 'lo'));
  if (hitZoneHi)    hitZoneHi.addEventListener('pointerdown',    (e) => startRangeDrag(e, 'hi'));

  // ── frame display + publish ────────────────────────────────
  function show(i) {
    if (!frames.length) return;
    idx = Math.max(rangeLo, Math.min(rangeHi, i));
    const f = frames[idx];
    const token = ++_showToken;
    const fullUrl = imgUrl(f.name);

    if (cache.ready(idx)) {
      img.src = fullUrl;
      setLoading(false);
    } else {
      img.src = thumbUrl(f.name);
      setLoading(!cache.readyThumb(idx));
      if (!dragging) {
        const fullImg = cache.ensure(f.name);
        if (fullImg) {
          const swap = () => {
            if (token !== _showToken) return;
            img.src = fullUrl;
            setLoading(false);
          };
          if (fullImg.complete && fullImg.naturalWidth > 0) swap();
          else {
            fullImg.addEventListener('load', swap, { once: true });
            fullImg.addEventListener('error', () => { if (token === _showToken) setLoading(false); }, { once: true });
          }
        }
      }
    }
    tsLabel.textContent = fmtTsHuman(f.ts);
    renderThumbs();
    updateTimeLabel(f.ts);
    renderActiveEvents();
    if (!dragging) preloadAround(idx);
    if (TOUCH_MODE) publishTouchState();
  }

  function publishTouchState() {
    if (!frames.length || !window.SkyController) return;
    const f = frames[idx];
    if (!f) return;
    window.SkyController.publish({
      frame: f.name,
      ts: f.ts,
      camera: CAMERA || null,
      playing,
      range_lo_ts: frames[rangeLo]?.ts || null,
      range_hi_ts: frames[rangeHi]?.ts || null,
    });
  }

  img.addEventListener('load',  () => setLoading(false));
  img.addEventListener('error', () => setLoading(false));

  // ── windowed inits + idle reset ────────────────────────────
  function findAnchorFor(day, kind) {
    const sun = sunTimes[day];
    if (!sun || !sun[kind]) return -1;
    const [th, tm] = sun[kind].split(':').map(Number);
    let target = th * 60 + tm;
    if (kind === 'sunrise') target -= SUNRISE_HEAD;
    let best = -1, bestDiff = Infinity;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].ts.slice(0, 10) !== day) continue;
      const [hh, mm] = frames[i].ts.slice(11).split(':').map(Number);
      const diff = Math.abs(hh * 60 + mm - target);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return bestDiff <= 120 ? best : -1;
  }

  function applyWindowedInit() {
    if (!frames.length) return;
    const firstDay = frames[0].ts.slice(0, 10);
    let anchor = findAnchorFor(firstDay, 'sunrise');
    const hasSunrise = anchor >= 0;
    if (!hasSunrise) anchor = 0;
    presetActive = hasSunrise;
    activePresetLabel = hasSunrise ? `${fmtMD(firstDay)} sunrise` : null;
    refreshActivePreset();
    rangeLo = anchor;
    rangeHi = frames.length - 1;
    applyRangeUI();
    idx = rangeLo;
    show(idx);
    playing = true;
    setPlayBtn('Pause');
  }

  function applyIdleReset() {
    if (!frames.length) return;
    const today = frames[frames.length - 1].ts.slice(0, 10);
    const days = Object.keys(sunTimes).sort();
    const todayIdx = days.indexOf(today);
    const yesterday = todayIdx > 0 ? days[todayIdx - 1] : null;
    let anchor = findAnchorFor(today, 'sunrise');
    let anchorDay = today;
    if (anchor < 0 && yesterday) { anchor = findAnchorFor(yesterday, 'sunrise'); anchorDay = yesterday; }
    if (anchor < 0) anchor = 0;
    presetActive = true;
    activePresetLabel = `Today (${fmtMD(anchorDay)})\nsunrise → NOW`;
    refreshActivePreset();
    rangeLo = anchor;
    rangeHi = frames.length - 1;
    applyRangeUI();
    idx = rangeLo;
    show(idx);
    playing = true;
    setPlayBtn('Pause');
  }

  // ── playback loop ──────────────────────────────────────────
  function tick() {
    if (!playing || !frames.length) return;
    const next = idx >= rangeHi ? rangeLo : idx + 1;
    if (!cache.ready(next)) { setLoading(true); preloadAround(next); return; }
    if (idx >= rangeHi) {
      if (resetPending) {
        resetPending = false;
        applyIdleReset();
        return;
      }
      idx = rangeLo;
    } else {
      idx++;
    }
    show(idx);
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000 / FPS);
  }

  if (playBtn) {
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playing = !playing;
      setPlayBtn(playing ? 'Pause' : 'Play');
    });
    playBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  }

  // ── camera switcher (custom: routes /touch vs /live by path) ─
  async function buildCameraSwitcher() {
    try {
      const r = await fetch('/api/cameras');
      const data = await r.json();
      const cams = data.cameras_public || (data.cameras || []).map((n) => ({ name: n, label: n }));
      const def = data.default;
      if (cams.length <= 1) return;
      const container = document.getElementById('cameraSwitcher');
      container.innerHTML = '';
      const active = CAMERA || def;
      for (const cam of cams) {
        const name = cam.name;
        const btn = document.createElement('button');
        const arrow = document.createElement('span');
        arrow.className = 'cam-arrow';
        arrow.textContent = '›';
        const label = document.createElement('span');
        label.textContent = cam.label || name;
        btn.append(arrow, label);
        if (name === active) btn.classList.add('active');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (name === active) return;
          const base = window.location.pathname.startsWith('/touch') ? '/touch' : '/live';
          window.location.href = `${base}/${encodeURIComponent(name)}`;
        });
        btn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        container.appendChild(btn);
      }
      positionOverlays();
    } catch (e) { console.warn('camera switcher failed', e); }
  }

  // ── boot ───────────────────────────────────────────────────
  (async () => {
    await buildCameraSwitcher();
    if (TOUCH_MODE && window.SkyController) await window.SkyController.init(CAMERA || null);
    await loadSunTimes();
    await loadFrames();
    await loadEvents();
    if (TOUCH_MODE && frames.length) {
      if (DAYS > 0) applyWindowedInit();
      else          applyIdleReset();
    }
    if (frames.length) show(idx);
    if (instructionsOn && frames.length) {
      document.body.classList.add('show-instructions');
      renderThumbs();
    }
    restartTimer();
    setInterval(async () => { await loadSunTimes(); await loadFrames(); await loadEvents(); }, 30_000);
  })();
})();
