/**
 * utils.js
 * Shared utility functions used across the extension.
 */

/**
 * Generates a timestamp-based filename for the screenshot.
 * @param {string} format - 'png' or 'jpeg'
 * @returns {string} filename like fullsnap-2024-01-15-143022.png
 */
function generateFilename(format = 'png') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `fullsnap-${datePart}-${timePart}.${format}`;
}

/**
 * Clamps a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates the progress percentage given current step and total steps.
 * @param {number} current
 * @param {number} total
 * @returns {number} 0–100
 */
function calcProgress(current, total) {
  if (total === 0) return 100;
  return Math.round(clamp((current / total) * 100, 0, 100));
}

// Export for use in background.js (service worker context)
if (typeof module !== 'undefined') {
  module.exports = { generateFilename, clamp, sleep, calcProgress };
}
