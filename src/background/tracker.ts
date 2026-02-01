import browser from 'webextension-polyfill';
import type { ActivityEvent, TabState, UserSettings, StatsResponse } from '@shared/types';
import {
  DEBOUNCE_THRESHOLD_MS,
  IDLE_THRESHOLD_SECONDS,
  log
} from '@shared/config';
import {
  extractDomain,
  isDomainBlocked,
  shouldTrackFullUrl,
  getTimestamp,
  isTrackableUrl
} from '@shared/utils';
import {
  getSettings,
  getDailyStats,
  updateDomainTime,
  getTrackerState,
  saveTrackerState
} from './storage';

interface PendingTabState {
  tabId: number;
  domain: string;
  url: string;
  isBackground: boolean;
  scheduledTime: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

class ActivityTracker {
  private activeTab: TabState | null = null;
  private backgroundTabs: Map<number, TabState> = new Map();
  private visibleTabs: Set<number> = new Set();
  private audibleTabs: Set<number> = new Set();
  private pendingEvents: ActivityEvent[] = [];
  private isIdle: boolean = false;
  private isPaused: boolean = false;
  private sessionStartTime: number = Date.now();
  private settings: UserSettings = { blocklist: [], trackFullUrlDomains: [] };
  private pendingStarts: Map<number, PendingTabState> = new Map();

  async initialize(): Promise<void> {
    log('Initializing ActivityTracker');

    // Load settings
    this.settings = await getSettings();

    // Load persisted state
    const state = await getTrackerState();
    this.isPaused = state.isPaused;
    this.sessionStartTime = state.sessionStartTime;

    // Set up event listeners
    this.setupEventListeners();

    // Initialize with current tab state
    await this.initializeCurrentState();

    log('ActivityTracker initialized', {
      isPaused: this.isPaused,
      sessionStartTime: this.sessionStartTime
    });
  }

