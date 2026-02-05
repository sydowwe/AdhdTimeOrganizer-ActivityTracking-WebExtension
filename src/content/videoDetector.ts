import browser from 'webextension-polyfill';

/**
 * Content script to detect video playback on the page.
 * Tracks <video> elements that are playing (not paused).
 */

let hasPlayingVideo: boolean = false;
let checkInterval: ReturnType<typeof setInterval> | null = null;

const VIDEO_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

function sendVideoPlayingUpdate(isPlaying: boolean): void {
  try {
    browser.runtime.sendMessage({
      type: 'VIDEO_PLAYING_CHANGED',
      payload: {
        hasPlayingVideo: isPlaying
      }
    }).catch(() => {
      // Ignore errors - background may not be ready
    });
  } catch {
    // Ignore errors during page unload
  }
}

function checkForPlayingVideos(): boolean {
  const videos = document.querySelectorAll('video');

  for (const video of videos) {
    // Check if video is playing (not paused, not ended, and has duration)
    if (!video.paused && !video.ended && video.duration > 0) {
      return true;
    }
  }

  return false;
}

function updateVideoPlayingState(): void {
  const isPlaying = checkForPlayingVideos();

  if (isPlaying !== hasPlayingVideo) {
    hasPlayingVideo = isPlaying;
    sendVideoPlayingUpdate(isPlaying);
  }
}

function handleVideoPlay(): void {
  if (!hasPlayingVideo) {
    hasPlayingVideo = true;
    sendVideoPlayingUpdate(true);
  }
}

function handleVideoPause(): void {
  // Need to check if any other videos are still playing
  updateVideoPlayingState();
}

function setupVideoListeners(): void {
  // Listen for play/pause events on all current and future video elements
  document.addEventListener('play', function(event) {
    if (event.target instanceof HTMLVideoElement) {
      handleVideoPlay();
    }
  }, true); // Use capture phase to catch events on dynamically added videos

  document.addEventListener('pause', function(event) {
    if (event.target instanceof HTMLVideoElement) {
      handleVideoPause();
    }
  }, true);

  document.addEventListener('ended', function(event) {
    if (event.target instanceof HTMLVideoElement) {
      handleVideoPause();
    }
  }, true);
}

function startPeriodicCheck(): void {
  // Periodic check as fallback (in case events are missed)
  checkInterval = setInterval(function() {
    updateVideoPlayingState();
  }, VIDEO_CHECK_INTERVAL_MS);
}

function cleanup(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }

  // Send final state
  if (hasPlayingVideo) {
    sendVideoPlayingUpdate(false);
  }
}

// Initialize
setupVideoListeners();
startPeriodicCheck();

// Send initial state
updateVideoPlayingState();

// Cleanup on page unload
window.addEventListener('pagehide', cleanup);
window.addEventListener('unload', cleanup);
