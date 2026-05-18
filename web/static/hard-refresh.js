(function() {
  const CORNER_SIZE = 140;
  const HOLD_MS = 5000;
  const HINT_DELAY_MS = 800;
  let holdTimer = null;
  let hintTimer = null;
  let countdownTimer = null;
  let indicator = null;

  function inTopLeft(t) {
    return t.clientX <= CORNER_SIZE && t.clientY <= CORNER_SIZE;
  }
  function inTopRight(t) {
    return t.clientX >= window.innerWidth - CORNER_SIZE && t.clientY <= CORNER_SIZE;
  }
  function check(touches) {
    if (!touches || touches.length < 2) return false;
    let tl = false, tr = false;
    for (const t of touches) {
      if (inTopLeft(t)) tl = true;
      else if (inTopRight(t)) tr = true;
    }
    return tl && tr;
  }

  function showIndicator() {
    if (indicator) return;
    indicator = document.createElement('div');
    indicator.style.cssText = [
      'position:fixed', 'top:50%', 'left:50%',
      'transform:translate(-50%,-50%)',
      'background:rgba(10,15,20,0.85)',
      'border:2px solid #ffd76a',
      'border-radius:16px',
      'padding:1.25rem 1.9rem',
      'color:#ffd76a',
      'font:700 1.15rem system-ui,sans-serif',
      'letter-spacing:0.08em',
      'text-transform:uppercase',
      'z-index:99999',
      'pointer-events:none',
      'box-shadow:0 8px 28px rgba(0,0,0,0.55)',
      'text-align:center'
    ].join(';');
    document.body.appendChild(indicator);
    let remain = Math.ceil((HOLD_MS - HINT_DELAY_MS) / 1000);
    indicator.textContent = `Refreshing in ${remain}…`;
    countdownTimer = setInterval(() => {
      remain -= 1;
      if (remain > 0 && indicator) indicator.textContent = `Refreshing in ${remain}…`;
    }, 1000);
  }

  function hideIndicator() {
    if (indicator) { indicator.remove(); indicator = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function start() {
    if (holdTimer) return;
    hintTimer = setTimeout(showIndicator, HINT_DELAY_MS);
    holdTimer = setTimeout(() => {
      const u = new URL(window.location.href);
      u.searchParams.set('_r', Date.now().toString());
      window.location.replace(u.toString());
    }, HOLD_MS);
  }

  function cancel() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hideIndicator();
  }

  function onTouch(e) {
    if (check(e.touches)) start();
    else cancel();
  }

  window.addEventListener('touchstart', onTouch, { passive: true });
  window.addEventListener('touchmove', onTouch, { passive: true });
  window.addEventListener('touchend', onTouch, { passive: true });
  window.addEventListener('touchcancel', cancel, { passive: true });
})();
