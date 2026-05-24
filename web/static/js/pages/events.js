/*
 * events.js — admin table for the event log: list, edit, delete, clear-all.
 * Hits /api/events (CRUD) and /api/cameras (for the filter dropdown).
 */
(function () {
  'use strict';

  const rows      = document.getElementById('rows');
  const counter   = document.getElementById('counter');
  const empty     = document.getElementById('empty');
  const camFilter = document.getElementById('camFilter');
  const clearBtn  = document.getElementById('clearAllBtn');

  const toInputTs = (iso) => (iso || '').slice(0, 19);

  async function loadCameras() {
    try {
      const r = await fetch('/api/cameras');
      const data = await r.json();
      for (const c of (data.cameras || [])) {
        camFilter.appendChild(new Option(c, c));
      }
    } catch (e) { console.warn('cameras failed', e); }
  }

  async function loadAll() {
    rows.innerHTML = '';
    empty.style.display = 'none';
    let all = [];
    try {
      const r = await fetch('/api/events?everywhere=1');
      all = await r.json();
    } catch (e) {
      counter.textContent = 'error';
      return;
    }
    const filter = camFilter.value;
    const list = filter ? all.filter((e) => e.camera === filter) : all;
    list.sort((a, b) => (a.start_ts > b.start_ts ? -1 : 1));
    counter.textContent = `${list.length} event${list.length === 1 ? '' : 's'}`;
    if (!list.length) {
      empty.style.display = 'block';
      return;
    }
    for (const ev of list) rows.appendChild(buildRow(ev));
  }

  function buildRow(ev) {
    const tr = document.createElement('tr');
    tr.dataset.eventId = ev.id;

    const cellCam = document.createElement('td');
    cellCam.textContent = ev.camera || '';

    const cellPos = document.createElement('td');
    cellPos.className = 'pos';
    cellPos.textContent = `${(ev.x_pct * 100).toFixed(1)}%, ${(ev.y_pct * 100).toFixed(1)}%`;

    const cellMsg = document.createElement('td');
    const msgIn = document.createElement('input');
    msgIn.type = 'text';
    msgIn.maxLength = 200;
    msgIn.value = ev.message || '';
    cellMsg.appendChild(msgIn);

    const cellStart = document.createElement('td');
    const startIn = document.createElement('input');
    startIn.type = 'datetime-local';
    startIn.step = 1;
    startIn.value = toInputTs(ev.start_ts);
    cellStart.appendChild(startIn);

    const cellEnd = document.createElement('td');
    const endIn = document.createElement('input');
    endIn.type = 'datetime-local';
    endIn.step = 1;
    endIn.value = toInputTs(ev.end_ts);
    cellEnd.appendChild(endIn);

    const cellCreated = document.createElement('td');
    cellCreated.className = 'created';
    cellCreated.textContent = (ev.created_ts || '').replace('T', ' ').slice(0, 19);

    const cellId = document.createElement('td');
    cellId.className = 'id';
    cellId.textContent = ev.id;

    const cellActions = document.createElement('td');
    cellActions.className = 'actions';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.disabled = true;
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.className = 'danger';
    cellActions.append(saveBtn, delBtn);

    function markDirty() {
      saveBtn.disabled = false;
      tr.classList.add('dirty');
    }
    [msgIn, startIn, endIn].forEach((inp) => inp.addEventListener('input', markDirty));

    saveBtn.addEventListener('click', async () => {
      const msg = msgIn.value.trim();
      if (!msg) { alert('Message required'); return; }
      let s = startIn.value;
      let e = endIn.value;
      if (!s || !e) { alert('Start and end required'); return; }
      if (s.length === 16) s += ':00';
      if (e.length === 16) e += ':00';
      if (s > e) { alert('Start must be before end'); return; }
      saveBtn.disabled = true;
      try {
        const r = await fetch(`/api/events/${ev.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, start_ts: s, end_ts: e }),
        });
        if (!r.ok) throw new Error(await r.text() || `HTTP ${r.status}`);
        const updated = await r.json();
        ev.message  = updated.message;
        ev.start_ts = updated.start_ts;
        ev.end_ts   = updated.end_ts;
        msgIn.value   = updated.message;
        startIn.value = toInputTs(updated.start_ts);
        endIn.value   = toInputTs(updated.end_ts);
        tr.classList.remove('dirty');
      } catch (err) {
        saveBtn.disabled = false;
        alert(`Save failed: ${err.message}`);
      }
    });

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete event:\n"${ev.message}" (${ev.start_ts} → ${ev.end_ts})?`)) return;
      try {
        const r = await fetch(`/api/events/${ev.id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        tr.remove();
        const remain = rows.querySelectorAll('tr').length;
        counter.textContent = `${remain} event${remain === 1 ? '' : 's'}`;
        if (!remain) empty.style.display = 'block';
      } catch (err) { alert(`Delete failed: ${err.message}`); }
    });

    tr.append(cellCam, cellPos, cellMsg, cellStart, cellEnd, cellCreated, cellId, cellActions);
    return tr;
  }

  clearBtn.addEventListener('click', async () => {
    const filter = camFilter.value;
    const label = filter ? `events for camera "${filter}"` : 'ALL events across ALL cameras';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    if (!confirm('Really? This cannot be undone.')) return;
    const url = filter ? `/api/events?camera=${encodeURIComponent(filter)}` : '/api/events';
    try {
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadAll();
    } catch (e) { alert(`Clear failed: ${e.message}`); }
  });

  camFilter.addEventListener('change', loadAll);

  (async () => {
    await loadCameras();
    await loadAll();
  })();
})();
