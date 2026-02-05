import browser from 'webextension-polyfill';
import type { TabState, UserSettings, StatsResponse, ActivityWindow, WindowActivity } from '@shared/types';
import {
  DEBOUNCE_THRESHOLD_MS,
  IDLE_THRESHOLD_SECONDS,
  log
} from '@shared/config';
import {
  extractDomain,
  isDomainBlocked,
  shouldTrackFullUrl,
  isTrackableUrl
} from '@shared/utils';
import {
  getSettings,
  getDailyStats,
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

interface DomainBuffer {
  activeSeconds: number;
  backgroundSeconds: number;
  urlVisits: Map<string, number>; // URL -> seconds spent
}

interface ActivityBuffer {
  windowStart: number; // Unix timestamp in ms, rounded to 5-min boundary
  domains: Map<string, DomainBuffer>;
}

const WINDOW_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const TICK_INTERVAL_MS = 1000; // Check every second

class ActivityTracker {
  private activeTab: TabState | null = null;
  private backgroundTabs: Map<number, TabState> = new Map();
  private visibleTabs: Set<number> = new Set();
  private audibleTabs: Set<number> = new Set();
  private videoPlayingTabs: Set<number> = new Set();
  private isIdle: boolean = false;
  private isPaused: boolean = false;
  private sessionStartTime: number = Date.now();
  private settings: UserSettings = { blocklist: [], trackFullUrlDomains: [] };
  private pendingStarts: Map<number, PendingTabState> = new Map();

  // Window aggregation
  private activityBuffer: ActivityBuffer | null = null;
  private lastTickAt: number = Date.now();
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  async initialize(): Promise<void> {
    log('Initializing ActivityTracker');

    // Load settings
    this.settings = await getSettings();

    // Load persisted state
    const state = await getTrackerState();
    this.isPaused = state.isPaused;
    this.sessionStartTime = state.sessionStartTime;

    // Save state to ensure sessionStartTime persists across restarts
    await saveTrackerState({
      isPaused: this.isPaused,
      sessionStartTime: this.sessionStartTime
    });

    // Load or create activity buffer
    await this.loadOrCreateBuffer();

    // Set up event listeners
    this.setupEventListeners();

    // Initialize with current tab state
    await this.initializeCurrentState();

    // Start ticker for window aggregation
    this.startTicker();

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

    // Listen for visibility and video messages from content scripts
    browser.runtime.onMessage.addListener((message, sender) => {
      if (message.type === 'VISIBILITY_CHANGED' && sender.tab?.id) {
        this.handleVisibilityChanged(sender.tab.id, message.payload.isVisible);
      }
      if (message.type === 'VIDEO_PLAYING_CHANGED' && sender.tab?.id) {
        this.handleVideoPlayingChanged(sender.tab.id, message.payload.hasPlayingVideo);
      }
      return undefined;
    });
  }

  private async initializeCurrentState(): Promise<void> {
    try {
      // Get all windows to find focused one or most recently active one
      const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
      let targetWindow = windows.find(w => w.focused);

      // If no normal window is focused (e.g., popup is open), use any normal window
      // This handles the case where popup is open during initialization
      if (!targetWindow && windows.length > 0) {
        targetWindow = windows[0];
      }

      if (targetWindow && targetWindow.id !== undefined) {
        // Get active tab in target window
        const tabs = await browser.tabs.query({
          active: true,
          windowId: targetWindow.id
        });

        if (tabs.length > 0 && tabs[0].id !== undefined) {
          await this.handleTabActivated(tabs[0].id, targetWindow.id);
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
      // Check if the focused window is an extension popup
      if (windowId !== browser.windows.WINDOW_ID_NONE) {
        const window = await browser.windows.get(windowId);
        if (window.type === 'popup') {
          // This is a popup window - check if it's our extension popup
          const tabs = await browser.tabs.query({ windowId });
          if (tabs.length > 0 && tabs[0].url) {
            const extensionUrl = browser.runtime.getURL('');
            if (tabs[0].url.startsWith(extensionUrl)) {
              // This is our extension popup - ignore this focus change
              log('Extension popup focused, maintaining tracking state');
              return;
            }
          }
        }
      }

      if (windowId === browser.windows.WINDOW_ID_NONE) {
        // Check if focus moved to a popup/devtools window (extension popup, etc)
        // If so, ignore this focus change to maintain tracking
        const allWindows = await browser.windows.getAll({ populate: true });
        const hasExtensionPopupFocused = allWindows.some(w => {
          if (!w.focused || w.type !== 'popup') return false;
          // Check if any tab in this popup window is an extension page
          const extensionUrl = browser.runtime.getURL('');
          return w.tabs?.some(tab => tab.url?.startsWith(extensionUrl));
        });

        if (hasExtensionPopupFocused) {
          // Extension popup is focused - ignore this focus change
          log('Extension popup focused, maintaining tracking state');
          return;
        }

        // Browser actually lost focus - move active tab to background if visible/audible
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
      // If not visible or playing video either, stop background tracking
      if (!this.visibleTabs.has(tabId) && !this.videoPlayingTabs.has(tabId)) {
        await this.endBackgroundTracking(tabId);
      }
    }
  }

  private handleVisibilityChanged(tabId: number, isVisible: boolean): void {
    log('Visibility changed for tab', tabId, ':', isVisible);

    if (isVisible) {
      this.visibleTabs.add(tabId);
      // Maybe start background tracking if this tab should be tracked
      if (this.activeTab?.tabId !== tabId) {
        browser.tabs.get(tabId).then(tab => {
          if (tab.url) {
            this.maybeStartBackgroundTracking(tabId, tab.url);
          }
        }).catch(() => {
          // Tab may have been closed
        });
      }
    } else {
      this.visibleTabs.delete(tabId);
      // If not audible, not playing video, and is a background tab, stop tracking
      if (!this.audibleTabs.has(tabId) && !this.videoPlayingTabs.has(tabId)) {
        this.endBackgroundTracking(tabId);
      }
    }
  }

  private handleVideoPlayingChanged(tabId: number, hasPlayingVideo: boolean): void {
    log('Video playing changed for tab', tabId, ':', hasPlayingVideo);

    if (hasPlayingVideo) {
      this.videoPlayingTabs.add(tabId);
      // If not active, maybe start background tracking
      if (this.activeTab?.tabId !== tabId) {
        browser.tabs.get(tabId).then(tab => {
          if (tab.url) {
            this.maybeStartBackgroundTracking(tabId, tab.url);
          }
        }).catch(() => {
          // Tab may have been closed
        });
      }
    } else {
      this.videoPlayingTabs.delete(tabId);
      // If not visible or audible either, stop background tracking
      if (!this.visibleTabs.has(tabId) && !this.audibleTabs.has(tabId)) {
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
    this.videoPlayingTabs.delete(tabId);

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

    // Check if tab is visible, audible, or has playing video
    const isVisible = this.visibleTabs.has(tabId);
    const isAudible = this.audibleTabs.has(tabId);
    const hasPlayingVideo = this.videoPlayingTabs.has(tabId);

    if (!isVisible && !isAudible && !hasPlayingVideo) return;

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

    log('Ended background tracking:', tab.domain, 'duration:', duration);
    this.backgroundTabs.delete(tabId);
  }

  // Window aggregation methods
  private roundToWindowBoundary(timestamp: number): number {
    return Math.floor(timestamp / WINDOW_DURATION_MS) * WINDOW_DURATION_MS;
  }

  private async loadOrCreateBuffer(): Promise<void> {
    try {
      const stored = await browser.storage.local.get('activityBuffer');
      if (stored.activityBuffer) {
        const data = stored.activityBuffer;
        this.activityBuffer = {
          windowStart: data.windowStart,
          domains: new Map(Object.entries(data.domains).map(([domain, buffer]: [string, any]) => [
            domain,
            {
              activeSeconds: buffer.activeSeconds,
              backgroundSeconds: buffer.backgroundSeconds,
              urlVisits: new Map(Object.entries(buffer.urlVisits))
            }
          ]))
        };
        log('Loaded activity buffer from storage');
      } else {
        this.createNewBuffer();
      }
    } catch (error) {
      log('Error loading buffer, creating new:', error);
      this.createNewBuffer();
    }
  }

  private createNewBuffer(): void {
    const now = Date.now();
    this.activityBuffer = {
      windowStart: this.roundToWindowBoundary(now),
      domains: new Map()
    };
    log('Created new activity buffer for window:', new Date(this.activityBuffer.windowStart).toISOString());
  }

  private async persistBuffer(): Promise<void> {
    if (!this.activityBuffer) return;

    try {
      const data = {
        windowStart: this.activityBuffer.windowStart,
        domains: Object.fromEntries(
          Array.from(this.activityBuffer.domains.entries()).map(([domain, buffer]) => [
            domain,
            {
              activeSeconds: buffer.activeSeconds,
              backgroundSeconds: buffer.backgroundSeconds,
              urlVisits: Object.fromEntries(buffer.urlVisits)
            }
          ])
        )
      };
      await browser.storage.local.set({ activityBuffer: data });
    } catch (error) {
      log('Error persisting buffer:', error);
    }
  }

  private startTicker(): void {
    // Clear any existing ticker
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }

    this.lastTickAt = Date.now();

    this.tickInterval = setInterval(() => {
      this.onTick();
    }, TICK_INTERVAL_MS);

    log('Ticker started');
  }

  private stopTicker(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private onTick(): void {
    const now = Date.now();
    const elapsedSeconds = Math.floor((now - this.lastTickAt) / 1000);
    this.lastTickAt = now;

    if (elapsedSeconds <= 0 || this.isPaused || this.isIdle) {
      return;
    }

    // Check if we need to rotate to a new window
    const currentWindowStart = this.roundToWindowBoundary(now);
    if (this.activityBuffer && this.activityBuffer.windowStart !== currentWindowStart) {
      log('Window boundary crossed, creating new buffer');
      // The old buffer will be sent in the next heartbeat
      this.createNewBuffer();
    }

    if (!this.activityBuffer) {
      this.createNewBuffer();
    }

    // Accumulate time for active tab
    if (this.activeTab?.isTracking) {
      const domain = this.activeTab.domain;
      if (!this.activityBuffer!.domains.has(domain)) {
        this.activityBuffer!.domains.set(domain, {
          activeSeconds: 0,
          backgroundSeconds: 0,
          urlVisits: new Map()
        });
      }
      const buffer = this.activityBuffer!.domains.get(domain)!;
      buffer.activeSeconds += elapsedSeconds;

      // Track URL if configured
      if (shouldTrackFullUrl(domain, this.settings)) {
        const url = this.activeTab.url;
        buffer.urlVisits.set(url, (buffer.urlVisits.get(url) || 0) + elapsedSeconds);
      }
    }

    // Accumulate time for background tabs
    for (const bgTab of this.backgroundTabs.values()) {
      if (bgTab.isTracking) {
        const domain = bgTab.domain;
        if (!this.activityBuffer!.domains.has(domain)) {
          this.activityBuffer!.domains.set(domain, {
            activeSeconds: 0,
            backgroundSeconds: 0,
            urlVisits: new Map()
          });
        }
        const buffer = this.activityBuffer!.domains.get(domain)!;
        buffer.backgroundSeconds += elapsedSeconds;

        // Track URL if configured
        if (shouldTrackFullUrl(domain, this.settings)) {
          const url = bgTab.url;
          buffer.urlVisits.set(url, (buffer.urlVisits.get(url) || 0) + elapsedSeconds);
        }
      }
    }

    // Persist buffer periodically (every 10 ticks = 10 seconds)
    if (now % 10000 < TICK_INTERVAL_MS) {
      this.persistBuffer();
    }
  }

  getActivityWindow(): ActivityWindow | null {
    if (!this.activityBuffer || this.activityBuffer.domains.size === 0) {
      return null;
    }

    const now = Date.now();
    const currentWindowStart = this.roundToWindowBoundary(now);
    const isFinal = this.activityBuffer.windowStart < currentWindowStart;

    const activities: WindowActivity[] = [];
    for (const [domain, buffer] of this.activityBuffer.domains.entries()) {
      // Find most visited URL for this domain
      let mostVisitedUrl: string | undefined;
      let maxSeconds = 0;
      for (const [url, seconds] of buffer.urlVisits.entries()) {
        if (seconds > maxSeconds) {
          maxSeconds = seconds;
          mostVisitedUrl = url;
        }
      }

      const activity: WindowActivity = {
        domain,
        activeSeconds: buffer.activeSeconds,
        backgroundSeconds: buffer.backgroundSeconds
      };

      if (mostVisitedUrl && shouldTrackFullUrl(domain, this.settings)) {
        activity.url = mostVisitedUrl;
      }

      activities.push(activity);
    }

    return {
      windowStart: new Date(this.activityBuffer.windowStart).toISOString(),
      windowMinutes: 5,
      isFinal,
      activities
    };
  }

  clearCurrentBuffer(): void {
    this.createNewBuffer();
    this.persistBuffer();
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

    // Check if there's a pending active tab start (in debounce period)
    let isPending = false;
    let pendingDomain: string | undefined;

    for (const pending of this.pendingStarts.values()) {
      if (!pending.isBackground) {
        // Found a pending active tab
        isPending = true;
        pendingDomain = pending.domain;
        break;
      }
    }

    const currentWindow = this.getActivityWindow();

    return {
      todayStats,
      currentSession: {
        activeTab: this.activeTab,
        sessionStartTime: this.sessionStartTime,
        currentSiteTime,
        isPending,
        pendingDomain
      },
      currentWindow: currentWindow || undefined,
      status
    };
  }

  updateSettings(newSettings: UserSettings): void {
    this.settings = newSettings;
  }
}

// Export singleton instance
export const tracker = new ActivityTracker();
