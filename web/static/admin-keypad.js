(function () {
  'use strict';

  const STYLE_ID = 'admin-keypad-style';
  const CSS = `
    body.akp-locked { overflow: hidden; }
    body.akp-locked > *:not(.akp-backdrop):not(script) {
      filter: blur(28px) saturate(0.6) brightness(0.5);
      pointer-events: none !important;
      transition: filter 0.15s ease-out;
    }
    .akp-backdrop {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(5,7,12,0.55);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 1.2rem; padding: 1.5rem;
      font-family: system-ui, sans-serif; color: #e6e9ef;
      -webkit-user-select: none; user-select: none;
    }
    .akp-title { font-size: 1.15rem; color: #ffd76a; text-transform: uppercase; letter-spacing: 0.1em; text-align: center; }
    .akp-sub { font-size: 0.9rem; color: #aab; text-align: center; }
    .akp-display {
      min-width: 240px; height: 56px;
      background: #11141c; border: 2px solid #2a3340; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      gap: 0.7rem; font-size: 2rem; letter-spacing: 0.35em; color: #ffd76a;
      padding: 0 1rem;
    }
    .akp-display.bad { border-color: #7a3030; color: #ff8a7a; animation: akp-shake 0.35s; }
    @keyframes akp-shake {
      0%,100% { transform: translateX(0); }
      25% { transform: translateX(-6px); }
      75% { transform: translateX(6px); }
    }
    .akp-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem;
      width: min(320px, 88vw);
    }
    .akp-key {
      background: #1f2630; color: #e6e9ef; border: 1px solid #333; border-radius: 8px;
      font-size: 1.6rem; font-weight: 600; padding: 1rem 0;
      cursor: pointer; -webkit-tap-highlight-color: transparent;
      font-family: inherit;
      transition: background 0.1s;
    }
    .akp-key:active { background: #34466a; }
    .akp-key.go { background: #2a5a3a; border-color: #3a7d55; color: #cfffd9; }
    .akp-key.go:active { background: #34664a; }
    .akp-key.bs { background: #3a2630; border-color: #5a3340; }
    .akp-actions { display: flex; gap: 0.8rem; flex-wrap: wrap; justify-content: center; }
    .akp-btn {
      background: #1f2630; color: #e6e9ef; border: 1px solid #333; border-radius: 6px;
      padding: 0.7rem 1.2rem; font-size: 0.95rem; cursor: pointer;
      font-family: inherit;
    }
    .akp-btn:active { background: #2a3340; }
    .akp-btn.refresh {
      background: #2a3a55; border: 2px solid #4a6da0; color: #ffffff;
      font-size: 2rem; font-weight: 800;
      padding: 1.8rem 2.6rem;
      min-width: min(480px, 92vw);
      border-radius: 14px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      box-shadow: 0 8px 24px rgba(0,0,0,0.55), 0 0 0 2px rgba(74,109,160,0.25);
    }
    .akp-btn.refresh:active { background: #34466a; transform: translateY(1px); }
    .akp-btn.refresh .akp-countdown { font-size: 1.5rem; margin-left: 0.6rem; opacity: 0.9; }
    .akp-actions { margin-top: 0.8rem; }
    .akp-countdown { color: #ffd76a; font-variant-numeric: tabular-nums; font-weight: 700; }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  let activeInstance = null;

  function show(opts) {
    opts = opts || {};
    if (activeInstance) return activeInstance;
    injectStyle();

    const title = opts.title || 'Admin';
    const sub = opts.sub || 'Enter PIN';
    const mode = opts.mode || 'gate'; // 'gate' | 'refresh'
    const timeoutMs = opts.timeoutMs || (mode === 'refresh' ? 5000 : 0);
    const maxLen = opts.maxLen || 8;

    const backdrop = document.createElement('div');
    backdrop.className = 'akp-backdrop';

    const titleEl = document.createElement('div');
    titleEl.className = 'akp-title';
    titleEl.textContent = title;

    const subEl = document.createElement('div');
    subEl.className = 'akp-sub';
    subEl.textContent = sub;

    const display = document.createElement('div');
    display.className = 'akp-display';
    display.textContent = '·····'.slice(0, 0);

    let buf = '';
    function renderDisplay() {
      display.textContent = '•'.repeat(buf.length) || ' ';
    }
    renderDisplay();

    const grid = document.createElement('div');
    grid.className = 'akp-grid';
    const keys = ['1','2','3','4','5','6','7','8','9','⌫','0','✓'];
    for (const k of keys) {
      const btn = document.createElement('button');
      btn.className = 'akp-key';
      btn.type = 'button';
      btn.textContent = k;
      if (k === '⌫') btn.classList.add('bs');
      if (k === '✓') btn.classList.add('go');
      btn.addEventListener('click', () => handle(k));
      grid.appendChild(btn);
    }

    const actions = document.createElement('div');
    actions.className = 'akp-actions';

    let countdownEl = null;
    let countdownTimer = null;
    let timeoutTimer = null;
    let destroyed = false;

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (countdownTimer) clearInterval(countdownTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      document.body.classList.remove('akp-locked');
      activeInstance = null;
    }

    function flashBad() {
      display.classList.add('bad');
      setTimeout(() => { if (!destroyed) display.classList.remove('bad'); }, 400);
      buf = '';
      renderDisplay();
    }

    async function submit() {
      if (!buf) return;
      let ok = false;
      try {
        const r = await fetch('/api/admin-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pin: buf }),
        });
        ok = r.ok;
      } catch (e) { /* network error treated as fail */ }
      if (destroyed) return;
      if (ok) {
        destroy();
        if (opts.onSuccess) opts.onSuccess();
        return;
      }
      if (opts.onFail) {
        destroy();
        opts.onFail();
        return;
      }
      flashBad();
    }

    function bumpGateTimeout() {
      if (mode !== 'gate' || !timeoutMs || destroyed) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        destroy();
        if (opts.onTimeout) opts.onTimeout();
      }, timeoutMs);
    }

    function handle(k) {
      bumpGateTimeout();
      if (k === '⌫') {
        buf = buf.slice(0, -1);
        renderDisplay();
      } else if (k === '✓') {
        submit();
      } else if (/^\d$/.test(k)) {
        if (buf.length < maxLen) {
          buf += k;
          renderDisplay();
        }
      }
    }

    function onKey(e) {
      if (e.key >= '0' && e.key <= '9') { handle(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { handle('⌫'); e.preventDefault(); }
      else if (e.key === 'Enter') { handle('✓'); e.preventDefault(); }
      else if (e.key === 'Escape' && opts.onCancel) { destroy(); opts.onCancel(); e.preventDefault(); }
    }

    backdrop.append(titleEl, subEl, display, grid);

    if (mode === 'refresh') {
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'akp-btn refresh';
      refreshBtn.type = 'button';

      countdownEl = document.createElement('span');
      countdownEl.className = 'akp-countdown';

      let remain = Math.ceil(timeoutMs / 1000);
      function paintCountdown() {
        refreshBtn.innerHTML = '';
        refreshBtn.appendChild(document.createTextNode('Refresh '));
        countdownEl.textContent = `(${remain}s)`;
        refreshBtn.appendChild(countdownEl);
      }
      paintCountdown();

      countdownTimer = setInterval(() => {
        remain -= 1;
        if (remain >= 0) paintCountdown();
      }, 1000);

      timeoutTimer = setTimeout(() => {
        destroy();
        if (opts.onTimeout) opts.onTimeout();
      }, timeoutMs);

      refreshBtn.addEventListener('click', () => {
        destroy();
        if (opts.onTimeout) opts.onTimeout();
      });

      actions.appendChild(refreshBtn);
      backdrop.appendChild(actions);
    } else {
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          destroy();
          if (opts.onTimeout) opts.onTimeout();
        }, timeoutMs);
      }
      if (opts.cancelLabel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'akp-btn';
        cancelBtn.type = 'button';
        cancelBtn.textContent = opts.cancelLabel;
        cancelBtn.addEventListener('click', () => {
          destroy();
          if (opts.onCancel) opts.onCancel();
        });
        actions.appendChild(cancelBtn);
        backdrop.appendChild(actions);
      }
    }

    document.body.appendChild(backdrop);
    document.body.classList.add('akp-locked');
    document.addEventListener('keydown', onKey);

    activeInstance = { destroy };
    return activeInstance;
  }

  window.AdminKeypad = { show };
})();
