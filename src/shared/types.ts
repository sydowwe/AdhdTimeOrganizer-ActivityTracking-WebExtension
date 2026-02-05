// Activity event types
export interface ActivityEvent {
  type: 'start' | 'end';
  domain: string;
  url?: string;
  isBackground: boolean;
  at: string; // ISO 8601 timestamp
}

// Window aggregation for 5-minute intervals
export interface ActivityWindow {
  windowStart: string; // ISO 8601 timestamp, rounded to 5-min boundary
  windowMinutes: number; // Always 5
  isFinal: boolean; // True if window is complete and won't be updated
  activities: WindowActivity[];
}

export interface WindowActivity {
  domain: string;
  url?: string; // Most visited URL for this domain in the window
  activeSeconds: number;
  backgroundSeconds: number;
}

export interface ActivityHeartbeat {
  heartbeatAt: string; // ISO 8601 timestamp
  isIdle: boolean;
  window?: ActivityWindow; // Current or completed window
}

// Tab tracking state
export interface TabState {
  tabId: number;
  domain: string;
  url: string;
  isBackground: boolean;
  startTime: number;
  isTracking: boolean;
}

export interface TrackerState {
  activeTab: TabState | null;
  backgroundTabs: Map<number, TabState>;
  isIdle: boolean;
  isPaused: boolean;
  pendingEvents: ActivityEvent[];
  sessionStartTime: number;
}

// Auth types
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds until access token expires
}

export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

export interface AuthState {
  isAuthenticated: boolean;
  userEmail?: string;
  tokens?: AuthTokens;
}

// Storage types
export interface UserSettings {
  blocklist: string[];
  trackFullUrlDomains: string[];
}

export interface DailyStats {
  date: string; // YYYY-MM-DD
  totalActiveTime: number; // milliseconds
  totalBackgroundTime: number; // milliseconds
  domainStats: Record<string, DomainStat>;
}

export interface DomainStat {
  domain: string;
  activeTime: number;
  backgroundTime: number;
  visits: number;
}

export interface StoredData {
  settings: UserSettings;
  dailyStats: DailyStats;
  queuedEvents: ActivityEvent[];
  trackerState: {
    isPaused: boolean;
    sessionStartTime: number;
  };
  auth: AuthState;
}

// Messages between background and content scripts
export type MessageType =
  | 'VISIBILITY_CHANGED'
  | 'VIDEO_PLAYING_CHANGED'
  | 'GET_VISIBILITY'
  | 'GET_STATS'
  | 'GET_CURRENT_STATE'
  | 'TOGGLE_PAUSE'
  | 'UPDATE_SETTINGS'
  | 'LOGIN'
  | 'LOGOUT'
  | 'GET_AUTH_STATE'
  | 'AUTH_STATE_CHANGED';

export interface Message {
  type: MessageType;
  payload?: unknown;
}

export interface VisibilityMessage extends Message {
  type: 'VISIBILITY_CHANGED';
  payload: {
    isVisible: boolean;
  };
}

export interface VideoPlayingMessage extends Message {
  type: 'VIDEO_PLAYING_CHANGED';
  payload: {
    hasPlayingVideo: boolean;
  };
}

export interface LoginMessage extends Message {
  type: 'LOGIN';
  payload: LoginCredentials;
}

export interface StatsResponse {
  todayStats: DailyStats;
  currentSession: {
    activeTab: TabState | null;
    sessionStartTime: number;
    currentSiteTime: number;
    isPending: boolean; // True if tab is in debounce period (< 5 seconds)
    pendingDomain?: string; // Domain of pending tab
  };
  currentWindow?: ActivityWindow; // Current 5-minute aggregation window
  status: 'tracking' | 'paused' | 'idle' | 'unauthenticated';
}
