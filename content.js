/**
 * content.js
 * Injected into the active tab. Handles page measurement, scrolling,
 * fixed-element management, and lazy-load triggering.
 *
 * Critical design: sendResponse is ONLY called after two consecutive
 * requestAnimationFrame calls, guaranteeing the browser compositor has
 * fully painted the new scroll position before background.js captures.
 */

(function () {
  'use strict';

  // ─── Re-injection guard ───────────────────────────────────────────────────
  // If already injected, just signal ready — don't re-register listeners.
  if (window.__fullSnapInjected) {
    return;
  }
  window.__fullSnapInjected = true;

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    originalScrollX : window.scrollX,
    originalScrollY : window.scrollY,
    hiddenElements  : [],
    originalStyles  : [],
  };

  // ─── Page measurement ─────────────────────────────────────────────────────

  function getFullPageHeight() {
    // Force layout flush so we get the real value
    document.body.getBoundingClientRect();
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body.scrollHeight, body.offsetHeight,
      html.scrollHeight, html.offsetHeight, html.clientHeight
    );
  }

  function getFullPageWidth() {
    const body = document.body;
    const html = document.documentElement;
    return Math.max(
      body.scrollWidth, body.offsetWidth,
      html.scrollWidth, html.offsetWidth, html.clientWidth
    );
  }

  function getViewportHeight() {
    return window.innerHeight;
  }

  // ─── Guaranteed-paint scroll ──────────────────────────────────────────────

  /**
   * Scrolls to `y` and resolves only after the browser has composited TWO
   * animation frames — meaning the pixel content on screen has actually
   * changed. This is the key fix for "only captures the visible viewport".
   *
   * One rAF is NOT enough: the first fires at the start of the frame pipeline
   * before paint. The second fires after the previous frame has been committed
   * to the compositor, so we know the new scroll position is on screen.
   *
   * @param {number} y      Target scrollTop in CSS px
   * @param {number} extra  Additional ms to wait after paint (for JS reflows)
   */
  function scrollAndWaitForPaint(y, extra = 120) {
    return new Promise((resolve) => {
      // Use scrollTo with instant so there's no animation to wait for
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });

      // Wait for two paint frames + extra settle time
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (extra > 0) {
            setTimeout(resolve, extra);
          } else {
            resolve();
          }
        });
      });
    });
  }

  // ─── Lazy-load trigger ────────────────────────────────────────────────────

  /**
   * Scrolls the entire page top-to-bottom slowly to trigger IntersectionObserver
   * callbacks and <img loading="lazy"> loads. Does NOT hide fixed elements.
   */
  async function triggerLazyLoad() {
    const viewH = getViewportHeight();
    let y = 0;

    while (true) {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      // Single rAF + short delay is fine here — we don't capture during this phase
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));

      const pageH = getFullPageHeight(); // re-measure — lazy load grows the page
      if (y + viewH >= pageH) break;
      y += viewH;
    }

    // Return to top
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 300));
  }

  // ─── Fixed/sticky element management ─────────────────────────────────────

  function hideFixedElements() {
    // Fresh scan every time (new elements may have appeared)
    document.querySelectorAll('*').forEach((el) => {
      const pos = window.getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        state.hiddenElements.push(el);
        state.originalStyles.push({ el, visibility: el.style.visibility });
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    });
  }

  function restoreFixedElements() {
    state.originalStyles.forEach(({ el, visibility }) => {
      el.style.visibility = visibility;
    });
    state.hiddenElements = [];
    state.originalStyles = [];
  }

  function restorePageState() {
    restoreFixedElements();
    window.scrollTo({ top: state.originalScrollY, left: state.originalScrollX, behavior: 'instant' });
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {

      // ── Dimensions ────────────────────────────────────────────────────────
      case 'GET_PAGE_INFO': {
        sendResponse({
          pageHeight      : getFullPageHeight(),
          pageWidth       : getFullPageWidth(),
          viewportHeight  : getViewportHeight(),
          viewportWidth   : window.innerWidth,
          scrollY         : window.scrollY,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        break;
      }

      // ── Phase 1: lazy-load scan (no hiding, no capture) ───────────────────
      case 'TRIGGER_LAZY_LOAD': {
        (async () => {
          await triggerLazyLoad();
          // Re-measure after lazy load — page may have grown
          sendResponse({
            pageHeight    : getFullPageHeight(),
            viewportHeight: getViewportHeight(),
          });
        })();
        return true; // async
      }

      // ── Phase 2: hide fixed elements after first frame is captured ────────
      case 'HIDE_FIXED_ELEMENTS': {
        hideFixedElements();
        sendResponse({ hidden: state.hiddenElements.length });
        break;
      }

      // ── Scroll to Y and confirm paint before responding ───────────────────
      // background.js MUST NOT call captureVisibleTab until this resolves.
      case 'SCROLL_TO': {
        (async () => {
          const targetY = message.y;
          const extra   = message.extra ?? 120;

          await scrollAndWaitForPaint(targetY, extra);

          // Verify actual scroll position — the browser may clamp scrollY
          // if targetY exceeds the real scrollable range.
          const actualY = window.scrollY;

          sendResponse({
            scrollY    : actualY,
            pageHeight : getFullPageHeight(),  // may have grown
            atBottom   : (actualY + getViewportHeight()) >= getFullPageHeight() - 2,
          });
        })();
        return true; // async
      }

      // ── Restore everything ────────────────────────────────────────────────
      case 'RESTORE_PAGE': {
        restorePageState();
        sendResponse({ restored: true });
        break;
      }

      default:
        sendResponse({ error: `Unknown action: ${message.action}` });
    }

    return false;
  });

  console.log('[FullSnap] content.js ready, page height:', getFullPageHeight());
})();
