/**
 * content.js
 * Injected into the active tab. Handles scrolling, fixed-element hiding,
 * lazy-load triggering, and coordinates with background.js during capture.
 */

(function () {
  'use strict';

  // ─── Guard: prevent double-injection ─────────────────────────────────────
  if (window.__fullSnapActive) {
    console.warn('[FullSnap] Already active – ignoring re-injection.');
    return;
  }
  window.__fullSnapActive = true;

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    originalScrollX: window.scrollX,
    originalScrollY: window.scrollY,
    hiddenElements: [],   // elements temporarily hidden
    originalStyles: [],   // { el, display } backup
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Returns the full scrollable height of the page.
   * Uses the maximum across several reliable measurements.
   */
  function getFullPageHeight() {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body.scrollHeight, body.offsetHeight, body.clientHeight,
      html.scrollHeight, html.offsetHeight, html.clientHeight
    );
  }

  /** Returns the viewport (visible area) height. */
  function getViewportHeight() {
    return window.innerHeight;
  }

  /** Returns the full page width. */
  function getFullPageWidth() {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body.scrollWidth, body.offsetWidth,
      html.scrollWidth, html.offsetWidth,
      html.clientWidth
    );
  }

  /**
   * Finds all fixed/sticky elements (headers, banners, cookie bars, etc.)
   * and hides them so they don't appear multiple times across stitched shots.
   */
  function hideFixedElements() {
    const all = document.querySelectorAll('*');
    all.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        state.hiddenElements.push(el);
        state.originalStyles.push({
          el,
          visibility: el.style.visibility,
          display: el.style.display,
        });
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    });
  }

  /** Restores all previously hidden fixed/sticky elements. */
  function restoreFixedElements() {
    state.originalStyles.forEach(({ el, visibility }) => {
      el.style.visibility = visibility;
    });
    state.hiddenElements = [];
    state.originalStyles = [];
  }

  /**
   * Scrolls the page to a given Y position and waits for a frame + settle time.
   * The extra delay allows lazy-loaded images and deferred content to render.
   * @param {number} y - scroll top position in px
   * @param {number} [delay=180] - ms to wait after scroll
   */
  function scrollToAndWait(y, delay = 180) {
    return new Promise((resolve) => {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      // rAF ensures the browser has painted after scrolling
      requestAnimationFrame(() => {
        setTimeout(resolve, delay);
      });
    });
  }

  /**
   * Pre-scrolls the page from top to bottom before the real capture begins.
   * This triggers lazy-loaded images so they're available when we come back.
   */
  async function triggerLazyLoad() {
    const pageHeight = getFullPageHeight();
    const viewHeight = getViewportHeight();
    let y = 0;
    while (y < pageHeight) {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
      y += viewHeight;
    }
    // Scroll back to top before real capture
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 200));
  }

  /**
   * Restores the page to its original scroll position and cleans up all state.
   */
  function restorePageState() {
    restoreFixedElements();
    window.scrollTo({ top: state.originalScrollY, left: state.originalScrollX, behavior: 'instant' });
    window.__fullSnapActive = false;
  }

  // ─── Message Handler ──────────────────────────────────────────────────────

  /**
   * Listens for messages from background.js and responds with the data needed
   * to orchestrate the full-page capture.
   *
   * Protocol:
   *   { action: 'GET_PAGE_INFO' }          → page dimensions + scroll info
   *   { action: 'PREPARE_CAPTURE' }        → hide fixed els, trigger lazy load
   *   { action: 'SCROLL_TO', y: number }   → scroll to position, returns ack
   *   { action: 'RESTORE_PAGE' }           → restore scroll + fixed elements
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {

      case 'GET_PAGE_INFO': {
        sendResponse({
          pageHeight: getFullPageHeight(),
          pageWidth: getFullPageWidth(),
          viewportHeight: getViewportHeight(),
          viewportWidth: window.innerWidth,
          scrollY: window.scrollY,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        break;
      }

      case 'PREPARE_CAPTURE': {
        // Must use async IIFE because addListener can't be async directly
        (async () => {
          await triggerLazyLoad();
          hideFixedElements();
          // Scroll to very top for capture start
          window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 150));
          sendResponse({ ready: true });
        })();
        return true; // keep message channel open for async sendResponse
      }

      case 'SCROLL_TO': {
        (async () => {
          await scrollToAndWait(message.y, message.delay || 180);
          sendResponse({
            scrollY: window.scrollY,
            pageHeight: getFullPageHeight(),
          });
        })();
        return true;
      }

      case 'RESTORE_PAGE': {
        restorePageState();
        sendResponse({ restored: true });
        break;
      }

      default:
        sendResponse({ error: `Unknown action: ${message.action}` });
    }

    // Return true only when sendResponse is called asynchronously (handled above).
    return false;
  });

  console.log('[FullSnap] Content script ready.');
})();