# FullSnap

FullSnap is a Chrome extension for capturing full-page screenshots and saving them as PNG or JPEG.

## Features

- Capture the visible page and stitch it into one full-page image
- Support PNG and JPEG output
- Optional clipboard copy after capture
- Popup UI plus keyboard shortcut support

## Install

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this project folder

## Usage

- Click the extension icon to open the popup
- Choose PNG or JPEG
- Optionally enable clipboard copy
- Click `Capture Screenshot`
- Or use `Ctrl+Shift+S` on Windows/Linux, `Cmd+Shift+S` on macOS

## How It Works

- `background.js` coordinates the capture flow
- `content.js` measures the page, scrolls it, and hides repeated fixed elements
- The background worker captures each viewport, stitches the images, and downloads the result

## Project Files

- `manifest.json` - extension manifest and permissions
- `popup.html` / `popup.js` - popup UI
- `background.js` - capture orchestration
- `content.js` - page interaction helpers
- `styles.css` - popup styling

## Notes

- Full-page capture relies on Chrome's `captureVisibleTab` API, so very fast repeated captures can still be rate-limited by the browser.
- The extension is designed to capture the entire scrollable page, not just the visible viewport.
