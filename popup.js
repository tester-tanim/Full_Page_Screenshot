/**
 * popup.js
 * Controls the FullSnap popup UI.
 * Communicates with background.js to start capture and receive progress updates.
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────
const btnCapture = document.getElementById('btnCapture');
const progressSection = document.getElementById('progressSection');
const progressLabel = document.getElementById('progressLabel');
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');
const previewSection = document.getElementById('previewSection');
const previewImg = document.getElementById('previewImg');
const btnDownload = document.getElementById('btnDownload');
const btnCopyImg = document.getElementById('btnCopyImg');
const statusMsg = document.getElementById('statusMsg');
const chkClipboard = document.getElementById('chkClipboard');
const formatBtns = document.querySelectorAll('.format-btn');

// ─── State ────────────────────────────────────────────────────────────────────
let selectedFormat = 'png';
let lastDataUrl = null;

// ─── Format Toggle ────────────────────────────────────────────────────────────

formatBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    formatBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.fmt;
  });
});

// ─── Capture Button ───────────────────────────────────────────────────────────

btnCapture.addEventListener('click', startCapture);

/**
 * Triggers the capture via a message to background.js.
 * Disables the button and shows the progress section.
 */
async function startCapture() {
  if (btnCapture.disabled) return;

  // UI: enter capturing state
  setCapturing(true);
  hidePreview();
  setStatus('');
  updateProgress(0, 'Preparing…');

  try {
    const response = await sendMessage({
      action: 'START_CAPTURE',
      options: {
        format: selectedFormat,
        clipboard: chkClipboard.checked,
      },
    });

    if (response && response.error) {
      handleError(response.error);
    }
    // Progress updates arrive via onMessage listener below
  } catch (err) {
    handleError(err.message || 'Unexpected error.');
  }
}

// ─── Progress Listener ────────────────────────────────────────────────────────

/**
 * Receives PROGRESS_UPDATE messages from background.js and updates the UI.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'PROGRESS_UPDATE') {
    const { percent, label } = message;

    if (percent === -1) {
      // Error
      handleError(label || 'Capture failed.');
      return;
    }

    updateProgress(percent, label);

    if (percent === 100) {
      // Capture done — background will have already started download
      setCapturing(false);
      setStatus('Screenshot saved!', 'success');
      updateProgress(100, 'Done!');
    }
  }

  if (message.action === 'COPY_TO_CLIPBOARD') {
    copyDataUrlToClipboard(message.dataUrl);
    showPreview(message.dataUrl);
    lastDataUrl = message.dataUrl;
  }
});

// ─── Preview & Download Buttons ───────────────────────────────────────────────

btnDownload.addEventListener('click', () => {
  if (!lastDataUrl) return;
  const a = document.createElement('a');
  a.href = lastDataUrl;
  a.download = generateFilename(selectedFormat);
  a.click();
});

btnCopyImg.addEventListener('click', async () => {
  if (!lastDataUrl) return;
  try {
    await copyDataUrlToClipboard(lastDataUrl);
    setStatus('Copied to clipboard!', 'success');
  } catch {
    setStatus('Clipboard copy failed.', 'error');
  }
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────

/**
 * Sets the capturing state of the UI.
 * @param {boolean} active
 */
function setCapturing(active) {
  btnCapture.disabled = active;
  progressSection.classList.toggle('visible', active);
}

/**
 * Updates the progress bar and label.
 * @param {number} percent
 * @param {string} label
 */
function updateProgress(percent, label) {
  progressFill.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressLabel.textContent = label;

  // Remove state classes
  progressFill.classList.remove('error', 'done');
  if (percent === 100) progressFill.classList.add('done');
}

/**
 * Shows the preview panel with the given data URL.
 * @param {string} dataUrl
 */
function showPreview(dataUrl) {
  previewImg.src = dataUrl;
  previewSection.classList.add('visible');
}

/** Hides the preview panel. */
function hidePreview() {
  previewSection.classList.remove('visible');
  previewImg.src = '';
}

/**
 * Updates the status message.
 * @param {string} text
 * @param {'success'|'error'|''} type
 */
function setStatus(text, type = '') {
  statusMsg.textContent = text;
  statusMsg.className = 'status-msg';
  if (type) statusMsg.classList.add(type);
}

/**
 * Handles error states: shows error in progress bar and status.
 * @param {string} msg
 */
function handleError(msg) {
  setCapturing(false);
  progressSection.classList.add('visible');
  progressFill.classList.add('error');
  progressFill.style.width = '100%';
  progressLabel.textContent = 'Failed';
  progressPercent.textContent = '—';
  setStatus(msg, 'error');
  console.error('[FullSnap Popup] Error:', msg);
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

/**
 * Copies a data URL image to the clipboard using the Clipboard API.
 * @param {string} dataUrl
 * @returns {Promise<void>}
 */
async function copyDataUrlToClipboard(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  // Clipboard API requires image/png
  const pngBlob = blob.type === 'image/png' ? blob : await convertToPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
}

/**
 * Converts any image blob to PNG via an offscreen canvas.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function convertToPng(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Conversion failed')), 'image/png');
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ─── Messaging ────────────────────────────────────────────────────────────────

/**
 * Wraps chrome.runtime.sendMessage in a Promise.
 * @param {object} message
 * @returns {Promise<object>}
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Init: check if capture already in progress ────────────────────────────

(async () => {
  try {
    const res = await sendMessage({ action: 'GET_CAPTURE_STATUS' });
    if (res && res.capturing) {
      setCapturing(true);
      setStatus('Capture already in progress…');
    }
  } catch {
    /* background not ready yet — that's okay */
  }
})();

// ─── Filename Utility ─────────────────────────────────────────────────────────

function generateFilename(ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `fullsnap-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}