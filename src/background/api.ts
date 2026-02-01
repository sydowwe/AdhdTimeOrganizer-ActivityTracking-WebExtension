import type { ActivityEvent, ActivityHeartbeat } from '@shared/types';
import { API_BASE_URL, API_ACTIVITY_ENDPOINT, log, logError } from '@shared/config';
import { getTimestamp } from '@shared/utils';
import { addQueuedEvents, getQueuedEvents, clearQueuedEvents } from './storage';
import { authManager } from './auth';

/**
 * Send heartbeat with events to the API
 * Returns true if successful, false if failed (events will be queued)
 */
export async function sendHeartbeat(
  events: ActivityEvent[],
  isIdle: boolean
): Promise<boolean> {
  // Check if authenticated
  const accessToken = authManager.getAccessToken();
  if (!accessToken) {
    log('Not authenticated, queuing events');
    if (events.length > 0) {
      await addQueuedEvents(events);
    }
    return false;
  }

  // Get any previously queued events
  const queuedEvents = await getQueuedEvents();
  const allEvents = [...queuedEvents, ...events];

  if (allEvents.length === 0 && !isIdle) {
    log('No events to send, skipping heartbeat');
    return true;
  }

  const heartbeat: ActivityHeartbeat = {
    heartbeatAt: getTimestamp(),
    isIdle,
    events: allEvents
  };

  try {
    log('Sending heartbeat:', heartbeat);

    const response = await fetch(`${API_BASE_URL}${API_ACTIVITY_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(heartbeat)
    });

    if (response.status === 401) {
      // Token might be expired, try to refresh
      log('Received 401, attempting token refresh');
      const refreshed = await authManager.forceRefresh();

      if (refreshed) {
        // Retry with new token
        const newToken = authManager.getAccessToken();
        if (newToken) {
          const retryResponse = await fetch(`${API_BASE_URL}${API_ACTIVITY_ENDPOINT}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${newToken}`
            },
            body: JSON.stringify(heartbeat)
          });

          if (retryResponse.ok) {
            if (queuedEvents.length > 0) {
              await clearQueuedEvents();
            }
            log('Heartbeat sent successfully after token refresh');
            return true;
          }
        }
      }

      // If refresh failed or retry failed, queue events
      if (events.length > 0) {
        await addQueuedEvents(events);
      }
      return false;
    }

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    // Success - clear the queue if we had queued events
    if (queuedEvents.length > 0) {
      await clearQueuedEvents();
      log('Cleared queued events after successful send');
    }

    log('Heartbeat sent successfully');
    return true;
  } catch (error) {
    logError('Failed to send heartbeat:', error);

    // Queue the new events for retry (don't re-add already queued events)
    if (events.length > 0) {
      await addQueuedEvents(events);
    }

    return false;
  }
}

/**
 * Check if API is reachable
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${API_BASE_URL}${API_ACTIVITY_ENDPOINT}`, {
      method: 'HEAD',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response.ok || response.status === 405; // 405 = Method Not Allowed is OK for HEAD
  } catch {
    return false;
  }
}
