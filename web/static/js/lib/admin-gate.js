/*
 * admin-gate.js — initial admin keypad gate.
 *
 * Auto-shown on pages included via _admin_gate.html. On success, the page stays;
 * on fail or timeout, the user is bounced back to the home route.
 *
 * home.html has a richer flow (corner-touch detection, keyboard shortcut) that
 * lives in pages/home.js; this module is the simple "all visitors hit a PIN"
 * gate used by index, live, browse, events, and status.
 */
(function () {
  'use strict';
  if (!window.AdminKeypad) return;

  const goHome = () => window.location.replace('/');

  window.AdminKeypad.show({
    title: 'Admin Access',
    sub: 'Enter PIN',
    mode: 'gate',
    timeoutMs: 10000,
    onSuccess: () => {},
    onFail: goHome,
    onTimeout: goHome,
  });
})();
