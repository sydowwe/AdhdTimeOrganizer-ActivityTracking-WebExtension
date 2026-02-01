import browser from 'webextension-polyfill';

/**
 * Content script to detect page visibility changes.
 * This allows tracking of tabs that are visible but not focused
 * (e.g., on a second monitor).
 */

let lastVisibilityState: boolean = document.visibilityState === 'visible';

function sendVisibilityUpdate(isVisible: boolean): void {
  try {
    browser.runtime.sendMessage({
      type: 'VISIBILITY_CHANGED',
      payload: {
        isVisible
      }
    }).catch(() => {
      // Ignore errors - background may not be ready
    });
  } catch {
    // Ignore errors during page unload
  }
}

function handleVisibilityChange(): void {
  const isVisible = document.visibilityState === 'visible';

  if (isVisible !== lastVisibilityState) {
    lastVisibilityState = isVisible;
    sendVisibilityUpdate(isVisible);
  }
}

// Listen for visibility changes
document.addEventListener('visibilitychange', handleVisibilityChange);

// Send initial visibility state
sendVisibilityUpdate(lastVisibilityState);

// Also handle page hide/show events for additional accuracy
document.addEventListener('pagehide', () => {
  sendVisibilityUpdate(false);
});

document.addEventListener('pageshow', () => {
  sendVisibilityUpdate(document.visibilityState === 'visible');
});
