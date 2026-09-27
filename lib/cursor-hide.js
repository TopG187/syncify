/**
 * Hide/show the OS cursor while driving the remote machine.
 */
let hideCount = 0;
let api = null;

function loadApi() {
  if (api) return api;
  try {
    const koffi = require('koffi');
    if (process.platform === 'win32') {
      const user32 = koffi.load('user32.dll');
      const ShowCursor = user32.func('ShowCursor', 'int', ['bool']);
      api = {
        hide: () => {
          // ShowCursor(false) decrements; loop until hidden
          let c = ShowCursor(false);
          while (c >= 0) c = ShowCursor(false);
        },
        show: () => {
          let c = ShowCursor(true);
          while (c < 0) c = ShowCursor(true);
        },
      };
    } else if (process.platform === 'darwin') {
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      const CGMainDisplayID = cg.func('CGMainDisplayID', 'uint32', []);
      const CGDisplayHideCursor = cg.func('CGDisplayHideCursor', 'int32', ['uint32']);
      const CGDisplayShowCursor = cg.func('CGDisplayShowCursor', 'int32', ['uint32']);
      api = {
        hide: () => CGDisplayHideCursor(CGMainDisplayID()),
        show: () => CGDisplayShowCursor(CGMainDisplayID()),
      };
    } else {
      api = { hide: () => {}, show: () => {} };
    }
  } catch (err) {
    console.warn('cursor hide unavailable:', err.message);
    api = { hide: () => {}, show: () => {} };
  }
  return api;
}

function hideCursor() {
  hideCount += 1;
  if (hideCount === 1) {
    try {
      loadApi().hide();
    } catch (err) {
      console.warn('hideCursor:', err.message);
    }
  }
}

function showCursor() {
  if (hideCount <= 0) return;
  hideCount -= 1;
  if (hideCount === 0) {
    try {
      loadApi().show();
    } catch (err) {
      console.warn('showCursor:', err.message);
    }
  }
}

function forceShowCursor() {
  hideCount = 0;
  try {
    loadApi().show();
    // Extra show calls help Windows show-count recover
    if (process.platform === 'win32') {
      for (let i = 0; i < 8; i++) loadApi().show();
    }
  } catch {
    /* ignore */
  }
}

module.exports = { hideCursor, showCursor, forceShowCursor };
