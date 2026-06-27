/**
 * background.js
 * Service worker — orchestrates full-page capture.
 *
 * Capture loop contract:
 *   1. Send SCROLL_TO to content.js
 *   2. content.js scrolls, waits for TWO paint frames, then responds
 *   3. ONLY THEN do we call captureVisibleTab
 *   4. Rate-limit captureVisibleTab to ≤ 1.8/sec (Chrome quota is 2/sec)
 *
 * This guarantees what Chrome captures actually matches the scroll position.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

// Extra ms content.js waits after the double-rAF before responding.
// Increase if you see partially-rendered content (e.g. on React/Vue heavy pages).
const SCROLL_SETTLE_MS   = 150;
const FIRST_SCROLL_EXTRA = 300;  // more time for the very first scroll (cold render)
const MIN_CAPTURE_GAP_MS = 560;  // stay safely under Chrome's 2 captures/sec hard limit

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Rate-limited captureVisibleTab ───────────────────────────────────────────

let _lastCaptureAt = 0;

/**
 * Calls captureVisibleTab but enforces a minimum gap between calls so we
 * never exceed Chrome's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.
 */
async function captureTab(opts) {
  const wait = MIN_CAPTURE_GAP_MS - (Date.now() - _lastCaptureAt);
  if (wait > 0) await sleep(wait);
  _lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(null, opts);
}

// ─── State ────────────────────────────────────────────────────────────────────

const capturingTabs = new Set();

// ─── Entry points ─────────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'trigger-screenshot') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) startCapture(tab.id, { format: 'png' });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'START_CAPTURE') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { sendResponse({ error: 'No active tab.' }); return; }
      try {
        await startCapture(tab.id, msg.options || {});
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
  if (msg.action === 'GET_CAPTURE_STATUS') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({ capturing: tab ? capturingTabs.has(tab.id) : false });
    })();
    return true;
  }
});

// ─── Core capture ─────────────────────────────────────────────────────────────

