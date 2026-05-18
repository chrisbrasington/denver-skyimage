(function () {
  'use strict';

  function fmtAge(sec) {
    if (sec == null) return '';
    if (sec < 60) return `${Math.round(sec)}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k.startsWith('data-')) e.setAttribute(k, attrs[k]);
        else e[k] = attrs[k];
      }
    }
    if (children) for (const c of children) if (c) e.appendChild(c);
    return e;
  }

  async function loadAndRender() {
    let data;
    try {
      const r = await fetch('/api/sessions', { cache: 'no-store' });
      if (!r.ok) return;
      data = await r.json();
    } catch { return; }

    const touchesBox = document.getElementById('touches');
    const tvsBox = document.getElementById('tvs');
    const sel = document.getElementById('touchSelect');
    const prevSel = sel.value;

    touchesBox.innerHTML = '';
    if (!data.touches.length) {
      touchesBox.appendChild(el('div', { class: 'empty', text: 'no active touches' }));
    } else {
      for (const t of data.touches) {
        const row = el('div', { class: 'row' + (t.paired_tv_id ? ' paired' : '') });
        const info = el('div', { class: 'info' });
        const idLine = el('div', { class: 'id', text: t.id.slice(0, 12) });
        if (t.paired_tv_id) idLine.appendChild(el('span', { class: 'badge', text: 'paired' }));
        info.appendChild(idLine);
        info.appendChild(el('div', { class: 'meta', text: `${t.camera || 'default'} · ${t.current_ts || '—'}` }));
        info.appendChild(el('div', { class: 'age', text: fmtAge(t.last_seen_age_sec) }));
        row.appendChild(info);
        if (t.paired_tv_id) {
          const btn = el('button', { class: 'unpair', text: `Unpair (TV ${t.paired_tv_id.slice(0, 6)})` });
          btn.addEventListener('click', () => unpair({ touch_id: t.id }));
          row.appendChild(btn);
        }
        touchesBox.appendChild(row);
      }
    }

    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: '— pick touch —' }));
    for (const t of data.touches) {
      const label = `${t.id.slice(0, 8)} · ${t.camera || 'default'}${t.paired_tv_id ? ' (paired)' : ''}`;
      sel.appendChild(el('option', { value: t.id, text: label }));
    }
    sel.value = prevSel;

    tvsBox.innerHTML = '';
    if (!data.tvs.length) {
      tvsBox.appendChild(el('div', { class: 'empty', text: 'no TVs registered — open /tv on a display' }));
    } else {
      for (const tv of data.tvs) {
        const row = el('div', { class: 'row' + (tv.paired_touch_id ? ' paired' : '') });
        if (!tv.paired_touch_id && tv.pairing_code) {
          row.style.cursor = 'pointer';
          row.title = 'click to fill code';
          row.addEventListener('click', () => {
            document.getElementById('codeInput').value = tv.pairing_code;
            document.getElementById('touchSelect').focus();
          });
        }
        const info = el('div', { class: 'info' });
        const idLine = el('div', { class: 'id', text: tv.id.slice(0, 12) });
        if (tv.paired_touch_id) idLine.appendChild(el('span', { class: 'badge', text: 'paired' }));
        info.appendChild(idLine);
        info.appendChild(el('div', { class: 'age', text: fmtAge(tv.last_seen_age_sec) }));
        row.appendChild(info);
        const right = el('div');
        if (tv.paired_touch_id) {
          const btn = el('button', { class: 'unpair', text: 'Unpair' });
          btn.addEventListener('click', (e) => { e.stopPropagation(); unpair({ tv_id: tv.id }); });
          right.appendChild(btn);
        } else {
          right.appendChild(el('span', { class: 'code', text: tv.pairing_code || '----' }));
        }
        row.appendChild(right);
        tvsBox.appendChild(row);
      }
    }
  }

  async function unpair(body) {
    try {
      await fetch('/api/sessions/unpair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {}
    loadAndRender();
  }

  async function pair() {
    const code = document.getElementById('codeInput').value.trim();
    const touchId = document.getElementById('touchSelect').value;
    if (!code || !touchId) { alert('enter a code and pick a touch session'); return; }
    let r;
    try {
      r = await fetch('/api/sessions/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, touch_id: touchId }),
      });
    } catch {
      alert('network error');
      return;
    }
    if (r.ok) {
      document.getElementById('codeInput').value = '';
      loadAndRender();
    } else {
      let msg = `pair failed (${r.status})`;
      try { const j = await r.json(); if (j.detail) msg = j.detail; } catch {}
      alert(msg);
    }
  }

  document.getElementById('pairBtn').addEventListener('click', pair);
  document.getElementById('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pair();
  });

  loadAndRender();
  setInterval(loadAndRender, 2000);
})();
