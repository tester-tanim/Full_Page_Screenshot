/**
 * background.js
 * Service worker for FullSnap extension.
 * Coordinates the full-page screenshot process:
 *   1. Injects content.js into the active tab
 *   2. Queries page dimensions from content.js
 *   3. Scrolls section by section, capturing each viewport via captureVisibleTab
 *   4. Stitches all images into one tall canvas using OffscreenCanvas
 *   5. Downloads the result as PNG or JPEG
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCROLL_DELAY_MS = 200;      // wait after scroll before capture (ms)
const LAZY_LOAD_DELAY_MS = 300;   // extra delay for lazy-loaded content (ms)

// ─── State ────────────────────────────────────────────────────────────────────

/** Tracks tabs where a capture is already in progress (prevents double-capture). */
const capturingTabs = new Set();

// ─── Entry Points ─────────────────────────────────────────────────────────────

/**
 * Keyboard shortcut handler.
 * Triggered by Ctrl+Shift+S / Cmd+Shift+S as defined in manifest.json.
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'trigger-screenshot') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await startCapture(tab.id, { format: 'png' });
  }
});

/**
 * Message listener.
 * popup.js sends { action: 'START_CAPTURE', options: { format, clipboard } }
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_CAPTURE') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        sendResponse({ error: 'No active tab found.' });
        return;
      }
      try {
        await startCapture(tab.id, message.options || {});
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true; // async sendResponse
  }

  if (message.action === 'GET_CAPTURE_STATUS') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({ capturing: tab ? capturingTabs.has(tab.id) : false });
    })();
    return true;
  }
});

// ─── Core Capture Logic ───────────────────────────────────────────────────────

/**
 * Orchestrates the full-page screenshot for a given tab.
 * @param {number} tabId
 * @param {{ format?: 'png'|'jpeg', quality?: number }} options
 */
async function startCapture(tabId, options = {}) {
  if (capturingTabs.has(tabId)) {
    console.warn('[FullSnap] Capture already in progress for tab', tabId);
    return;
  }

  capturingTabs.add(tabId);
  broadcastProgress(tabId, 0, 'Preparing…');

  try {
    // ── Step 1: Inject content script ────────────────────────────────────────
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });

    // ── Step 2: Get page dimensions ───────────────────────────────────────────
    const pageInfo = await sendToContent(tabId, { action: 'GET_PAGE_INFO' });
    const {
      pageHeight,
      viewportHeight,
      viewportWidth,
      devicePixelRatio,
    } = pageInfo;

    broadcastProgress(tabId, 5, 'Scanning page…');

    // ── Step 3: Prepare – lazy-load trigger + hide fixed elements ─────────────
    await sendToContent(tabId, { action: 'PREPARE_CAPTURE' });
    broadcastProgress(tabId, 10, 'Starting capture…');

    // ── Step 4: Determine scroll steps ───────────────────────────────────────
    // We scroll by `viewportHeight` each step.
    // The last step may be a partial scroll — we handle cropping later.
    const totalSteps = Math.ceil(pageHeight / viewportHeight);
    const screenshots = [];

    for (let step = 0; step < totalSteps; step++) {
      const scrollY = step * viewportHeight;

      // Scroll content script to the target position
      const scrollResult = await sendToContent(tabId, {
        action: 'SCROLL_TO',
        y: scrollY,
        delay: step === 0 ? LAZY_LOAD_DELAY_MS : SCROLL_DELAY_MS,
      });

      // Actual scrollY may differ if page isn't tall enough
      const actualScrollY = scrollResult.scrollY;

      // Capture the visible viewport
      const dataUrl = await captureVisibleTabWithRetry({
        format: options.format === 'jpeg' ? 'jpeg' : 'png',
        quality: options.quality || 92,
      });

      screenshots.push({
        dataUrl,
        scrollY: actualScrollY,
        stepIndex: step,
      });

      const progress = 10 + Math.round((step / totalSteps) * 75);
      broadcastProgress(tabId, progress, `Capturing… (${step + 1}/${totalSteps})`);
    }

    // ── Step 5: Restore page state ────────────────────────────────────────────
    await sendToContent(tabId, { action: 'RESTORE_PAGE' });
    broadcastProgress(tabId, 86, 'Stitching image…');

    // ── Step 6: Stitch screenshots into one image ─────────────────────────────
    const finalImageDataUrl = await stitchScreenshots(
      screenshots,
      pageHeight,
      viewportHeight,
      viewportWidth,
      devicePixelRatio,
      options
    );

    broadcastProgress(tabId, 95, 'Saving file…');

    // ── Step 7: Download ──────────────────────────────────────────────────────
    const format = options.format === 'jpeg' ? 'jpeg' : 'png';
    const filename = generateFilename(format);

    await chrome.downloads.download({
      url: finalImageDataUrl,
      filename,
      saveAs: false,
    });

    broadcastProgress(tabId, 100, 'Done!');

    // If clipboard copy was requested, signal popup (popup will handle it via canvas)
    if (options.clipboard) {
      broadcastToPopup(tabId, { action: 'COPY_TO_CLIPBOARD', dataUrl: finalImageDataUrl });
    }

  } catch (err) {
    console.error('[FullSnap] Capture failed:', err);
    broadcastProgress(tabId, -1, `Error: ${err.message}`);
    // Attempt to restore page state even on failure
    try {
      await sendToContent(tabId, { action: 'RESTORE_PAGE' });
    } catch (_) { /* ignore */ }
  } finally {
    capturingTabs.delete(tabId);
  }
}


