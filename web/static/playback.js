(function () {
  'use strict';

  const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function imgUrl(name, camera) {
    return camera ? `/image/${name}?camera=${encodeURIComponent(camera)}` : `/image/${name}`;
  }

  function thumbUrl(name, camera) {
    const base = `/image/${name}?thumb=1`;
    return camera ? `${base}&camera=${encodeURIComponent(camera)}` : base;
  }

  function readableTs(iso) {
    const [d, t] = iso.split('T');
    const [, mo, dd] = d.split('-');
    const [hh, mm] = t.split(':');
    let h = parseInt(hh, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const dow = WEEKDAYS[new Date(`${d}T${t}`).getDay()];
    return `${dow} ${parseInt(mo,10)}/${parseInt(dd,10)} ${h}:${mm} ${ampm}`;
  }

  function formatTs(iso) {
    if (!iso) return '';
    const [d, t = '00:00:00'] = iso.split('T');
    const [, mo, dd] = d.split('-');
    const [hh, mm, ss] = t.split(':');
    let h = parseInt(hh, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${MONTHS[parseInt(mo,10)-1]} ${parseInt(dd,10)}, ${h}:${mm}:${ss} ${ampm}`;
  }

  function fmtTsHuman(iso) {
    if (!iso) return '';
    const [d, t = '00:00:00'] = iso.split('T');
    const [, mo, dd] = d.split('-');
    const [hh, mm, ss = '00'] = t.split(':');
    let h = parseInt(hh, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${parseInt(mo, 10)}/${parseInt(dd, 10)} ${h}:${mm}:${ss} ${ampm}`;
  }

  function hhmmToMin(hhmm) { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; }

  function fmtMD(day) {
    const [, mo, d] = day.split('-');
    return `${parseInt(mo, 10)}/${parseInt(d, 10)}`;
  }

  function fmt12hm(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hh = h % 12 || 12;
    return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function describePartOfDay(iso, sun) {
    const t = iso.slice(11);
    const [hh, mm] = t.split(':').map(Number);
    const minute = hh * 60 + mm;
    const sr = sun?.sunrise ? hhmmToMin(sun.sunrise) : null;
    const ss = sun?.sunset  ? hhmmToMin(sun.sunset)  : null;
    if (sr !== null && Math.abs(minute - sr) <= 15) return 'Sunrise';
    if (ss !== null && Math.abs(minute - ss) <= 15) return 'Sunset';
    if (sr !== null && minute < sr - 60) return 'Late night';
    if (sr !== null && minute < sr - 15) return 'Pre-dawn';
    if (sr !== null && minute < sr + 90)  return 'Early morning';
    if (minute < 11 * 60)                  return 'Morning';
    if (minute < 13 * 60)                  return 'Noon';
    if (ss !== null && minute > ss + 120) return 'Night';
    if (ss !== null && minute > ss + 30)  return 'Dusk';
    if (ss !== null && minute > ss - 60)  return 'Late afternoon';
    return 'Afternoon';
  }

  const SKY_STOPS = [
    { m: 0,            c: [10, 16, 36] },
    { m: 4 * 60,       c: [22, 32, 70] },
    { m: 5 * 60 + 30,  c: [120, 70, 100] },
    { m: 6 * 60 + 30,  c: [220, 120, 80] },
    { m: 8 * 60,       c: [180, 200, 235] },
    { m: 12 * 60,      c: [155, 195, 240] },
    { m: 17 * 60,      c: [220, 165, 90] },
    { m: 19 * 60,      c: [200, 80, 70] },
    { m: 20 * 60,      c: [90, 40, 80] },
    { m: 22 * 60,      c: [26, 18, 50] },
    { m: 1440,         c: [10, 16, 36] },
  ];

  function timeColor(minute) {
    for (let i = 0; i < SKY_STOPS.length - 1; i++) {
      const a = SKY_STOPS[i], b = SKY_STOPS[i + 1];
      if (minute >= a.m && minute <= b.m) {
        const t = (minute - a.m) / (b.m - a.m || 1);
        const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * t);
        const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * t);
        const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * t);
        return `rgb(${r},${g},${bl})`;
      }
    }
    return 'rgb(10,16,36)';
  }

  function buildGradientFor(frames, lo, hi) {
    if (frames.length < 2 || hi <= lo) return '#1f2630';
    const steps = 80;
    const stops = [];
    for (let i = 0; i <= steps; i++) {
      const fi = Math.min(hi, Math.round(lo + (i / steps) * (hi - lo)));
      const [hh, mm] = frames[fi].ts.slice(11).split(':').map(Number);
      stops.push(`${timeColor(hh * 60 + mm)} ${(i * 100 / steps).toFixed(1)}%`);
    }
    return `linear-gradient(to right, ${stops.join(',')})`;
  }

  function frameTimeColor(frames, i) {
    if (!frames.length || i < 0 || i >= frames.length) return '#e6e9ef';
    const [hh, mm] = frames[i].ts.slice(11).split(':').map(Number);
    return timeColor(hh * 60 + mm);
  }

  class PreloadCache {
    constructor(opts) {
      this.camera = opts.camera || '';
      this.ahead = opts.ahead ?? 60;
      this.behind = opts.behind ?? 30;
      this.cap = opts.cap ?? 600;
      this.thumbCap = opts.thumbCap ?? 8000;
      this.cache = new Map();
      this.thumbCache = new Map();
      this.framesRef = null;
      this.indexByName = new Map();
      this._thumbQueue = [];
      this._thumbScheduled = false;
      this._thumbConcurrency = opts.thumbConcurrency ?? 6;
      this._thumbInFlight = 0;
    }

    setFrames(frames) {
      this.framesRef = frames;
      this.indexByName.clear();
      for (let i = 0; i < frames.length; i++) this.indexByName.set(frames[i].name, i);
      const keep = new Set(frames.map(f => f.name));
      for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
      for (const k of [...this.thumbCache.keys()]) if (!keep.has(k)) this.thumbCache.delete(k);
    }

    _ensure(name) {
      if (this.cache.has(name)) return;
      const im = new Image();
      im.src = imgUrl(name, this.camera);
      this.cache.set(name, im);
    }

    _ensureThumb(name) {
      if (this.thumbCache.has(name)) return;
      const im = new Image();
      const done = () => { this._thumbInFlight--; this._drainThumbQueue(); };
      im.addEventListener('load', done, { once: true });
      im.addEventListener('error', done, { once: true });
      im.src = thumbUrl(name, this.camera);
      this.thumbCache.set(name, im);
      this._thumbInFlight++;
    }

    around(idx, rangeLo, rangeHi) {
      const frames = this.framesRef;
      if (!frames || !frames.length) return;
      const lo = Math.max(rangeLo ?? 0, idx - this.behind);
      const hi = Math.min(rangeHi ?? frames.length - 1, idx + this.ahead);
      for (let i = lo; i <= hi; i++) {
        if (i >= 0 && i < frames.length) this._ensure(frames[i].name);
      }
      this._evictByDistance(idx);
    }

    preloadThumbRange(rangeLo, rangeHi, idx) {
      const frames = this.framesRef;
      if (!frames || !frames.length) return;
      const lo = Math.max(0, rangeLo ?? 0);
      const hi = Math.min(frames.length - 1, rangeHi ?? frames.length - 1);
      const center = Math.max(lo, Math.min(hi, idx ?? Math.floor((lo + hi) / 2)));
      const order = [];
      const maxR = Math.max(center - lo, hi - center);
      for (let r = 0; r <= maxR; r++) {
        if (center - r >= lo) order.push(center - r);
        if (r > 0 && center + r <= hi) order.push(center + r);
      }
      this._thumbQueue = order
        .map(i => frames[i].name)
        .filter(name => !this.thumbCache.has(name));
      this._scheduleThumbDrain();
    }

    _scheduleThumbDrain() {
      if (this._thumbScheduled) return;
      this._thumbScheduled = true;
      const tick = () => {
        this._thumbScheduled = false;
        this._drainThumbQueue();
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(tick, { timeout: 250 });
      } else {
        setTimeout(tick, 16);
      }
    }

    _drainThumbQueue() {
      while (this._thumbQueue.length && this._thumbInFlight < this._thumbConcurrency) {
        const name = this._thumbQueue.shift();
        if (!this.thumbCache.has(name)) this._ensureThumb(name);
      }
      if (this._thumbQueue.length) this._scheduleThumbDrain();
      if (this.thumbCache.size > this.thumbCap) this._evictThumbsByDistance();
    }

    preloadAll(frames) {
      this.setFrames(frames);
      for (const f of frames) this._ensure(f.name);
    }

    _evictByDistance(idx) {
      if (this.cache.size <= this.cap) return;
      const entries = [];
      for (const name of this.cache.keys()) {
        const i = this.indexByName.get(name);
        entries.push({ name, dist: i === undefined ? Infinity : Math.abs(i - idx) });
      }
      entries.sort((a, b) => b.dist - a.dist);
      while (this.cache.size > this.cap && entries.length) {
        this.cache.delete(entries.shift().name);
      }
    }

    _evictThumbsByDistance(idx) {
      if (this.thumbCache.size <= this.thumbCap) return;
      const center = idx ?? 0;
      const entries = [];
      for (const name of this.thumbCache.keys()) {
        const i = this.indexByName.get(name);
        entries.push({ name, dist: i === undefined ? Infinity : Math.abs(i - center) });
      }
      entries.sort((a, b) => b.dist - a.dist);
      while (this.thumbCache.size > this.thumbCap && entries.length) {
        this.thumbCache.delete(entries.shift().name);
      }
    }

    ready(i) {
      const frames = this.framesRef;
      if (!frames || i < 0 || i >= frames.length) return false;
      const im = this.cache.get(frames[i].name);
      return !!(im && im.complete && im.naturalWidth > 0);
    }

    readyThumb(i) {
      const frames = this.framesRef;
      if (!frames || i < 0 || i >= frames.length) return false;
      const im = this.thumbCache.get(frames[i].name);
      return !!(im && im.complete && im.naturalWidth > 0);
    }

    thumbSrc(i) {
      const frames = this.framesRef;
      if (!frames || i < 0 || i >= frames.length) return null;
      return thumbUrl(frames[i].name, this.camera);
    }

    abortPending() {
      for (const [name, im] of this.cache) {
        if (!im.complete || im.naturalWidth === 0) {
          im.src = '';
          this.cache.delete(name);
        }
      }
    }

    ensure(name) { this._ensure(name); return this.cache.get(name); }
    imageFor(name) { return this.cache.get(name); }
  }

  window.SkyPlayback = {
    WEEKDAYS, MONTHS,
    imgUrl, thumbUrl,
    readableTs, formatTs, fmtTsHuman, fmtMD, fmt12hm, hhmmToMin,
    describePartOfDay,
    SKY_STOPS, timeColor, buildGradientFor, frameTimeColor,
    PreloadCache,
  };
})();