  private setupEventListeners(): void {
    // Tab activation
    browser.tabs.onActivated.addListener(async (activeInfo) => {
      log('Tab activated:', activeInfo);
      await this.handleTabActivated(activeInfo.tabId, activeInfo.windowId);
    });

    // Window focus change
    browser.windows.onFocusChanged.addListener(async (windowId) => {
      log('Window focus changed:', windowId);
      await this.handleWindowFocusChanged(windowId);
    });

    // Tab updated (URL change, audible state change)
    browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.url) {
        log('Tab URL changed:', tabId, changeInfo.url);
        await this.handleTabUrlChanged(tabId, changeInfo.url);
      }
      if (changeInfo.audible !== undefined) {
        log('Tab audible changed:', tabId, changeInfo.audible);
        await this.handleTabAudibleChanged(tabId, changeInfo.audible);
      }
    });

    // Tab removed
    browser.tabs.onRemoved.addListener(async (tabId) => {
      log('Tab removed:', tabId);
      await this.handleTabRemoved(tabId);
    });

    // Idle state change
    browser.idle.onStateChanged.addListener(async (newState) => {
      log('Idle state changed:', newState);
      await this.handleIdleStateChanged(newState);
    });

    // Settings change
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync' && changes.settings) {
        this.settings = changes.settings.newValue;
        log('Settings updated:', this.settings);
      }
    });

    // Listen for visibility messages from content scripts
    browser.runtime.onMessage.addListener((message, sender) => {
      if (message.type === 'VISIBILITY_CHANGED' && sender.tab?.id) {
        this.handleVisibilityChanged(sender.tab.id, message.payload.isVisible);
      }
      return undefined;
    });
  }

  private async initializeCurrentState(): Promise<void> {
    try {
      // Get all windows to find focused one
      const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
      const focusedWindow = windows.find(w => w.focused);

      if (focusedWindow && focusedWindow.id !== undefined) {
        // Get active tab in focused window
        const tabs = await browser.tabs.query({
          active: true,
          windowId: focusedWindow.id
        });

        if (tabs.length > 0 && tabs[0].id !== undefined) {
          await this.handleTabActivated(tabs[0].id, focusedWindow.id);
        }
      }

      // Get all audible tabs
      const audibleTabs = await browser.tabs.query({ audible: true });
      for (const tab of audibleTabs) {
        if (tab.id !== undefined) {
          this.audibleTabs.add(tab.id);
          // Check if this audible tab should be tracked as background
          if (this.activeTab?.tabId !== tab.id) {
            await this.maybeStartBackgroundTracking(tab.id, tab.url || '');
          }
        }
      }

      // Check initial idle state
      const idleState = await browser.idle.queryState(IDLE_THRESHOLD_SECONDS);
      if (idleState !== 'active') {
        this.isIdle = true;
      }
    } catch (error) {
      log('Error initializing current state:', error);
    }
  }

  private async handleTabActivated(tabId: number, windowId: number): Promise<void> {
    if (this.isPaused) return;

    try {
      // Check if this window is focused
      const window = await browser.windows.get(windowId);
      if (!window.focused) {
        return;
      }

      const tab = await browser.tabs.get(tabId);
      if (!tab.url || !isTrackableUrl(tab.url)) {
        // End tracking of previous active tab if any
        await this.endActiveTracking();
        return;
      }

      const domain = extractDomain(tab.url);
      if (isDomainBlocked(domain, this.settings.blocklist)) {
        await this.endActiveTracking();
        return;
      }

      // If this tab was being tracked as background, stop that
      await this.endBackgroundTracking(tabId);

      // Start tracking new active tab
      await this.startActiveTracking(tabId, tab.url, domain);
    } catch (error) {
      log('Error handling tab activated:', error);
    }
  }

  private async handleWindowFocusChanged(windowId: number): Promise<void> {
    if (this.isPaused) return;

    try {
      if (windowId === browser.windows.WINDOW_ID_NONE) {
        // Browser lost focus - move active tab to background if visible/audible
        if (this.activeTab) {
          const wasActive = this.activeTab;
          await this.endActiveTracking();

          // Check if tab should become background (visible or audible)
          const isVisible = this.visibleTabs.has(wasActive.tabId);
          const isAudible = this.audibleTabs.has(wasActive.tabId);

          if (isVisible || isAudible) {
            await this.maybeStartBackgroundTracking(wasActive.tabId, wasActive.url);
          }
        }
        return;
      }

      // Window gained focus - get active tab in that window
      const tabs = await browser.tabs.query({ active: true, windowId });
      if (tabs.length > 0 && tabs[0].id !== undefined) {
        await this.handleTabActivated(tabs[0].id, windowId);
      }
    } catch (error) {
      log('Error handling window focus changed:', error);
    }
  }

  private async handleTabUrlChanged(tabId: number, url: string): Promise<void> {
    if (this.isPaused) return;

    const domain = extractDomain(url);
    const isBlocked = isDomainBlocked(domain, this.settings.blocklist);
    const isTrackable = isTrackableUrl(url);

    // Check if this is the active tab
    if (this.activeTab?.tabId === tabId) {
      if (!isTrackable || isBlocked) {
        await this.endActiveTracking();
      } else if (this.activeTab.domain !== domain) {
        // Domain changed - end old, start new
        await this.endActiveTracking();
        await this.startActiveTracking(tabId, url, domain);
      } else {
        // Same domain, just update URL
        this.activeTab.url = url;
      }
      return;
    }

    // Check if this is a background tab
    const bgTab = this.backgroundTabs.get(tabId);
    if (bgTab) {
      if (!isTrackable || isBlocked) {
        await this.endBackgroundTracking(tabId);
      } else if (bgTab.domain !== domain) {
        await this.endBackgroundTracking(tabId);
        await this.maybeStartBackgroundTracking(tabId, url);
      } else {
        bgTab.url = url;
      }
    }
  }

  private async handleTabAudibleChanged(tabId: number, audible: boolean): Promise<void> {
    if (audible) {
      this.audibleTabs.add(tabId);
      // If not active, maybe start background tracking
      if (this.activeTab?.tabId !== tabId) {
        const tab = await browser.tabs.get(tabId);
        if (tab.url) {
          await this.maybeStartBackgroundTracking(tabId, tab.url);
        }
      }
    } else {
      this.audibleTabs.delete(tabId);
      // If not visible either, stop background tracking
      if (!this.visibleTabs.has(tabId)) {
        await this.endBackgroundTracking(tabId);
      }
    }
  }

  private handleVisibilityChanged(tabId: number, isVisible: boolean): void {
    log('Visibility changed for tab', tabId, ':', isVisible);

    if (isVisible) {
      this.visibleTabs.add(tabId);
    } else {
      this.visibleTabs.delete(tabId);
      // If not audible either and is a background tab, stop tracking
      if (!this.audibleTabs.has(tabId)) {
        this.endBackgroundTracking(tabId);
      }
    }
  }

  private async handleTabRemoved(tabId: number): Promise<void> {
    // Cancel any pending start
    const pending = this.pendingStarts.get(tabId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingStarts.delete(tabId);
    }

    // Clean up tracking
    this.visibleTabs.delete(tabId);
    this.audibleTabs.delete(tabId);

    if (this.activeTab?.tabId === tabId) {
      await this.endActiveTracking();
    }

    await this.endBackgroundTracking(tabId);
  }

  private async handleIdleStateChanged(newState: string): Promise<void> {
    const wasIdle = this.isIdle;
    this.isIdle = newState !== 'active';

    if (this.isIdle && !wasIdle) {
      log('User became idle');
      // End all tracking when idle
      await this.endActiveTracking();
      for (const tabId of this.backgroundTabs.keys()) {
        await this.endBackgroundTracking(tabId);
      }
    } else if (!this.isIdle && wasIdle) {
      log('User became active');
      // Re-initialize tracking
      await this.initializeCurrentState();
    }
  }

  private async startActiveTracking(tabId: number, url: string, domain: string): Promise<void> {
    // Cancel any pending start for this tab
    const existingPending = this.pendingStarts.get(tabId);
    if (existingPending) {
      clearTimeout(existingPending.timeoutId);
      this.pendingStarts.delete(tabId);
    }

    // End previous active tracking if any
    await this.endActiveTracking();

    // Schedule the start after debounce period
    const timeoutId = setTimeout(() => {
      this.pendingStarts.delete(tabId);
      this.confirmActiveStart(tabId, url, domain);
    }, DEBOUNCE_THRESHOLD_MS);

    this.pendingStarts.set(tabId, {
      tabId,
      domain,
      url,
      isBackground: false,
      scheduledTime: Date.now(),
      timeoutId
    });

    log('Scheduled active tracking start for', domain, 'in', DEBOUNCE_THRESHOLD_MS, 'ms');
  }

  private confirmActiveStart(tabId: number, url: string, domain: string): void {
    const now = Date.now();

    this.activeTab = {
      tabId,
      domain,
      url,
      isBackground: false,
      startTime: now,
      isTracking: true
    };

    // Create start event
    const event: ActivityEvent = {
      type: 'start',
      domain,
      isBackground: false,
      at: getTimestamp()
    };

    if (shouldTrackFullUrl(domain, this.settings)) {
      event.url = url;
    }

    this.pendingEvents.push(event);
    log('Started active tracking:', domain);
  }

  private async endActiveTracking(): Promise<void> {
    // Cancel any pending start
    if (this.activeTab) {
      const pending = this.pendingStarts.get(this.activeTab.tabId);
      if (pending && !pending.isBackground) {
        clearTimeout(pending.timeoutId);
        this.pendingStarts.delete(this.activeTab.tabId);
      }
    }

    if (!this.activeTab?.isTracking) {
      this.activeTab = null;
      return;
    }

    const tab = this.activeTab;
    const duration = Date.now() - tab.startTime;

    // Create end event
    const event: ActivityEvent = {
      type: 'end',
      domain: tab.domain,
      isBackground: false,
      at: getTimestamp()
    };

    if (shouldTrackFullUrl(tab.domain, this.settings)) {
      event.url = tab.url;
    }

    this.pendingEvents.push(event);

    // Update stats
    await updateDomainTime(tab.domain, duration, false);

    log('Ended active tracking:', tab.domain, 'duration:', duration);
    this.activeTab = null;
  }

  private async maybeStartBackgroundTracking(tabId: number, url: string): Promise<void> {
    if (this.isPaused || this.isIdle) return;
    if (this.backgroundTabs.has(tabId)) return;
    if (this.activeTab?.tabId === tabId) return;

    if (!isTrackableUrl(url)) return;

    const domain = extractDomain(url);
    if (isDomainBlocked(domain, this.settings.blocklist)) return;

    // Check if tab is visible or audible
    const isVisible = this.visibleTabs.has(tabId);
    const isAudible = this.audibleTabs.has(tabId);

    if (!isVisible && !isAudible) return;

    // Cancel any existing pending start for this tab
    const existingPending = this.pendingStarts.get(tabId);
    if (existingPending) {
      clearTimeout(existingPending.timeoutId);
      this.pendingStarts.delete(tabId);
    }

    // Schedule the start after debounce period
    const timeoutId = setTimeout(() => {
      this.pendingStarts.delete(tabId);
      this.confirmBackgroundStart(tabId, url, domain);
    }, DEBOUNCE_THRESHOLD_MS);

    this.pendingStarts.set(tabId, {
      tabId,
      domain,
      url,
      isBackground: true,
      scheduledTime: Date.now(),
      timeoutId
    });

    log('Scheduled background tracking start for', domain, 'in', DEBOUNCE_THRESHOLD_MS, 'ms');
  }

  private confirmBackgroundStart(tabId: number, url: string, domain: string): void {
    const now = Date.now();

    const tabState: TabState = {
      tabId,
      domain,
      url,
      isBackground: true,
      startTime: now,
      isTracking: true
    };

    this.backgroundTabs.set(tabId, tabState);

    // Create start event
    const event: ActivityEvent = {
      type: 'start',
      domain,
      isBackground: true,
      at: getTimestamp()
    };

    if (shouldTrackFullUrl(domain, this.settings)) {
      event.url = url;
    }

    this.pendingEvents.push(event);
    log('Started background tracking:', domain);
  }

  private async endBackgroundTracking(tabId: number): Promise<void> {
    // Cancel any pending start
    const pending = this.pendingStarts.get(tabId);
    if (pending && pending.isBackground) {
      clearTimeout(pending.timeoutId);
      this.pendingStarts.delete(tabId);
    }

    const tab = this.backgroundTabs.get(tabId);
    if (!tab?.isTracking) {
      this.backgroundTabs.delete(tabId);
      return;
    }

    const duration = Date.now() - tab.startTime;

    // Create end event
    const event: ActivityEvent = {
      type: 'end',
      domain: tab.domain,
      isBackground: true,
      at: getTimestamp()
    };

    if (shouldTrackFullUrl(tab.domain, this.settings)) {
      event.url = tab.url;
    }

    this.pendingEvents.push(event);

    // Update stats
    await updateDomainTime(tab.domain, duration, true);

    log('Ended background tracking:', tab.domain, 'duration:', duration);
    this.backgroundTabs.delete(tabId);
  }

  // Public methods
  async setPaused(paused: boolean): Promise<void> {
    if (this.isPaused === paused) return;

    this.isPaused = paused;

    if (this.isPaused) {
      // End all tracking
      await this.endActiveTracking();
      for (const tabId of this.backgroundTabs.keys()) {
        await this.endBackgroundTracking(tabId);
      }
      // Clear pending starts
      for (const pending of this.pendingStarts.values()) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingStarts.clear();
    } else {
      // Resume tracking
      await this.initializeCurrentState();
    }

    await saveTrackerState({
      isPaused: this.isPaused,
      sessionStartTime: this.sessionStartTime
    });

    log('Tracking', this.isPaused ? 'paused' : 'resumed');
  }

  async togglePause(): Promise<boolean> {
    await this.setPaused(!this.isPaused);
    return this.isPaused;
  }

  getPendingEvents(): ActivityEvent[] {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  getIsIdle(): boolean {
    return this.isIdle;
  }

  async getStatsResponse(): Promise<StatsResponse> {
    const todayStats = await getDailyStats();

    let status: 'tracking' | 'paused' | 'idle' = 'tracking';
    if (this.isPaused) status = 'paused';
    else if (this.isIdle) status = 'idle';

    let currentSiteTime = 0;
    if (this.activeTab?.isTracking) {
      currentSiteTime = Date.now() - this.activeTab.startTime;
    }

    return {
      todayStats,
      currentSession: {
        activeTab: this.activeTab,
        sessionStartTime: this.sessionStartTime,
        currentSiteTime
      },
      status
    };
  }

  updateSettings(newSettings: UserSettings): void {
    this.settings = newSettings;
  }
}

// Export singleton instance
export const tracker = new ActivityTracker();
