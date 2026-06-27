# FullSnap — Full Page Screenshot Extension

> A lightweight Chrome extension that captures pixel-perfect, full-page screenshots of any website — including content far below the visible viewport.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Usage](#usage)
- [Keyboard Shortcut](#keyboard-shortcut)
- [File Structure](#file-structure)
- [Technical Architecture](#technical-architecture)
- [Browser Compatibility](#browser-compatibility)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Overview

FullSnap solves a problem that every built-in screenshot tool fails at: capturing an **entire scrollable webpage** as one seamless image. Whether it's a landing page, a long article, a dashboard, or a documentation site — FullSnap scrolls through it automatically, stitches every section together, and saves the result as a high-quality PNG or JPEG with a single click.

Built entirely with vanilla JavaScript and Manifest V3. No third-party libraries. No cloud uploads. Everything happens locally in your browser.

---

## Features

| Feature | Details |
|---|---|
| **Full-page capture** | Captures the entire scrollable height, not just what's on screen |
| **Header preservation** | Fixed/sticky navbars appear exactly once at the top of the final image |
| **Lazy-load support** | Pre-scrolls the page before capture to trigger deferred images and content |
| **Format choice** | Export as PNG (lossless) or JPEG (smaller file size) |
| **Keyboard shortcut** | `Ctrl+Shift+S` / `Cmd+Shift+S` triggers capture without opening the popup |
| **Clipboard copy** | Optionally copy the screenshot directly to your clipboard |
| **Screenshot preview** | View a thumbnail of the result before or instead of downloading |
| **Progress indicator** | Live percentage bar shows capture progress frame by frame |
| **Duplicate-capture guard** | Prevents a second capture from starting while one is in progress |
| **No size limits** | Canvas grows to the true page height — no artificial ceiling |
| **HiDPI / Retina support** | Accounts for `devicePixelRatio` so output is always sharp |

---

## How It Works

FullSnap uses a three-phase approach to guarantee every pixel is captured correctly:

**Phase 1 — Lazy-load scan**
The content script silently scrolls the page from top to bottom at high speed. This fires `IntersectionObserver` callbacks and loads `<img loading="lazy">` elements so they are visible when the real capture begins.

**Phase 2 — Capture with guaranteed paint synchronisation**
The extension scrolls the page section by section. After each scroll, it waits for **two consecutive `requestAnimationFrame` callbacks** — the first marks the start of the new frame pipeline, the second confirms the compositor has committed the new pixels to screen. Only then is `captureVisibleTab` called. This is the key detail that prevents capturing the old scroll position instead of the new one.

**Phase 3 — Stitch**
All captured frames (each one a viewport-sized slice) are decoded and drawn onto an `OffscreenCanvas` at their exact `scrollY` offsets. The canvas height is derived from the actual captured data, not a pre-measured estimate, so dynamic content that grew during scrolling is never cut off.

**Fixed-element handling**
The first frame is captured with fixed/sticky elements visible so the navbar appears at the top of the image. They are hidden for all subsequent frames to prevent them from being duplicated across sections. All elements are restored to their original state after capture.

---

## Installation

FullSnap is a developer extension loaded directly into Chrome. It does not require the Chrome Web Store.

**Step 1 — Download**

Download or clone this repository and unzip it to a permanent folder on your machine. Do not delete the folder after loading — Chrome needs it to remain in place.

**Step 2 — Open Chrome Extensions**

Navigate to `chrome://extensions` in your browser.

**Step 3 — Enable Developer Mode**

Toggle **Developer mode** on using the switch in the top-right corner of the Extensions page.

**Step 4 — Load the extension**

Click **Load unpacked** and select the `fullpage-screenshot-extension` folder (the one containing `manifest.json`).

**Step 5 — Pin the extension** *(optional but recommended)*

Click the puzzle-piece icon in the Chrome toolbar, find **FullSnap**, and click the pin icon so it always appears in your toolbar.

---

## Usage

### Popup

1. Navigate to any webpage you want to capture.
2. Click the **FullSnap** camera icon in the Chrome toolbar.
3. Choose your preferred **format** (PNG or JPEG).
4. Toggle **Copy to clipboard** if you want the image on your clipboard as well.
5. Click **Capture Full Page**.
6. A progress bar will show capture progress. The file is automatically saved to your default Downloads folder when complete.

### Options

| Option | Default | Description |
|---|---|---|
| Format | PNG | PNG is lossless. JPEG produces smaller files for long pages. |
| Copy to clipboard | Off | Also copies the final image to the system clipboard as PNG. |

---

## Keyboard Shortcut

You can capture the current page without opening the popup at all.

| Platform | Shortcut |
|---|---|
| Windows / Linux | `Ctrl + Shift + S` |
| macOS | `Cmd + Shift + S` |

To change the shortcut, go to `chrome://extensions/shortcuts` and find **FullSnap**.

---

## File Structure

```
fullpage-screenshot-extension/
│
├── manifest.json       # Extension configuration (Manifest V3)
├── background.js       # Service worker: orchestrates the capture loop,
│                       # rate-limits captureVisibleTab, stitches frames
├── content.js          # Injected into the page: scrolling, paint-sync,
│                       # lazy-load triggering, fixed-element management
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic: options, progress, preview, clipboard
├── styles.css          # Popup styles
├── utils.js            # Shared utilities (filename generation, sleep, etc.)
│
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Technical Architecture

### Manifest V3

FullSnap is built on Manifest V3, Chrome's current extension platform. The background page is implemented as a **service worker** (`background.js`), which means it has no persistent DOM access and communicates with the tab exclusively via message passing.

### Permissions

| Permission | Why it's needed |
|---|---|
| `activeTab` | Access the currently active tab to inject scripts and capture it |
| `scripting` | Inject `content.js` into the page at capture time |
| `tabs` | Call `captureVisibleTab` and query the active tab |
| `storage` | Store in-progress capture state so the popup can read it if opened mid-capture |
| `downloads` | Save the final image to the user's Downloads folder |

### Rate limiting

Chrome enforces a hard limit of **2 calls to `captureVisibleTab` per second**. FullSnap wraps every capture call in a throttle function that tracks the timestamp of the last call and waits until at least 560 ms have elapsed before firing the next one, keeping throughput at approximately 1.8 captures/second.

### Paint synchronisation

The most common failure mode in scroll-and-capture extensions is capturing the **old** scroll position because the browser hadn't finished painting the **new** one. FullSnap prevents this by resolving the scroll promise only after two consecutive `requestAnimationFrame` callbacks plus a configurable settle delay:

```
scrollTo(y)
  → rAF 1: frame pipeline starts
    → rAF 2: previous frame committed to compositor
      → setTimeout(settle): JS reflows complete
        → sendResponse() → captureVisibleTab()
```

### Stitching

`OffscreenCanvas` is used in the service worker to compose all frames. Each frame is decoded with `createImageBitmap` and drawn at its exact `scrollY × devicePixelRatio` offset. The canvas height is computed from the actual bottom pixel of the last captured frame, not from any pre-measured page height estimate.

---

## Browser Compatibility

| Browser | Supported |
|---|---|
| Google Chrome 109+ | ✅ Yes |
| Microsoft Edge 109+ | ✅ Yes (Chromium-based) |
| Firefox | ❌ No (uses Chrome-specific APIs) |
| Safari | ❌ No |

`OffscreenCanvas` in service workers requires Chrome 109 or later. Most users on a current Chrome release are covered.

---

## Known Limitations

**Chrome-protected pages**
Chrome blocks extension scripts on certain built-in pages such as `chrome://`, `chrome-extension://`, and the Chrome Web Store. FullSnap will show an error on these pages — this is an intentional browser security restriction and cannot be worked around.

**Very long pages**
Pages with tens of thousands of pixels of content will produce correspondingly large image files. A 20 000 px tall page at 2× DPI produces a 40 000 px tall canvas. Most image viewers handle this fine, but some older software may struggle.

**Pages with scroll-blocking JavaScript**
Some single-page applications intercept `window.scrollTo` or manage scroll entirely in JavaScript. On such pages the extension may only capture what was visible when clicked. If you encounter this, try scrolling to the top of the page manually before capturing.

**Iframes**
Content inside cross-origin iframes is not accessible to the content script. Those regions will appear as their rendered visual output only — no special handling is applied inside them.

**PDFs opened in Chrome**
Chrome's built-in PDF viewer does not support content script injection. Use the keyboard shortcut or popup on standard HTML pages only.

---

## Troubleshooting

**The extension captures only the visible area**
Make sure you are on a standard `https://` or `http://` page. Reload the extension from `chrome://extensions` after any update and try again.

**"Error: This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota"**
This should not occur with the current build. If it does, go to `chrome://extensions`, click the reload icon on FullSnap, and try again. The rate limiter resets between captures.

**The navbar is missing or duplicated**
This was a known bug in earlier versions. The current build captures the first frame before hiding fixed elements and hides them for all subsequent frames, so the navbar appears exactly once.

**Progress bar reaches 100% but no file is saved**
Check your Chrome download settings at `chrome://settings/downloads`. If "Ask where to save each file before downloading" is on, the save dialog may have appeared behind another window.

**Extension doesn't appear after loading**
Confirm you selected the folder that contains `manifest.json` directly (not a parent folder). If the Extensions page shows an error, click **Details** on the FullSnap card to read the specific message.

---

## License

MIT License — free to use, modify, and distribute.
