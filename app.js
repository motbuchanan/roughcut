// app.js · RoughCut
// Bootstrap: register the service worker, run the capability gate (§5), then
// hand off to the UI. On a browser that cannot encode H.264 + AAC, show the
// honest "needs Chrome/Edge" screen instead of failing later during export.

import { checkCapability } from './media.js';
import { initUI, showCapabilityFail, toast } from './ui.js';

const VERSION = 'v0.43 \u00b7 Oct 28';

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Service worker + OPFS + ES modules only work over the Pages URL, not file://
  if (location.protocol === 'file:') return;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.register('sw.js');
    try { reg.update(); } catch (_) {}
    // v0.43: when a new version takes over, load it. On the Projects screen it reloads
    // straight away; mid-edit it waits and says so, so nothing in progress is lost.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || window.__rcReloading) return;
      const editing = document.querySelector('#screen-editor.active');
      if (!editing) { window.__rcReloading = true; location.reload(); return; }
      const b = document.getElementById('badge');
      if (b) { b.textContent = 'Update ready \u00b7 tap'; b.onclick = () => { window.__rcReloading = true; location.reload(); }; }
    });
  } catch (e) {
    console.warn('SW registration failed', e);
  }
}

async function main() {
  const badge = document.getElementById('badge');
  if (badge) badge.textContent = VERSION;

  await registerSW();

  let cap;
  try {
    cap = await checkCapability();
  } catch (e) {
    cap = { ok: false, reasons: ['Capability check crashed: ' + (e?.message || e)] };
  }

  if (!cap.ok) {
    // still init the shell so the version badge and layout exist behind the notice
    try { initUI(); } catch (_) {}
    showCapabilityFail(cap.reasons);
    return;
  }

  initUI();
  if (location.protocol === 'file:') {
    toast('Open from the Pages URL \u2014 file:// blocks storage and export', 4000);
  }
}

main();