/**
 * Waits for the given number of milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures the visible tab, retrying when Chrome temporarily rate limits us.
 * @param {{ format: string, quality?: number }} options
 */
async function captureVisibleTabWithRetry(options) {
  let delayMs = 250;

  for (;;) {
    try {
      return await chrome.tabs.captureVisibleTab(null, options);
    } catch (err) {
      if (!isCaptureQuotaError(err)) {
        throw err;
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 2000);
    }
  }
}

/**
 * Detects Chrome's captureVisibleTab quota error.
 * @param {unknown} err
 * @returns {boolean}
 */
function isCaptureQuotaError(err) {
  const message = err && typeof err === 'object' && 'message' in err
    ? String(err.message)
    : String(err);
  return message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
}

// ─── Image Stitching ──────────────────────────────────────────────────────────

/**
 * Stitches multiple viewport screenshots into one full-page image using
 * OffscreenCanvas (available in service workers since Chrome 109).
 *
 * @param {Array<{dataUrl: string, scrollY: number, stepIndex: number}>} screenshots
 * @param {number} pageHeight   - total page height in CSS px
 * @param {number} viewportH    - viewport height in CSS px
 * @param {number} viewportW    - viewport width in CSS px
 * @param {number} dpr          - device pixel ratio
 * @param {{format?: string, quality?: number}} options
 * @returns {Promise<string>} data URL of stitched image
 */
async function stitchScreenshots(screenshots, pageHeight, viewportH, viewportW, dpr, options) {
  // Physical pixels (accounting for retina/HiDPI displays)
  const physViewportH = Math.round(viewportH * dpr);
  const physViewportW = Math.round(viewportW * dpr);
  const physPageHeight = Math.round(pageHeight * dpr);

  // Create an OffscreenCanvas sized to the full page
  const canvas = new OffscreenCanvas(physViewportW, physPageHeight);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < screenshots.length; i++) {
    const { dataUrl, scrollY } = screenshots[i];

    // Decode the image from data URL
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    // Physical Y offset where this slice should be drawn on the canvas
    const destY = Math.round(scrollY * dpr);

    // Height of the source region to copy.
    // For all but the last step this is a full viewport height.
    // For the last step we only want the pixels that fall within the page.
    const remainingHeight = physPageHeight - destY;
    const srcHeight = Math.min(physViewportH, remainingHeight);

    if (srcHeight <= 0) continue;

    // Draw only the needed portion of the captured image
    ctx.drawImage(
      imageBitmap,
      0, 0, physViewportW, srcHeight,   // source rect
      0, destY, physViewportW, srcHeight // destination rect
    );

    imageBitmap.close();
  }

  // Convert canvas to blob → object URL
  const mimeType = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const quality = options.format === 'jpeg' ? (options.quality || 92) / 100 : undefined;
  const finalBlob = await canvas.convertToBlob({ type: mimeType, quality });

  return blobToDataUrl(finalBlob);
}

/**
 * Converts a Blob to a base64 data URL using FileReader.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

// ─── Messaging Helpers ────────────────────────────────────────────────────────

/**
 * Sends a message to content.js in the specified tab and returns the response.
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Broadcasts progress updates to the popup (if open).
 * @param {number} tabId
 * @param {number} percent  0–100, or -1 for error
 * @param {string} label    Human-readable status
 */
function broadcastProgress(tabId, percent, label) {
  // Store in extension storage so popup can read it even if it was just opened
  chrome.storage.session.set({ [`progress_${tabId}`]: { percent, label, ts: Date.now() } });

  // Also try sending directly to popup (may not be open)
  chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', tabId, percent, label })
    .catch(() => { /* popup not open – that's fine */ });
}

/**
 * Sends a message directly to the popup.
 */
function broadcastToPopup(tabId, payload) {
  chrome.runtime.sendMessage({ ...payload, tabId })
    .catch(() => { /* popup not open */ });
}

// ─── Filename Utility ─────────────────────────────────────────────────────────

/**
 * Generates a timestamp-based filename for the download.
 * @param {string} ext  'png' or 'jpeg'
 */
function generateFilename(ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `fullsnap-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}