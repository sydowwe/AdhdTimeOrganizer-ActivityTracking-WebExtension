import browser from 'webextension-polyfill';
import { tracker } from './tracker';
import { authManager } from './auth';
import { sendHeartbeat } from './api';
import { HEARTBEAT_INTERVAL_MS, log, logError } from '@shared/config';
import type { Message, LoginCredentials } from '@shared/types';
import { saveSettings, updateStatsFromWindow } from './storage';

const HEARTBEAT_ALARM_NAME = 'heartbeat';

// Initialize tracker and set up alarms
async function initialize(): Promise<void> {
  log('Background service worker starting');

  try {
    // Initialize auth manager first
    await authManager.initialize();

    // Initialize the activity tracker
    await tracker.initialize();

    // Set up heartbeat alarm
    await browser.alarms.create(HEARTBEAT_ALARM_NAME, {
      periodInMinutes: HEARTBEAT_INTERVAL_MS / 60000
    });

    // Listen for auth state changes
    authManager.onAuthChange((state) => {
      log('Auth state changed:', state.isAuthenticated);
      if (!state.isAuthenticated) {
        // Pause tracking when logged out
        tracker.setPaused(true);
      }
    });

    log('Background service worker initialized');
  } catch (error) {
    logError('Failed to initialize:', error);
  }
}

// Handle heartbeat alarm
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === HEARTBEAT_ALARM_NAME) {
    log('Heartbeat alarm triggered');

    // Only send heartbeat if authenticated
    if (authManager.isAuthenticated()) {
      const window = tracker.getActivityWindow();
      const isIdle = tracker.getIsIdle();
      const success = await sendHeartbeat(window, isIdle);

      // If window was final and successfully sent, update daily stats and clear buffer
      if (success && window?.isFinal) {
        await updateStatsFromWindow(window);
        tracker.clearCurrentBuffer();
      }
    } else {
      log('Skipping heartbeat - not authenticated');
    }
  }
});

// Handle messages from popup and options pages
browser.runtime.onMessage.addListener(
  async (message: Message): Promise<unknown> => {
    log('Received message:', message.type);

    switch (message.type) {
      case 'GET_STATS': {
        const stats = await tracker.getStatsResponse();
        // Override status if not authenticated
        if (!authManager.isAuthenticated()) {
          stats.status = 'unauthenticated';
        }
        return stats;
      }

      case 'GET_CURRENT_STATE': {
        const stats = await tracker.getStatsResponse();
        if (!authManager.isAuthenticated()) {
          stats.status = 'unauthenticated';
        }
        return stats;
      }

      case 'TOGGLE_PAUSE': {
        const isPaused = await tracker.togglePause();
        return { isPaused };
      }

      case 'UPDATE_SETTINGS': {
        const settings = message.payload as { blocklist: string[]; trackFullUrlDomains: string[] };
        await saveSettings(settings);
        tracker.updateSettings(settings);
        return { success: true };
      }

      case 'LOGIN': {
        const credentials = message.payload as LoginCredentials;
        const result = await authManager.login(credentials);

        if (result.success) {
          // Resume tracking after successful login
          tracker.setPaused(false);
        }

        return result;
      }

      case 'LOGOUT': {
        await authManager.logout();
        tracker.setPaused(true);
        return { success: true };
      }

      case 'GET_AUTH_STATE': {
        return authManager.getAuthState();
      }

      case 'GET_VISIBILITY': {
        // Content script requesting visibility state (handled directly by content script)
        return null;
      }

      default:
        log('Unknown message type:', message.type);
        return null;
    }
  }
);

// Handle extension install/update
browser.runtime.onInstalled.addListener(async (details) => {
  log('Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // First install - set default settings
    const defaultSettings = {
      blocklist: [],
      trackFullUrlDomains: []
    };
    await saveSettings(defaultSettings);
    log('Default settings saved');
  }

  // Re-initialize on update
  await initialize();
});

// Handle browser startup
browser.runtime.onStartup.addListener(async () => {
  log('Browser started');
  await initialize();
});

// Initialize immediately (for when service worker starts)
initialize().catch(logError);