async function startCapture(tabId, options = {}) {
  if (capturingTabs.has(tabId)) {
    console.warn('[FullSnap] Already capturing tab', tabId);
    return;
  }
  capturingTabs.add(tabId);
  progress(tabId, 0, 'Injecting…');

  const fmt = { format: options.format === 'jpeg' ? 'jpeg' : 'png', quality: options.quality || 92 };

  try {
    // ── 1. Inject content script (idempotent — guard inside content.js) ──────
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    // Small pause to let the content script initialise its message listener
    await sleep(100);

    // ── 2. Initial page info ──────────────────────────────────────────────────
    const info = await msg(tabId, { action: 'GET_PAGE_INFO' });
    let { viewportHeight, viewportWidth, devicePixelRatio } = info;
    progress(tabId, 5, 'Triggering lazy load…');

    // ── 3. Lazy-load scan — content.js scrolls the whole page once ────────────
    const afterLazy = await msg(tabId, { action: 'TRIGGER_LAZY_LOAD' });
    // Use the post-lazy-load page height — it may be larger
    let pageHeight = afterLazy.pageHeight;
    viewportHeight = afterLazy.viewportHeight || viewportHeight;
    progress(tabId, 10, 'Starting capture…');

    const screenshots = [];

    // ── 4. Scroll to top, capture FIRST frame with navbar visible ─────────────
    await msg(tabId, { action: 'SCROLL_TO', y: 0, extra: FIRST_SCROLL_EXTRA });
    const firstShot = await captureTab(fmt);
    screenshots.push({ dataUrl: firstShot, scrollY: 0 });
    progress(tabId, 14, 'Captured header…');

    // ── 5. Hide fixed/sticky elements for all subsequent frames ───────────────
    await msg(tabId, { action: 'HIDE_FIXED_ELEMENTS' });

    // ── 6. Scroll & capture loop ──────────────────────────────────────────────
    // We step by viewportHeight but always use the ACTUAL scrollY returned by
    // content.js (the browser may clamp when near the bottom). We stop when
    // content.js says atBottom = true.
    let step = 1;
    let targetY = viewportHeight;

    while (true) {
      const scrolled = await msg(tabId, { action: 'SCROLL_TO', y: targetY, extra: SCROLL_SETTLE_MS });
      const actualY  = scrolled.scrollY;

      // Safety: if actualY is the same as the previous screenshot's scrollY
      // (browser clamped), skip to avoid a duplicate frame at the same position.
      const lastY = screenshots[screenshots.length - 1].scrollY;
      if (actualY <= lastY) break;

      const shot = await captureTab(fmt);
      screenshots.push({ dataUrl: shot, scrollY: actualY });

      // Re-read page height — lazy load may have expanded it during scroll
      pageHeight = scrolled.pageHeight;

      const pct = 14 + Math.round((step / Math.ceil(pageHeight / viewportHeight)) * 72);
      progress(tabId, Math.min(pct, 86), `Capturing… (frame ${step + 1})`);

      if (scrolled.atBottom) break;

      step++;
      targetY = actualY + viewportHeight;
    }

    // ── 7. Restore page state ─────────────────────────────────────────────────
    await msg(tabId, { action: 'RESTORE_PAGE' });
    progress(tabId, 87, 'Stitching…');

    // ── 8. Stitch ─────────────────────────────────────────────────────────────
    const finalUrl = await stitch(screenshots, viewportWidth, devicePixelRatio, options);
    progress(tabId, 96, 'Saving…');

    // ── 9. Download ───────────────────────────────────────────────────────────
    const ext = options.format === 'jpeg' ? 'jpeg' : 'png';
    await chrome.downloads.download({ url: finalUrl, filename: filename(ext), saveAs: false });
    progress(tabId, 100, 'Done!');

    if (options.clipboard) {
      chrome.runtime.sendMessage({ action: 'COPY_TO_CLIPBOARD', dataUrl: finalUrl, tabId })
        .catch(() => {});
    }

  } catch (err) {
    console.error('[FullSnap]', err);
    progress(tabId, -1, `Error: ${err.message}`);
    try { await msg(tabId, { action: 'RESTORE_PAGE' }); } catch (_) {}
  } finally {
    capturingTabs.delete(tabId);
  }
}

// ─── Stitching ────────────────────────────────────────────────────────────────

/**
 * Decodes all captured frames and draws them onto an OffscreenCanvas at their
 * exact scrollY positions. No height cap — canvas grows to fit everything.
 */
async function stitch(screenshots, viewportW, dpr, options) {
  const physW = Math.round(viewportW * dpr);

  // Decode all images in parallel
  const frames = await Promise.all(
    screenshots.map(async ({ dataUrl, scrollY }) => {
      const blob   = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      return { bitmap, scrollY };
    })
  );

  // Canvas height = bottom pixel of the last frame
  const last   = frames[frames.length - 1];
  const totalH = Math.round(last.scrollY * dpr) + last.bitmap.height;

  const canvas = new OffscreenCanvas(physW, totalH);
  const ctx    = canvas.getContext('2d');

  for (const { bitmap, scrollY } of frames) {
    const destY = Math.round(scrollY * dpr);
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, destY, bitmap.width, bitmap.height);
    bitmap.close();
  }

  const mime  = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const qual  = options.format === 'jpeg' ? (options.quality || 92) / 100 : undefined;
  const blob  = await canvas.convertToBlob({ type: mime, quality: qual });
  return dataUrl(blob);
}

function dataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(new Error('FileReader failed'));
    r.readAsDataURL(blob);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msg(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function progress(tabId, percent, label) {
  chrome.storage.session.set({ [`progress_${tabId}`]: { percent, label, ts: Date.now() } });
  chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', tabId, percent, label }).catch(() => {});
}

function filename(ext) {
  const n = new Date(), p = (v) => String(v).padStart(2, '0');
  return `fullsnap-${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}.${ext}`;
}
