import type { UserSettings } from './types';

/**
 * Extract domain from a URL string, stripping www. prefix
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;

    // Strip www. prefix
    if (hostname.startsWith('www.')) {
      hostname = hostname.substring(4);
    }

    return hostname;
  } catch {
    return '';
  }
}

/**
 * Check if a domain is in the blocklist
 */
export function isDomainBlocked(domain: string, blocklist: string[]): boolean {
  return blocklist.some(blocked => {
    // Exact match or subdomain match
    return domain === blocked || domain.endsWith('.' + blocked);
  });
}

/**
 * Determine if full URL should be tracked for a domain
 */
export function shouldTrackFullUrl(domain: string, settings: UserSettings): boolean {
  return settings.trackFullUrlDomains.some(trackDomain => {
    return domain === trackDomain || domain.endsWith('.' + trackDomain);
  });
}

/**
 * Get current ISO 8601 timestamp
 */
export function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Get today's date string in YYYY-MM-DD format
 */
export function getTodayDateString(): string {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Format milliseconds to human-readable time string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Check if a URL is trackable (not internal browser pages)
 */
export function isTrackableUrl(url: string): boolean {
  if (!url) return false;

  const nonTrackablePrefixes = [
    'chrome://',
    'chrome-extension://',
    'moz-extension://',
    'edge://',
    'about:',
    'file://',
    'data:',
    'javascript:',
    'blob:'
  ];

  return !nonTrackablePrefixes.some(prefix => url.startsWith(prefix));
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function debounced(...args: Parameters<T>): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Create a cancellable debounce that can emit immediately on cancel
 */
export interface CancellableDebounce<T extends (...args: unknown[]) => void> {
  schedule: (...args: Parameters<T>) => void;
  cancel: () => void;
  flush: () => void;
}

export function createCancellableDebounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): CancellableDebounce<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Parameters<T> | null = null;

  return {
    schedule(...args: Parameters<T>): void {
      pendingArgs = args;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        if (pendingArgs) {
          fn(...pendingArgs);
          pendingArgs = null;
        }
        timeoutId = null;
      }, delay);
    },
    cancel(): void {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      pendingArgs = null;
    },
    flush(): void {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (pendingArgs) {
        fn(...pendingArgs);
        pendingArgs = null;
      }
    }
  };
}
