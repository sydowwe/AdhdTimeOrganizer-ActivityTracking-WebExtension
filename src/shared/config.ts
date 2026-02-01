// API Configuration - Set these values for your backend
export const API_BASE_URL = 'https://api.example.com';
export const API_ACTIVITY_ENDPOINT = '/activity-tracking/heartbeat';
export const API_LOGIN_ENDPOINT = '/auth/extension/login';
export const API_REFRESH_ENDPOINT = '/auth/extension/refresh';
export const API_LOGOUT_ENDPOINT = '/auth/extension/logout';

// Tracking Configuration
export const DEBOUNCE_THRESHOLD_MS = 5000; // 5 seconds - ignore visits shorter than this
export const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
export const IDLE_THRESHOLD_SECONDS = 180; // 3 minutes

// Auth Configuration
export const TOKEN_REFRESH_BUFFER_MS = 60000; // Refresh token 1 minute before expiry

// Debug Configuration
export const DEBUG_LOGGING = true;

export function log(...args: unknown[]): void {
  if (DEBUG_LOGGING) {
    console.log('[TimeOrganizer]', new Date().toISOString(), ...args);
  }
}

export function logError(...args: unknown[]): void {
  console.error('[TimeOrganizer ERROR]', new Date().toISOString(), ...args);
}
