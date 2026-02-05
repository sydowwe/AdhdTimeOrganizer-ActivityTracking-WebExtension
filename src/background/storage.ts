import browser from 'webextension-polyfill';
import type { UserSettings, DailyStats, ActivityEvent, DomainStat, ActivityWindow } from '@shared/types';
import { log } from '@shared/config';
import { getTodayDateString } from '@shared/utils';

const DEFAULT_SETTINGS: UserSettings = {
  blocklist: [],
  trackFullUrlDomains: []
};

function createEmptyDailyStats(): DailyStats {
  return {
    date: getTodayDateString(),
    totalActiveTime: 0,
    totalBackgroundTime: 0,
    domainStats: {}
  };
}

// Settings (synced across devices)
export async function getSettings(): Promise<UserSettings> {
  try {
    const result = await browser.storage.sync.get('settings');
    return result.settings || DEFAULT_SETTINGS;
  } catch (error) {
    log('Error getting settings:', error);
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  try {
    await browser.storage.sync.set({ settings });
    log('Settings saved:', settings);
  } catch (error) {
    log('Error saving settings:', error);
    throw error;
  }
}

// Daily stats (local storage)
export async function getDailyStats(): Promise<DailyStats> {
  try {
    const today = getTodayDateString();
    const result = await browser.storage.local.get('dailyStats');
    const stats = result.dailyStats as DailyStats | undefined;

    // Reset stats if it's a new day
    if (!stats || stats.date !== today) {
      const newStats = createEmptyDailyStats();
      await saveDailyStats(newStats);
      return newStats;
    }

    return stats;
  } catch (error) {
    log('Error getting daily stats:', error);
    return createEmptyDailyStats();
  }
}

export async function saveDailyStats(stats: DailyStats): Promise<void> {
  try {
    await browser.storage.local.set({ dailyStats: stats });
  } catch (error) {
    log('Error saving daily stats:', error);
  }
}

export async function updateDomainTime(
  domain: string,
  duration: number,
  isBackground: boolean
): Promise<void> {
  const stats = await getDailyStats();

  if (!stats.domainStats[domain]) {
    stats.domainStats[domain] = {
      domain,
      activeTime: 0,
      backgroundTime: 0,
      visits: 0
    };
  }

  const domainStat = stats.domainStats[domain];
  if (isBackground) {
    domainStat.backgroundTime += duration;
    stats.totalBackgroundTime += duration;
  } else {
    domainStat.activeTime += duration;
    stats.totalActiveTime += duration;
  }
  domainStat.visits += 1;

  await saveDailyStats(stats);
}

// Event queue (for failed API calls)
export async function getQueuedEvents(): Promise<ActivityEvent[]> {
  try {
    const result = await browser.storage.local.get('queuedEvents');
    return result.queuedEvents || [];
  } catch (error) {
    log('Error getting queued events:', error);
    return [];
  }
}

export async function addQueuedEvents(events: ActivityEvent[]): Promise<void> {
  try {
    const existing = await getQueuedEvents();
    const combined = [...existing, ...events];
    await browser.storage.local.set({ queuedEvents: combined });
    log('Added events to queue, total:', combined.length);
  } catch (error) {
    log('Error adding queued events:', error);
  }
}

export async function clearQueuedEvents(): Promise<void> {
  try {
    await browser.storage.local.set({ queuedEvents: [] });
    log('Cleared event queue');
  } catch (error) {
    log('Error clearing queued events:', error);
  }
}

// Tracker state persistence
export interface PersistedTrackerState {
  isPaused: boolean;
  sessionStartTime: number;
}

export async function getTrackerState(): Promise<PersistedTrackerState> {
  try {
    const result = await browser.storage.local.get('trackerState');
    return result.trackerState || {
      isPaused: false,
      sessionStartTime: Date.now()
    };
  } catch (error) {
    log('Error getting tracker state:', error);
    return {
      isPaused: false,
      sessionStartTime: Date.now()
    };
  }
}

export async function saveTrackerState(state: PersistedTrackerState): Promise<void> {
  try {
    await browser.storage.local.set({ trackerState: state });
  } catch (error) {
    log('Error saving tracker state:', error);
  }
}

// Get top domains by time spent
export async function getTopDomains(limit: number = 5): Promise<DomainStat[]> {
  const stats = await getDailyStats();
  const domains = Object.values(stats.domainStats);

  return domains
    .sort((a, b) => (b.activeTime + b.backgroundTime) - (a.activeTime + a.backgroundTime))
    .slice(0, limit);
}

// Update daily stats from activity window
export async function updateStatsFromWindow(window: ActivityWindow): Promise<void> {
  const stats = await getDailyStats();

  for (const activity of window.activities) {
    const domain = activity.domain;

    if (!stats.domainStats[domain]) {
      stats.domainStats[domain] = {
        domain,
        activeTime: 0,
        backgroundTime: 0,
        visits: 0
      };
    }

    const domainStat = stats.domainStats[domain];
    const activeMs = activity.activeSeconds * 1000;
    const backgroundMs = activity.backgroundSeconds * 1000;

    domainStat.activeTime += activeMs;
    domainStat.backgroundTime += backgroundMs;
    stats.totalActiveTime += activeMs;
    stats.totalBackgroundTime += backgroundMs;

    // Increment visits (one per activity in window)
    domainStat.visits += 1;
  }

  await saveDailyStats(stats);
  log('Updated daily stats from window');
}
