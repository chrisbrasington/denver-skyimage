/*
 * status.js — admin dashboard (templates/status.html).
 *
 * Polls /api/status every 30s and re-renders tiles, panels, bars, camera
 * cards, video list, and container table.
 */
(function () {
  'use strict';

  // ── formatters ─────────────────────────────────────────────
  const fmtBytes = (b) => {
    if (b < 1024) return b + ' B';
    if (b < 1_048_576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1_073_741_824) return (b / 1_048_576).toFixed(1) + ' MB';
    return (b / 1_073_741_824).toFixed(2) + ' GB';
  };
  const fmtDur = (s) => {
    if (s == null) return '—';
    if (s < 60)    return s + 's';
    if (s < 3600)  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  };
  const fmtTs = (t) => (t ? new Date(t).toLocaleString() : '—');
  const pickColor = (pct) => (pct >= 80 ? '#c2614e' : pct >= 60 ? '#ffd76a' : '#7fd17a');

  function setBar(fill, pct) {
    const p = Math.min(100, Math.max(0, pct || 0));
    fill.style.width = p + '%';
    fill.style.background = pickColor(p);
  }

  // ── shared state ───────────────────────────────────────────
  let _latest = null;
  let _confirmHandler = null;

  // ── color palette for total-storage stacked bar ────────────
  const CAM_PALETTE = ['#7fd17a', '#8ab4ff', '#c79bff', '#ffb47a', '#ff8a7a', '#5ed3c8'];
  const COLOR_VIDEOS = '#ffd76a';
  const COLOR_OTHER  = '#506070';
  const COLOR_FREE   = '#262d39';

  // ── main render ────────────────────────────────────────────
  function render(d) {
    _latest = d;
    document.getElementById('t-uptime').textContent   = fmtDur(d.web.uptime_seconds);
    document.getElementById('t-requests').textContent = d.web.requests.toLocaleString();
    document.getElementById('t-events').textContent   = d.events_count;
    document.getElementById('t-cpu').textContent      = d.system.cpu_pct.toFixed(1) + '%';
    const appM = d.app ? d.app.mem_pct.toFixed(1) : '—';
    const sysM = d.system.mem_pct.toFixed(1);
    document.getElementById('t-mem').innerHTML =
      `<span style="color:#ffd76a">${appM}%</span> <span style="color:#788;font-size:0.75rem;">app</span> · ` +
      `<span style="color:#8ab4ff">${sysM}%</span> <span style="color:#788;font-size:0.75rem;">sys</span>`;

    document.getElementById('lim-size').textContent = d.totals.max_size_gb;
    document.getElementById('lim-age').textContent  = d.limits.max_age_days;

    const sf = document.getElementById('storage-fill');
    setBar(sf, d.totals.size_pct_of_limit);
    document.getElementById('storage-text').textContent =
      fmtBytes(d.totals.size_bytes) + ' / ' + d.totals.max_size_gb + ' GB (' + d.totals.size_pct_of_limit + '%)';

    renderTotalStorage(d);
    renderAgeList(d);
    renderCameras(d);
    renderVideos(d.videos);
    renderContainers(d);
    renderSystemKv(d.system);

    document.getElementById('updated').textContent =
      'Updated ' + new Date(d.ts).toLocaleTimeString() + ' — refreshes every 30s';
  }

  // ── per-section renderers ──────────────────────────────────
  function renderAgeList(d) {
    const ageList = document.getElementById('age-list');
    ageList.innerHTML = '';
    d.cameras.forEach((c) => {
      const wrap = document.createElement('div');
      const aliasHtml = c.alias ? ` <span class="alias-tag">(${c.alias})</span>` : '';
      wrap.innerHTML = `
        <div class="bar-row">
          <span class="lbl">${c.name}${aliasHtml}${c.is_default ? ' <span class="tag">default</span>' : ''}</span>
          <span class="val">${fmtDur(c.oldest_age_seconds)} / ${d.limits.max_age_days}d (${c.age_pct_of_limit}%)</span>
        </div>
        <div class="bar"><div class="bar-fill"></div></div>`;
      ageList.appendChild(wrap);
      setBar(wrap.querySelector('.bar-fill'), c.age_pct_of_limit);
    });
  }

  function renderCameras(d) {
    const cards = document.getElementById('cam-cards');
    cards.innerHTML = '';
    d.cameras.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'card';
      const staleCls = c.cadence_stale ? 'stale' : '';
      const days = (c.per_day || []).slice(0, 7).map((r) =>
        `<div class="row"><span>${r.day}</span><span>${r.count.toLocaleString()} <button type="button" data-cam="${c.name}" data-day="${r.day}" data-count="${r.count}" class="del-day-btn">Delete day</button></span></div>`
      ).join('');
      const aliasHtml = c.alias ? ` <span class="alias-tag">(${c.alias})</span>` : '';
      card.innerHTML = `
        <h3>${c.name}${aliasHtml}${c.is_default ? ' <span class="tag">default</span>' : ''}</h3>
        <div class="kv">
          <span class="k">Count</span><span class="v">${c.count.toLocaleString()}</span>
          <span class="k">Size</span><span class="v">${fmtBytes(c.size_bytes)} / ${d.limits.max_size_gb} GB (${c.size_pct_of_limit}%)</span>
          <span class="k">Oldest</span><span class="v">${fmtTs(c.oldest_ts)}</span>
          <span class="k">Newest</span><span class="v">${fmtTs(c.newest_ts)}</span>
          <span class="k">Last image</span><span class="v ${staleCls}">${fmtDur(c.since_last_seconds)} ago${c.cadence_stale ? ' (stale)' : ''}</span>
        </div>
        <div class="bar"><div class="bar-fill"></div></div>
        <div class="day-list">${days}</div>`;
      cards.appendChild(card);
      setBar(card.querySelector('.bar-fill'), c.size_pct_of_limit);
    });
    document.querySelectorAll('.del-day-btn').forEach((btn) => {
      btn.addEventListener('click', () =>
        askDeleteDay(btn.dataset.cam, btn.dataset.day, parseInt(btn.dataset.count, 10)));
    });
  }

  function renderTotalStorage(d) {
    const sys = d.system || {};
    const total = sys.disk_total_bytes || 0;
    const used  = sys.disk_used_bytes  || 0;
    const free  = Math.max(0, total - used);
    const cams = (d.cameras || []).map((c, i) => ({
      label: c.name + ' images', bytes: c.size_bytes || 0, color: CAM_PALETTE[i % CAM_PALETTE.length],
    }));
    const videoBytes = d.videos ? (d.videos.total_size_bytes || 0) : 0;
    const sumKnown = cams.reduce((s, c) => s + c.bytes, 0) + videoBytes;
    const otherBytes = Math.max(0, used - sumKnown);
    const segs = [
      ...cams,
      { label: 'videos', bytes: videoBytes, color: COLOR_VIDEOS },
      { label: 'other',  bytes: otherBytes, color: COLOR_OTHER  },
      { label: 'free',   bytes: free,       color: COLOR_FREE   },
    ];

    const stack = document.getElementById('ts-stack');
    stack.innerHTML = '';
    segs.forEach((s) => {
      if (s.bytes <= 0 || total <= 0) return;
      const el = document.createElement('div');
      el.className = 'seg';
      el.style.background = s.color;
      el.style.width = (s.bytes / total * 100).toFixed(3) + '%';
      el.title = `${s.label}: ${fmtBytes(s.bytes)} (${(s.bytes / total * 100).toFixed(1)}%)`;
      stack.appendChild(el);
    });

    const usedPct = total ? (used / total * 100).toFixed(1) : '0';
    document.getElementById('ts-text').textContent =
      fmtBytes(used) + ' / ' + fmtBytes(total) + ' (' + usedPct + '%)';

    const lg = document.getElementById('ts-legend');
    lg.innerHTML = '';
    segs.forEach((s) => {
      const pct = total ? (s.bytes / total * 100).toFixed(1) : '0';
      const it = document.createElement('span');
      it.className = 'item';
      it.innerHTML = `<span class="sw" style="background:${s.color}"></span>${s.label}: ${fmtBytes(s.bytes)} (${pct}%)`;
      lg.appendChild(it);
    });
  }

  function renderVideos(v) {
    const sec = document.getElementById('videos-section');
    if (!v) { sec.style.display = 'none'; return; }
    sec.style.display = '';

    const note = document.getElementById('videogen-note');
    let pill, warn;
    if (v.videogen_running === null || v.videogen_running === undefined) {
      pill = '<span class="pill-stop" style="background:#665533;color:#ffd76a">unknown</span>';
      warn = `<span style="color:#ffd76a">Container state unreadable${v.containers_error ? ` (${v.containers_error})` : ''} — check docker/podman socket mount.</span>`;
    } else if (v.videogen_running) {
      pill = '<span class="pill-go">running</span>';
      warn = '';
    } else {
      pill = '<span class="pill-stop">stopped</span>';
      warn = '<span style="color:#ff8a7a">Not running on this host — no new videos will be encoded.</span>';
    }
    note.innerHTML = `
      The <b>videogen</b> container ${pill} auto-encodes one MP4 per camera per day at 01:00 MTN.
      Files saved as <code style="background:#1f2630;padding:0 0.3rem;border-radius:2px;">${v.naming}</code> in <code style="background:#1f2630;padding:0 0.3rem;border-radius:2px;">/data/videos/{camera}/</code>.
      ${warn}
    `;

    document.getElementById('videos-total').textContent =
      fmtBytes(v.total_size_bytes) + ' across ' + v.count + ' file' + (v.count === 1 ? '' : 's');

    const sys = _latest?.system || {};
    const diskUsed = sys.disk_used_bytes || 0;
    const diskTotal = sys.disk_total_bytes || 0;
    const sharePct = diskUsed > 0 ? (v.total_size_bytes / diskUsed) * 100 : 0;
    const shareFill = document.getElementById('videos-share-fill');
    shareFill.style.background = '#8ab4ff';
    shareFill.style.width = Math.min(100, sharePct).toFixed(1) + '%';
    document.getElementById('videos-share-text').textContent =
      fmtBytes(v.total_size_bytes) + ' of ' + fmtBytes(diskUsed) + ' used / ' + fmtBytes(diskTotal) + ' total (' + sharePct.toFixed(1) + '%)';

    const list = document.getElementById('video-list');
    list.innerHTML = '';
    v.by_camera.forEach((cam) => {
      if (!cam.items.length) return;
      const header = document.createElement('div');
      header.className = 'video-cam-header';
      header.textContent = `${cam.camera} — ${cam.items.length} video${cam.items.length === 1 ? '' : 's'}`;
      list.appendChild(header);
      cam.items.forEach((it) => {
        const row = document.createElement('div');
        row.className = 'video-row';
        row.innerHTML = `
          <input type="checkbox" data-cam="${cam.camera}" data-name="${it.name}">
          <span class="vname">${cam.camera} / ${it.day} <code>${it.name}</code></span>
          <a href="/api/videos/file/${cam.camera}/${it.name}" target="_blank">view</a>
          <a href="/api/videos/file/${cam.camera}/${it.name}?download=1">download</a>
          <span class="vsize">${fmtBytes(it.size_bytes)}</span>`;
        list.appendChild(row);
      });
    });
    list.querySelectorAll('input[type=checkbox]').forEach((cb) =>
      cb.addEventListener('change', updateVidBtnState));
    updateVidBtnState();
  }

  function renderContainers(d) {
    const engEl = document.getElementById('container-engine');
    engEl.textContent = d.container_engine ? `(via ${d.container_engine})` : '';
    const tb = document.getElementById('containers-body');
    tb.innerHTML = '';
    if (d.containers_error) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" style="color:#ff8a7a">Cannot read containers: ${d.containers_error}</td>`;
      tb.appendChild(tr);
    }
    d.containers.forEach((c) => {
      const tr = document.createElement('tr');
      const pillCls = c.status === 'running' ? 'pill-running' : 'pill-other';
      if (c.error) {
        tr.innerHTML = `<td>${c.name}</td><td><span class="pill ${pillCls}">${c.status}</span></td><td colspan="3" style="color:#ff8a7a">${c.error}</td>`;
      } else {
        tr.innerHTML = `
          <td>${c.name}</td>
          <td><span class="pill ${pillCls}">${c.status}</span></td>
          <td>${c.cpu_pct.toFixed(1)}</td>
          <td>${c.mem_mb.toFixed(1)}</td>
          <td>${c.mem_pct.toFixed(1)}</td>`;
      }
      tb.appendChild(tr);
    });
  }

  function renderSystemKv(sys) {
    document.getElementById('sys-kv').innerHTML = `
      <span class="k">Load (1/5/15m)</span><span class="v">${sys.loadavg.join(' / ')}</span>
      <span class="k">CPU</span><span class="v">${sys.cpu_pct.toFixed(1)}%</span>
      <span class="k">Memory</span><span class="v">${sys.mem_pct.toFixed(1)}%</span>
      <span class="k">Disk (volume)</span><span class="v">${sys.disk_free_gb} GB free / ${sys.disk_total_gb} GB total</span>`;
  }

  // ── video selection actions ────────────────────────────────
  function selectedVideos() {
    return Array.from(document.querySelectorAll('#video-list input[type=checkbox]:checked'))
      .map((cb) => ({ camera: cb.dataset.cam, name: cb.dataset.name }));
  }
  function updateVidBtnState() {
    const sel = selectedVideos();
    document.getElementById('vid-delete').disabled = sel.length === 0;
    document.getElementById('vid-count').textContent = sel.length ? `${sel.length} selected` : '';
  }

  document.getElementById('vid-select-all').addEventListener('click', () => {
    document.querySelectorAll('#video-list input[type=checkbox]').forEach((cb) => (cb.checked = true));
    updateVidBtnState();
  });
  document.getElementById('vid-clear').addEventListener('click', () => {
    document.querySelectorAll('#video-list input[type=checkbox]').forEach((cb) => (cb.checked = false));
    updateVidBtnState();
  });
  document.getElementById('vid-delete').addEventListener('click', () => {
    const sel = selectedVideos();
    if (!sel.length) return;
    askConfirm(
      `Delete ${sel.length} video file${sel.length === 1 ? '' : 's'}?`,
      `<ul>${sel.map((s) => `<li>${s.camera} / ${s.name}</li>`).join('')}</ul>`,
      async () => {
        const r = await fetch('/api/videos/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: sel }),
        });
        const d = await r.json();
        if (d.errors && d.errors.length) {
          alert(`Deleted ${d.deleted.length}, errors: ${JSON.stringify(d.errors)}`);
        }
        load();
      }
    );
  });

  // ── delete day flow ────────────────────────────────────────
  function askDeleteDay(camera, day, count) {
    const cam = (_latest?.cameras || []).find((c) => c.name === camera) || {};
    const lim = _latest?.limits || {};
    const sizePct = cam.size_pct_of_limit ?? 0;
    const agePct  = cam.age_pct_of_limit  ?? 0;
    const auto = `
      <p style="font-size:1rem;line-height:1.4;color:#ffd76a;margin-top:0.5rem;">
        Auto-prune already keeps storage under <b>${lim.max_size_gb} GB</b> per camera and images under <b>${lim.max_age_days} days</b>.<br>
        Current ${camera}: <b>${sizePct}%</b> of size limit, <b>${agePct}%</b> of age limit.<br>
        You do not have to manually delete unless you want it gone now.
      </p>`;
    askConfirm(
      `Delete all images for ${camera} on ${day}?`,
      `<p>${count.toLocaleString()} image${count === 1 ? '' : 's'} will be removed.</p>${auto}`,
      async () => {
        const r = await fetch('/api/images/delete-day', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ camera, day }),
        });
        const d = await r.json();
        if (d.errors && d.errors.length) {
          alert(`Deleted ${d.deleted}, errors: ${JSON.stringify(d.errors)}`);
        }
        load();
      }
    );
  }

  // ── confirm modal ──────────────────────────────────────────
  function askConfirm(title, bodyHtml, onOk, destructive = true) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').innerHTML = bodyHtml;
    document.querySelector('#confirm-modal .warn').style.display = destructive ? '' : 'none';
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = destructive ? 'Delete' : 'Proceed';
    _confirmHandler = onOk;
    document.getElementById('confirm-modal').classList.add('show');
  }
  function closeConfirm() {
    document.getElementById('confirm-modal').classList.remove('show');
    _confirmHandler = null;
  }
  document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('confirm-ok').addEventListener('click', async () => {
    const h = _confirmHandler;
    closeConfirm();
    if (h) await h();
  });
  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal') closeConfirm();
  });

  // ── load loop ──────────────────────────────────────────────
  async function load() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      render(await r.json());
    } catch (e) {
      console.warn('status load failed', e);
      document.getElementById('updated').textContent = 'Load failed: ' + e.message;
    }
  }

  // expose `load` globally so the "Refresh now" button can call it
  window.statusLoad = load;

  load();
  setInterval(load, 30_000);
})();
