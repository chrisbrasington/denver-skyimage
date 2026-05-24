/*
 * browse.js — paginated image grid with jump-to-time + admin deletion.
 *
 * Reads window.__SKY = { camera: string|null } from templates/browse.html.
 * Hits /api/list for paging, /api/days + /api/anchors for the jump menu,
 * and DELETE /image/<name> for per-file removal.
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

  function imgUrl(name, extra) {
    let u = `/image/${name}`;
    const parts = [];
    if (CAMERA) parts.push(camQS);
    if (extra)  parts.push(extra);
    if (parts.length) u += '?' + parts.join('&');
    return u;
  }

  const grid    = document.getElementById('grid');
  const status  = document.getElementById('status');
  const counter = document.getElementById('counter');
  const jumpSel = document.getElementById('jump');

  let page = 1;
  const perPage = 60;
  let total = 0;
  let loading = false;
  let done = false;
  let startTs = '';

  const tsParam = () => (startTs ? `&start=${encodeURIComponent(startTs)}` : '');

  function denverTs(date) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    const p = {};
    for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`;
  }

  async function buildJumpOptions() {
    const [daysR, sunR] = await Promise.all([
      fetch(withCam('/api/days')),
      fetch(withCam('/api/anchors')),
    ]);
    const days = await daysR.json();
    const sun  = await sunR.json();
    const sunByDay = {};
    for (const s of sun) sunByDay[s.day] = s;

    jumpSel.innerHTML = '';
    jumpSel.appendChild(new Option('Newest first', ''));

    if (days.length) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      jumpSel.appendChild(new Option('Last hour', denverTs(oneHourAgo)));

      days.forEach((d, idx) => {
        const md = d.day.slice(5);
        let prefix;
        if (idx === 0) prefix = `Today (${md})`;
        else if (idx === 1) prefix = `Yesterday (${md})`;
        else prefix = `${idx} days ago (${md})`;
        jumpSel.appendChild(new Option(`${prefix} 00:00`, `${d.day}_00-00-00`));
        const s = sunByDay[d.day];
        if (s?.sunrise) jumpSel.appendChild(new Option(`${prefix} sunrise ${s.sunrise}`, `${d.day}_${s.sunrise.replace(':', '-')}-00`));
        if (s?.sunset)  jumpSel.appendChild(new Option(`${prefix} sunset ${s.sunset}`,   `${d.day}_${s.sunset.replace(':', '-')}-00`));
      });
    }
  }

  jumpSel.addEventListener('change', () => {
    startTs = jumpSel.value;
    page = 1;
    total = 0;
    loading = false;
    done = false;
    grid.innerHTML = '';
    status.textContent = 'loading…';
    window.scrollTo(0, 0);
    loadPage();
  });

  async function loadPage() {
    if (loading || done) return;
    loading = true;
    status.textContent = 'loading…';
    const r = await fetch(withCam(`/api/list?page=${page}&per_page=${perPage}${tsParam()}`));
    const data = await r.json();
    total = data.total;
    counter.textContent = `${total} frames`;
    if (!data.items.length) {
      done = true;
      status.textContent = total === 0 ? 'no images yet' : 'end';
      loading = false;
      return;
    }
    for (const f of data.items) {
      grid.appendChild(buildTile(f));
    }
    page++;
    loading = false;
    if (page * perPage > total + perPage) {
      done = true;
      status.textContent = 'end';
    } else {
      status.textContent = '';
    }
  }

  function buildTile(f) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.name = f.name;

    const thumb = document.createElement('a');
    thumb.className = 'thumb';
    thumb.href = imgUrl(f.name);
    thumb.target = '_blank';
    thumb.rel = 'noopener';
    const im = document.createElement('img');
    im.loading = 'lazy';
    im.src = imgUrl(f.name);
    im.alt = f.ts;
    thumb.appendChild(im);

    const cap = document.createElement('div');
    cap.className = 'caption';
    cap.textContent = f.ts.replace('T', ' ');

    const actions = document.createElement('div');
    actions.className = 'actions';
    const dl = document.createElement('a');
    dl.href = imgUrl(f.name, 'download=1');
    dl.textContent = 'Download';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteTile(tile, f.name);
    });
    actions.appendChild(dl);
    actions.appendChild(del);

    tile.appendChild(thumb);
    tile.appendChild(cap);
    tile.appendChild(actions);
    return tile;
  }

  async function deleteTile(tile, name) {
    if (!confirm(`Delete ${name}?`)) return;
    tile.classList.add('removing');
    try {
      const r = await fetch(imgUrl(name), { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      tile.remove();
      total = Math.max(0, total - 1);
      counter.textContent = `${total} frames`;
    } catch (e) {
      tile.classList.remove('removing');
      alert(`Delete failed: ${e.message}`);
    }
  }

  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
      loadPage();
    }
  });

  (async () => {
    await buildJumpOptions();
    loadPage();
  })();
})();
