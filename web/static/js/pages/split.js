/*
 * split.js — dual-camera time-aligned comparison view.
 *
 * Reads window.__SKY = { left, right, days, cameras: [...] } from
 * templates/split.html. Requires lib/playback.js and lib/controller.js.
 *
 * Difference from live.js: this page uses *timestamps* (ms epoch) as the
 * scrubbing primitive rather than frame indices, so the two cameras can
 * share a single playhead even if their capture cadence differs.
 */
(function () {
  'use strict';

  const ctx = window.__SKY || {};
  let LEFT  = ctx.left;
  let RIGHT = ctx.right;
  const DAYS = ctx.days || 0;
  const ALL_CAMS = ctx.cameras || [];
  const CAM_LABEL = Object.fromEntries(ALL_CAMS.map((c) => [c.name, c.label || c.name]));
  const camLabel = (n) => CAM_LABEL[n] || n;

  const SP = window.SkyPlayback;
  const { imgUrl: _imgUrl, thumbUrl: _thumbUrl, fmtTsHuman, fmtMD, fmt12hm, hhmmToMin, timeColor, PreloadCache } = SP;

  // ── constants ──────────────────────────────────────────────
  const TICK_MS = 100;
  const ADVANCE_SEC = 30;
  const NEAR_TOL_SEC = 240;
  const FS_IDLE_MS = 60_000;
  const SUNRISE_HEAD = 30, SUNRISE_TAIL = 60;
  const DAY_PAD = 30;
  const SUNSET_HEAD = 30, SUNSET_TAIL = 60;
  const MIRROR_KEY = 'split_mirror_side';

  // ── DOM refs ───────────────────────────────────────────────
  const dual           = document.getElementById('dual');
  const thumbLo        = document.getElementById('thumbLo');
  const thumbHi        = document.getElementById('thumbHi');
  const playhead       = document.getElementById('playhead');
  const selBar         = document.getElementById('selBar');
  const dayMarks       = document.getElementById('dayMarks');
  const sunMarks       = document.getElementById('sunMarks');
  const anchorLabels   = document.getElementById('anchorLabels');
  const rangePresets   = document.getElementById('rangePresets');
  const thumbTooltip   = document.getElementById('thumbTooltip');
  const rangeStartLbl  = document.getElementById('rangeStartLabel');
  const rangeEndLbl    = document.getElementById('rangeEndLabel');
  const currentTsLabel = document.getElementById('currentTsLabel');
  const playBtn        = document.getElementById('playBtn');
  const leftSel        = document.getElementById('leftSel');
  const rightSel       = document.getElementById('rightSel');
  const swapBtn        = document.getElementById('swapBtn');
  const mirrorBtn      = document.getElementById('mirrorBtn');
  const mirrorLabel    = document.getElementById('mirrorLabel');
  const stagesEl       = document.querySelector('.stages');

  // ── camera state ───────────────────────────────────────────
  const cams = [
    { name: LEFT,
      frames: [], cache: new PreloadCache({ camera: LEFT,  ahead: 60, behind: 30, cap: 600 }),
      imgEl:   document.getElementById('frameL'),
      tsEl:    document.getElementById('tsL'),
      stageEl: document.getElementById('stageL'),
      lastShownIdx: -1 },
    { name: RIGHT,
      frames: [], cache: new PreloadCache({ camera: RIGHT, ahead: 60, behind: 30, cap: 600 }),
      imgEl:   document.getElementById('frameR'),
      tsEl:    document.getElementById('tsR'),
      stageEl: document.getElementById('stageR'),
      lastShownIdx: -1 },
  ];

  // ── shared playhead state (timestamp ms) ───────────────────
  let unionLoTs = 0, unionHiTs = 0;
  let userLoTs = 0, userHiTs = 0;
  let currentTs = 0;
  let playing = true;
  let dragging = false;
  let activeDrag = null;
  let sunTimes = {};
  let activePresetLabel = null;
  let _showToken = 0;
  let tickTimer = null;
  let fsIdleTimer = null;
  let pairedTv = false;
  let mirrorSide = 'left';
  try {
    const stored = localStorage.getItem(MIRROR_KEY);
    if (stored === 'left' || stored === 'right') mirrorSide = stored;
  } catch {}

  // ── helpers ────────────────────────────────────────────────
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const setPlayBtn = (t) => { playBtn.textContent = t; };

  function buildSinceParam() {
    if (DAYS <= 0) return null;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1));
    return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}_00-00-00`;
  }

  const imgUrlFor   = (name, cam) => _imgUrl(name, cam);
  const thumbUrlFor = (name, cam) => _thumbUrl(name, cam);

  function nearestIdx(frames, tsMs) {
    if (!frames.length) return -1;
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (frames[m].tsMs < tsMs) lo = m + 1; else hi = m;
    }
    if (lo > 0 && Math.abs(frames[lo - 1].tsMs - tsMs) < Math.abs(frames[lo].tsMs - tsMs)) lo--;
    return lo;
  }

  function tsPct(tsMs) {
    const span = unionHiTs - unionLoTs;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(100, ((tsMs - unionLoTs) / span) * 100));
  }

  const pointerToTs = (clientX) => {
    const rect = dual.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return unionLoTs + pct * (unionHiTs - unionLoTs);
  };

  function fmtTsHumanLocal(tsMs) {
    const d = new Date(tsMs);
    const mo = d.getMonth() + 1, dd = d.getDate();
    let h = d.getHours();
    const mm = pad2(d.getMinutes()), ss = pad2(d.getSeconds());
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${mo}/${dd} ${h}:${mm}:${ss} ${ampm}`;
  }

  function tsAtDayHHMM(day, minutes) {
    const [y, mo, dd] = day.split('-').map(Number);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return new Date(y, mo - 1, dd, h, m, 0).getTime();
  }

  // ── data loading ───────────────────────────────────────────
  async function loadCamFrames(c) {
    const since = buildSinceParam();
    const base = since ? `/api/frames?since=${encodeURIComponent(since)}` : '/api/frames';
    const url = `${base}${base.includes('?') ? '&' : '?'}camera=${encodeURIComponent(c.name)}`;
    try {
      const r = await fetch(url);
      const data = await r.json();
      c.frames = data.map((f) => ({ ...f, tsMs: Date.parse(f.ts) })).filter((f) => !isNaN(f.tsMs));
      c.cache.setFrames(c.frames);
      c.stageEl.querySelector('.empty')?.remove();
      if (!c.frames.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = 'no frames yet';
        c.stageEl.appendChild(e);
      }
    } catch (e) {
      console.warn(`load frames ${c.name} failed`, e);
      c.frames = [];
    }
  }

  async function loadSunTimes() {
    try {
      const r = await fetch(`/api/anchors?camera=${encodeURIComponent(LEFT)}`);
      const data = await r.json();
      sunTimes = {};
      for (const d of data) sunTimes[d.day] = { sunrise: d.sunrise, sunset: d.sunset };
    } catch (e) { console.warn('sun times failed', e); }
  }

  function computeUnion() {
    const lows  = cams.map((c) => c.frames[0]?.tsMs).filter((v) => v != null);
    const highs = cams.map((c) => c.frames[c.frames.length - 1]?.tsMs).filter((v) => v != null);
    if (!lows.length || !highs.length) { unionLoTs = unionHiTs = 0; return; }
    unionLoTs = Math.min(...lows);
    unionHiTs = Math.max(...highs);
    if (userLoTs < unionLoTs || userLoTs > unionHiTs) userLoTs = unionLoTs;
    if (userHiTs <= 0 || userHiTs < unionLoTs || userHiTs > unionHiTs) userHiTs = unionHiTs;
    if (currentTs < userLoTs || currentTs > userHiTs) currentTs = userLoTs;
  }

  // ── rendering ──────────────────────────────────────────────
  function applyRangeUI() {
    if (unionHiTs <= unionLoTs) {
      selBar.style.width = '0%';
      rangeStartLbl.textContent = '--';
      rangeEndLbl.textContent = '--';
      return;
    }
    const loPct = tsPct(userLoTs);
    const hiPct = tsPct(userHiTs);
    selBar.style.left = `${loPct}%`;
    selBar.style.width = `${Math.max(0, hiPct - loPct)}%`;
    thumbLo.style.left = `${loPct}%`;
    thumbHi.style.left = `${hiPct}%`;
    rangeStartLbl.textContent = fmtTsHumanLocal(userLoTs);
    const atCurrent = userHiTs >= unionHiTs - 500;
    rangeEndLbl.textContent = atCurrent
      ? `NOW (${fmtTsHumanLocal(userHiTs)})`
      : fmtTsHumanLocal(userHiTs);
    rangeEndLbl.style.color = atCurrent ? '#7fd17a' : '#aab';
    renderPlayhead();
    renderDayMarks();
    renderAnchors();
  }

  function renderPlayhead() {
    if (unionHiTs <= unionLoTs) return;
    playhead.style.left = `${tsPct(currentTs)}%`;
    currentTsLabel.textContent = fmtTsHumanLocal(currentTs);
  }

  function dayBoundariesInUnion() {
    const out = [];
    const start = new Date(unionLoTs);
    start.setHours(0, 0, 0, 0);
    for (let d = new Date(start); d.getTime() <= unionHiTs; d.setDate(d.getDate() + 1)) {
      if (d.getTime() >= unionLoTs && d.getTime() <= unionHiTs) out.push(d.getTime());
    }
    return out;
  }

  function renderDayMarks() {
    dayMarks.innerHTML = '';
    for (const tsMs of dayBoundariesInUnion()) {
      const s = document.createElement('span');
      s.style.left = `${tsPct(tsMs)}%`;
      dayMarks.appendChild(s);
    }
    sunMarks.innerHTML = '';
    for (const day of Object.keys(sunTimes).sort()) {
      const sun = sunTimes[day];
      if (!sun) continue;
      if (sun.sunrise) {
        const ts = tsAtDayHHMM(day, hhmmToMin(sun.sunrise));
        if (ts >= unionLoTs && ts <= unionHiTs) {
          const m = document.createElement('span');
          m.className = 'sr';
          m.style.left = `${tsPct(ts)}%`;
          sunMarks.appendChild(m);
        }
      }
      if (sun.sunset) {
        const ts = tsAtDayHHMM(day, hhmmToMin(sun.sunset));
        if (ts >= unionLoTs && ts <= unionHiTs) {
          const m = document.createElement('span');
          m.className = 'ss';
          m.style.left = `${tsPct(ts)}%`;
          sunMarks.appendChild(m);
        }
      }
    }
  }

  function renderAnchors() {
    anchorLabels.innerHTML = '';
    const days = Object.keys(sunTimes).sort();
    for (const day of days) {
      const sun = sunTimes[day];
      if (!sun) continue;
      const [y, mo, dd] = day.split('-').map(Number);
      const ts0 = new Date(y, mo - 1, dd).getTime();
      if (ts0 < unionLoTs - 86_400_000 || ts0 > unionHiTs + 86_400_000) continue;
      const noonTs = new Date(y, mo - 1, dd, 12, 0, 0).getTime();
      if (noonTs >= unionLoTs && noonTs <= unionHiTs) {
        const s = document.createElement('span');
        s.textContent = `${mo}/${dd}`;
        s.style.left = `${tsPct(noonTs)}%`;
        anchorLabels.appendChild(s);
      }
      if (sun.sunrise) {
        const ts = tsAtDayHHMM(day, hhmmToMin(sun.sunrise));
        if (ts >= unionLoTs && ts <= unionHiTs) {
          const s = document.createElement('span');
          s.className = 'sr-label';
          s.textContent = `↑${fmt12hm(sun.sunrise)}`;
          s.style.left = `${tsPct(ts)}%`;
          anchorLabels.appendChild(s);
        }
      }
      if (sun.sunset) {
        const ts = tsAtDayHHMM(day, hhmmToMin(sun.sunset));
        if (ts >= unionLoTs && ts <= unionHiTs) {
          const s = document.createElement('span');
          s.className = 'ss-label';
          s.textContent = `↓${fmt12hm(sun.sunset)}`;
          s.style.left = `${tsPct(ts)}%`;
          anchorLabels.appendChild(s);
        }
      }
    }
  }

  function applyTimelineGradient() {
    const track = document.querySelector('.rangebar .track');
    if (!track || unionHiTs <= unionLoTs) return;
    const steps = 80;
    const stops = [];
    for (let i = 0; i <= steps; i++) {
      const ts = unionLoTs + (i / steps) * (unionHiTs - unionLoTs);
      const d = new Date(ts);
      const minute = d.getHours() * 60 + d.getMinutes();
      stops.push(`${timeColor(minute)} ${(i * 100 / steps).toFixed(1)}%`);
    }
    track.style.background = `linear-gradient(to right, ${stops.join(',')})`;
  }

  // ── presets ────────────────────────────────────────────────
  function refreshActivePreset() {
    for (const b of rangePresets.querySelectorAll('button')) {
      b.classList.toggle('active', activePresetLabel && b.dataset.label === activePresetLabel);
    }
  }

  function applyPreset(loTs, hiTs, label) {
    userLoTs = Math.max(unionLoTs, loTs);
    userHiTs = Math.min(unionHiTs, hiTs);
    if (userHiTs <= userLoTs) return;
    currentTs = userLoTs;
    activePresetLabel = label || null;
    refreshActivePreset();
    applyRangeUI();
    for (const c of cams) c.lastShownIdx = -1;
    showAllAt(currentTs);
    playing = true;
    setPlayBtn('Pause');
  }

  function addPresetButton(label, cls, loTs, hiTs) {
    const btn = document.createElement('button');
    if (cls) btn.className = cls;
    btn.dataset.label = label;
    btn.textContent = label;
    btn.addEventListener('click', (e) => { e.stopPropagation(); applyPreset(loTs, hiTs, label); });
    rangePresets.appendChild(btn);
  }

  function buildPresets() {
    rangePresets.innerHTML = '';
    if (unionHiTs <= unionLoTs) return;

    addPresetButton('Everything', 'preset-everything', unionLoTs, unionHiTs);

    const daysSeen = new Set();
    for (const c of cams) for (const f of c.frames) daysSeen.add(f.ts.slice(0, 10));
    const days = [...daysSeen].sort();
    if (!days.length) return;
    const todayKey = days[days.length - 1];

    const chrono = [];
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      const sun = sunTimes[day] || {};
      const sr = sun.sunrise ? hhmmToMin(sun.sunrise) : null;
      const ss = sun.sunset  ? hhmmToMin(sun.sunset)  : null;
      const md = fmtMD(day);
      if (sr !== null) {
        chrono.push({ label: `${md} sunrise`, cls: 'preset-sunrise',
          lo: tsAtDayHHMM(day, sr - SUNRISE_HEAD), hi: tsAtDayHHMM(day, sr + SUNRISE_TAIL) });
      }
      if (sr !== null && ss !== null) {
        chrono.push({ label: `${md} day`, cls: 'preset-day',
          lo: tsAtDayHHMM(day, sr + SUNRISE_TAIL), hi: tsAtDayHHMM(day, ss - DAY_PAD) });
      }
      if (ss !== null) {
        chrono.push({ label: `${md} sunset`, cls: 'preset-sunset',
          lo: tsAtDayHHMM(day, ss - SUNSET_HEAD), hi: tsAtDayHHMM(day, ss + SUNSET_TAIL) });
      }
      if (di < days.length - 1) {
        const nextDay = days[di + 1];
        const srNext = sunTimes[nextDay]?.sunrise ? hhmmToMin(sunTimes[nextDay].sunrise) : null;
        if (ss !== null && srNext !== null) {
          chrono.push({ label: `Night ${md} → ${fmtMD(nextDay)}`, cls: 'preset-night',
            lo: tsAtDayHHMM(day, ss + SUNSET_TAIL), hi: tsAtDayHHMM(nextDay, srNext - SUNRISE_HEAD) });
        }
      }
    }
    chrono.sort((a, b) => a.lo - b.lo);
    for (const b of chrono) addPresetButton(b.label, b.cls, b.lo, b.hi);

    const todaySun = sunTimes[todayKey];
    if (todaySun?.sunrise) {
      const sr = hhmmToMin(todaySun.sunrise);
      addPresetButton(`Today (${fmtMD(todayKey)})\nsunrise → NOW`, 'preset-today',
        tsAtDayHHMM(todayKey, sr - SUNRISE_HEAD), unionHiTs);
    }

    const lastHourLo = unionHiTs - 60 * 60 * 1000;
    if (lastHourLo > unionLoTs) {
      const startLbl = fmt12hm(new Date(lastHourLo).toTimeString().slice(0, 5));
      addPresetButton(`Last hour\n${startLbl} → NOW`, 'preset-today', lastHourLo, unionHiTs);
    }

    refreshActivePreset();
  }

  // ── frame display ──────────────────────────────────────────
  function showAllAt(tsMs) {
    for (const c of cams) showCamAt(c, tsMs);
    renderPlayhead();
    publishMirror();
  }

  function showCamAt(c, tsMs) {
    if (!c.frames.length) {
      c.tsEl.textContent = '--';
      c.tsEl.classList.add('stale');
      return;
    }
    const i = nearestIdx(c.frames, tsMs);
    if (i < 0) return;
    const f = c.frames[i];
    const drift = Math.abs(f.tsMs - tsMs) / 1000;
    if (drift > NEAR_TOL_SEC) {
      c.tsEl.classList.add('stale');
      return;
    }
    c.tsEl.classList.remove('stale');
    if (i === c.lastShownIdx) {
      c.tsEl.textContent = fmtTsHuman(f.ts);
      return;
    }
    const token = ++_showToken;
    if (c.cache.ready(i)) {
      c.imgEl.src = imgUrlFor(f.name, c.name);
    } else {
      c.imgEl.src = thumbUrlFor(f.name, c.name);
      const fullImg = c.cache.ensure(f.name);
      if (fullImg) {
        const swap = () => {
          if (token !== _showToken || c.lastShownIdx !== i) return;
          c.imgEl.src = imgUrlFor(f.name, c.name);
        };
        if (fullImg.complete && fullImg.naturalWidth > 0) swap();
        else fullImg.addEventListener('load', swap, { once: true });
      }
    }
    c.lastShownIdx = i;
    c.cache.around(i, 0, c.frames.length - 1);
    c.tsEl.textContent = fmtTsHuman(f.ts);
  }

  function tick() {
    if (!playing || dragging) return;
    currentTs += ADVANCE_SEC * 1000;
    if (currentTs > userHiTs) currentTs = userLoTs;
    showAllAt(currentTs);
  }

  function restartTimer() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_MS);
  }

  playBtn.addEventListener('click', () => {
    playing = !playing;
    setPlayBtn(playing ? 'Pause' : 'Play');
  });

  // ── range bar interaction ──────────────────────────────────
  function pickActive(clientX) {
    const r = dual.getBoundingClientRect();
    const span = unionHiTs - unionLoTs;
    if (span <= 0) return 'playhead';
    const xLo = r.left + ((userLoTs   - unionLoTs) / span) * r.width;
    const xHi = r.left + ((userHiTs   - unionLoTs) / span) * r.width;
    const xPh = r.left + ((currentTs - unionLoTs) / span) * r.width;
    const HIT = 36;
    const cands = [
      ['playhead', Math.abs(clientX - xPh)],
      ['lo',       Math.abs(clientX - xLo)],
      ['hi',       Math.abs(clientX - xHi)],
    ].sort((a, b) => a[1] - b[1]);
    return cands[0][1] <= HIT ? cands[0][0] : 'playhead';
  }

  function showTooltip(tsMs, clientX) {
    thumbTooltip.textContent = fmtTsHumanLocal(tsMs);
    const rect = dual.getBoundingClientRect();
    thumbTooltip.style.left = `${clientX}px`;
    thumbTooltip.style.top = `${rect.top}px`;
    thumbTooltip.classList.add('show');
  }
  const hideTooltip = () => thumbTooltip.classList.remove('show');

  function updateDrag(clientX) {
    if (!activeDrag || unionHiTs <= unionLoTs) return;
    let v = pointerToTs(clientX);
    v = Math.max(unionLoTs, Math.min(unionHiTs, v));
    if (activeDrag === 'lo') {
      userLoTs = Math.min(v, userHiTs - 1000);
      if (currentTs < userLoTs) currentTs = userLoTs;
    } else if (activeDrag === 'hi') {
      userHiTs = Math.max(v, userLoTs + 1000);
      if (currentTs > userHiTs) currentTs = userHiTs;
    } else {
      if (v < userLoTs) userLoTs = v;
      if (v > userHiTs) userHiTs = v;
      currentTs = v;
    }
    activePresetLabel = null;
    refreshActivePreset();
    applyRangeUI();
    showAllAt(currentTs);
    const anchorTs = activeDrag === 'lo' ? userLoTs : activeDrag === 'hi' ? userHiTs : currentTs;
    showTooltip(anchorTs, clientX);
  }

  dual.addEventListener('pointerdown', (e) => {
    if (unionHiTs <= unionLoTs) return;
    e.preventDefault();
    try { dual.setPointerCapture(e.pointerId); } catch {}
    activeDrag = pickActive(e.clientX);
    playing = false;
    setPlayBtn('Play');
    dragging = true;
    updateDrag(e.clientX);
    const onMove = (ev) => updateDrag(ev.clientX);
    const onUp = () => {
      activeDrag = null;
      dragging = false;
      hideTooltip();
      dual.removeEventListener('pointermove', onMove);
      dual.removeEventListener('pointerup', onUp);
      dual.removeEventListener('pointercancel', onUp);
      for (const c of cams) c.cache.abortPending();
      showAllAt(currentTs);
      playing = true;
      setPlayBtn('Pause');
    };
    dual.addEventListener('pointermove', onMove);
    dual.addEventListener('pointerup', onUp);
    dual.addEventListener('pointercancel', onUp);
  });

  // ── camera selectors + swap ────────────────────────────────
  function buildSelectors() {
    for (const sel of [leftSel, rightSel]) {
      sel.innerHTML = '';
      for (const c of ALL_CAMS) {
        const o = document.createElement('option');
        o.value = c.name; o.textContent = c.label || c.name;
        sel.appendChild(o);
      }
    }
    leftSel.value = LEFT;
    rightSel.value = RIGHT;
    function navigate(l, r) {
      if (!l || !r || l === r) return;
      const q = new URLSearchParams(window.location.search);
      q.set('left', l); q.set('right', r);
      window.location.href = `/split?${q.toString()}`;
    }
    leftSel.addEventListener('change', () => {
      const l = leftSel.value;
      let r = rightSel.value;
      if (r === l) r = (ALL_CAMS.find((c) => c.name !== l) || {}).name || r;
      navigate(l, r);
    });
    rightSel.addEventListener('change', () => {
      const r = rightSel.value;
      let l = leftSel.value;
      if (l === r) l = (ALL_CAMS.find((c) => c.name !== r) || {}).name || l;
      navigate(l, r);
    });
    swapBtn.addEventListener('click', (e) => { e.stopPropagation(); swapInPlace(); });
  }

  function swapInPlace() {
    const a = cams[0], b = cams[1];
    [a.imgEl,   b.imgEl]   = [b.imgEl,   a.imgEl];
    [a.tsEl,    b.tsEl]    = [b.tsEl,    a.tsEl];
    [a.stageEl, b.stageEl] = [b.stageEl, a.stageEl];
    a.lastShownIdx = -1;
    b.lastShownIdx = -1;
    [LEFT, RIGHT] = [RIGHT, LEFT];
    leftSel.value = LEFT;
    rightSel.value = RIGHT;
    for (const c of cams) {
      const lbl = c.stageEl.querySelector('.cam-label');
      if (lbl) lbl.textContent = camLabel(c.name);
    }
    const q = new URLSearchParams(window.location.search);
    q.set('left', LEFT); q.set('right', RIGHT);
    history.replaceState(null, '', `/split?${q.toString()}`);
    applyMirrorUI();
    showAllAt(currentTs);
  }

  // ── reload + refresh ───────────────────────────────────────
  async function reload() {
    await Promise.all(cams.map(loadCamFrames));
    computeUnion();
    applyTimelineGradient();
    applyRangeUI();
    buildPresets();
    for (const c of cams) c.lastShownIdx = -1;
    showAllAt(currentTs);
  }

  // ── fullscreen ─────────────────────────────────────────────
  function exitFullscreen()  { if (document.fullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); }
  function enterFullscreen() { (stagesEl.requestFullscreen || stagesEl.webkitRequestFullscreen)?.call(stagesEl); }
  function toggleFullscreen() { if (document.fullscreenElement) exitFullscreen(); else enterFullscreen(); }
  function resetFsIdle() {
    if (!document.fullscreenElement) return;
    clearTimeout(fsIdleTimer);
    fsIdleTimer = setTimeout(exitFullscreen, FS_IDLE_MS);
  }

  stagesEl.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) resetFsIdle();
    else { clearTimeout(fsIdleTimer); fsIdleTimer = null; }
  });
  ['mousemove', 'touchstart', 'click', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, resetFsIdle, { passive: true }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'f' && e.key !== 'F') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    toggleFullscreen();
  });

  // ── mirror-to-TV ───────────────────────────────────────────
  const activeMirrorCam = () => (mirrorSide === 'left' ? cams[0] : cams[1]);

  function applyMirrorUI() {
    const c = activeMirrorCam();
    mirrorLabel.textContent = `Mirror: ${camLabel(c.name)}`;
    cams[0].stageEl.classList.toggle('mirroring', pairedTv && mirrorSide === 'left');
    cams[1].stageEl.classList.toggle('mirroring', pairedTv && mirrorSide === 'right');
    mirrorBtn.classList.toggle('show', pairedTv);
  }

  function publishMirror() {
    if (!pairedTv || !window.SkyController) return;
    const c = activeMirrorCam();
    if (!c.frames.length || c.lastShownIdx < 0) return;
    const f = c.frames[c.lastShownIdx];
    if (!f) return;
    window.SkyController.publish({
      frame: f.name,
      ts: f.ts,
      camera: c.name,
      playing,
      range_lo_ts: new Date(userLoTs).toISOString().slice(0, 19),
      range_hi_ts: new Date(userHiTs).toISOString().slice(0, 19),
    });
  }

  mirrorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mirrorSide = mirrorSide === 'left' ? 'right' : 'left';
    try { localStorage.setItem(MIRROR_KEY, mirrorSide); } catch {}
    applyMirrorUI();
    publishMirror();
  });

  async function refreshPairStatus(myId) {
    try {
      const r = await fetch('/api/sessions', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      const me = (data.touches || []).find((t) => t.id === myId);
      const nowPaired = !!me?.paired_tv_id;
      if (nowPaired !== pairedTv) {
        pairedTv = nowPaired;
        applyMirrorUI();
        if (pairedTv) publishMirror();
      }
    } catch {}
  }

  // ── boot ───────────────────────────────────────────────────
  (async () => {
    buildSelectors();
    await loadSunTimes();
    await reload();
    restartTimer();
    let myId = null;
    if (window.SkyController) myId = await window.SkyController.init(activeMirrorCam().name);
    await refreshPairStatus(myId);
    setInterval(() => refreshPairStatus(myId), 3000);
    setInterval(async () => { await loadSunTimes(); await reload(); }, 30_000);
  })();
})();
