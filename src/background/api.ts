import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { ActivityEvent, ActivityHeartbeat } from '@shared/types';
import {
  API_BASE_URL,
  API_ACTIVITY_ENDPOINT,
  API_LOGIN_ENDPOINT,
  API_REFRESH_ENDPOINT,
  API_LOGOUT_ENDPOINT,
  log,
  logError
} from '@shared/config';
import { getTimestamp } from '@shared/utils';
import { addQueuedEvents, getQueuedEvents, clearQueuedEvents } from './storage';
import { authManager } from './auth';

// Create axios instance
export const API = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 10000,
});

// Queue for failed requests during token refresh
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
}

// Request interceptor to add Bearer token
API.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // Don't add token to auth endpoints
    const isAuthEndpoint = config.url &&
      (config.url.includes(API_LOGIN_ENDPOINT) ||
       config.url.includes(API_REFRESH_ENDPOINT));

    if (!isAuthEndpoint) {
      const accessToken = authManager.getAccessToken();
      if (accessToken) {
        config.headers.Authorization = `Bearer ${accessToken}`;
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle token refresh
API.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Don't retry auth endpoints to avoid infinite loops
    const isAuthEndpoint = originalRequest?.url &&
      (originalRequest.url.includes(API_LOGIN_ENDPOINT) ||
       originalRequest.url.includes(API_REFRESH_ENDPOINT) ||
       originalRequest.url.includes(API_LOGOUT_ENDPOINT));

    // Handle 401 Unauthorized (but skip auth endpoints)
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint) {
      if (isRefreshing) {
        // If already refreshing, queue this request
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then(() => {
            return API(originalRequest);
          })
          .catch((err) => {
            return Promise.reject(err);
          });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        log('Received 401, attempting token refresh');
        const refreshed = await authManager.forceRefresh();

        if (refreshed) {
          const newToken = authManager.getAccessToken();
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            processQueue(null, newToken);
            log('Token refreshed successfully, retrying request');
            return API(originalRequest);
          }
        }

        // If refresh failed, clear queue and reject
        processQueue(new Error('Token refresh failed'), null);
        return Promise.reject(error);
      } catch (refreshError) {
        processQueue(refreshError, null);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

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

    await API.post(API_ACTIVITY_ENDPOINT, heartbeat);

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
    await API.head(API_ACTIVITY_ENDPOINT, {
      timeout: 5000,
    });
    return true;
  } catch (error) {
    // 405 Method Not Allowed is OK for HEAD requests
    if (axios.isAxiosError(error) && error.response?.status === 405) {
      return true;
    }
    return false;
  }
}
