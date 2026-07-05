// app.js · RoughCut
// Bootstrap: register the service worker, run the capability gate (§5), then
// hand off to the UI. On a browser that cannot encode H.264 + AAC, show the
// honest "needs Chrome/Edge" screen instead of failing later during export.

import { checkCapability } from './media.js';
import { initUI, showCapabilityFail, toast } from './ui.js';

const VERSION = 'v0.2 \u00b7 Jul 4';

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // Service worker + OPFS + ES modules only work over the Pages URL, not file://
  if (location.protocol === 'file:') return;
  try {
    await navigator.serviceWorker.register('sw.js');
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
