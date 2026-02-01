import browser from 'webextension-polyfill';
import type { StatsResponse, DomainStat, AuthState } from '@shared/types';
import { formatDuration } from '@shared/utils';

// DOM Elements - Header
const statusIndicator = document.getElementById('status-indicator') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;

// DOM Elements - Login View
const loginView = document.getElementById('login-view') as HTMLElement;
const loginForm = document.getElementById('login-form') as HTMLFormElement;
const emailInput = document.getElementById('email') as HTMLInputElement;
const passwordInput = document.getElementById('password') as HTMLInputElement;
const loginError = document.getElementById('login-error') as HTMLElement;
const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;

// DOM Elements - Main View
const mainView = document.getElementById('main-view') as HTMLElement;
const currentDomain = document.getElementById('current-domain') as HTMLElement;
const currentTime = document.getElementById('current-time') as HTMLElement;
const sessionStart = document.getElementById('session-start') as HTMLElement;
const activeTime = document.getElementById('active-time') as HTMLElement;
const backgroundTime = document.getElementById('background-time') as HTMLElement;
const domainList = document.getElementById('domain-list') as HTMLElement;
const toggleBtn = document.getElementById('toggle-btn') as HTMLButtonElement;
const toggleIcon = document.getElementById('toggle-icon') as HTMLElement;
const toggleText = document.getElementById('toggle-text') as HTMLElement;
const optionsBtn = document.getElementById('options-btn') as HTMLButtonElement;
const userEmail = document.getElementById('user-email') as HTMLElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;

let updateInterval: ReturnType<typeof setInterval> | null = null;
let isLoggingIn = false;

async function getAuthState(): Promise<AuthState | null> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_AUTH_STATE' });
    return response as AuthState;
  } catch (error) {
    console.error('Failed to get auth state:', error);
    return null;
  }
}

async function fetchStats(): Promise<StatsResponse | null> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_STATS' });
    return response as StatsResponse;
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    return null;
  }
}

function showLoginView(): void {
  loginView.classList.remove('hidden');
  mainView.classList.add('hidden');
  statusIndicator.className = 'status-indicator unauthenticated';
  statusText.textContent = 'Not signed in';
}

function showMainView(authState: AuthState): void {
  loginView.classList.add('hidden');
  mainView.classList.remove('hidden');
  userEmail.textContent = authState.userEmail || '';
}

function updateStatsUI(stats: StatsResponse): void {
  // Update status
  statusIndicator.className = 'status-indicator ' + stats.status;

  const statusLabels: Record<string, string> = {
    tracking: 'Tracking',
    paused: 'Paused',
    idle: 'Idle',
    unauthenticated: 'Not signed in'
  };
  statusText.textContent = statusLabels[stats.status] || stats.status;

  // Update current session
  if (stats.currentSession.activeTab) {
    currentDomain.textContent = stats.currentSession.activeTab.domain;
    currentTime.textContent = formatDuration(stats.currentSession.currentSiteTime);
  } else {
    currentDomain.textContent = '-';
    currentTime.textContent = '-';
  }

  const sessionDate = new Date(stats.currentSession.sessionStartTime);
  sessionStart.textContent = sessionDate.toLocaleTimeString();

  // Update today's stats
  activeTime.textContent = formatDuration(stats.todayStats.totalActiveTime);
  backgroundTime.textContent = formatDuration(stats.todayStats.totalBackgroundTime);

  // Update top domains
  updateDomainList(stats.todayStats.domainStats);

  // Update toggle button
  if (stats.status === 'paused') {
    toggleBtn.classList.add('paused');
    toggleIcon.textContent = '▶';
    toggleText.textContent = 'Resume';
  } else {
    toggleBtn.classList.remove('paused');
    toggleIcon.textContent = '⏸';
    toggleText.textContent = 'Pause';
  }
}

function updateDomainList(domainStats: Record<string, DomainStat>): void {
  const domains = Object.values(domainStats);

  if (domains.length === 0) {
    domainList.innerHTML = '<li class="empty-state">No activity recorded yet</li>';
    return;
  }

  // Sort by total time and take top 5
  const topDomains = domains
    .sort((a, b) => (b.activeTime + b.backgroundTime) - (a.activeTime + a.backgroundTime))
    .slice(0, 5);

  domainList.innerHTML = topDomains
    .map(function(domain) {
      const totalTime = domain.activeTime + domain.backgroundTime;
      return `
        <li>
          <span class="domain-name">${escapeHtml(domain.domain)}</span>
          <span class="domain-time">${formatDuration(totalTime)}</span>
        </li>
      `;
    })
    .join('');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function handleLogin(event: Event): Promise<void> {
  event.preventDefault();

  if (isLoggingIn) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showLoginError('Please enter both email and password');
    return;
  }

  isLoggingIn = true;
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner"></span> Signing in...';
  hideLoginError();

  try {
    const response = await browser.runtime.sendMessage({
      type: 'LOGIN',
      payload: { email, password }
    }) as { success: boolean; error?: string };

    if (response.success) {
      // Clear form
      emailInput.value = '';
      passwordInput.value = '';

      // Get updated auth state and show main view
      const authState = await getAuthState();
      if (authState?.isAuthenticated) {
        showMainView(authState);
        startStatsUpdates();
      }
    } else {
      showLoginError(response.error || 'Login failed');
    }
  } catch (error) {
    console.error('Login error:', error);
    showLoginError('An error occurred. Please try again.');
  } finally {
    isLoggingIn = false;
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
}

function showLoginError(message: string): void {
  loginError.textContent = message;
  loginError.classList.remove('hidden');
}

function hideLoginError(): void {
  loginError.classList.add('hidden');
}

async function handleLogout(): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'LOGOUT' });
    stopStatsUpdates();
    showLoginView();
  } catch (error) {
    console.error('Logout error:', error);
  }
}

async function togglePause(): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'TOGGLE_PAUSE' });
    // Refresh stats
    const stats = await fetchStats();
    if (stats) {
      updateStatsUI(stats);
    }
  } catch (error) {
    console.error('Failed to toggle pause:', error);
  }
}

function openOptions(): void {
  browser.runtime.openOptionsPage();
}

function startStatsUpdates(): void {
  // Fetch immediately
  fetchStats().then(function(stats) {
    if (stats) {
      updateStatsUI(stats);
    }
  });

  // Update stats every second for live time updates
  updateInterval = setInterval(async function() {
    const stats = await fetchStats();
    if (stats) {
      if (stats.status === 'unauthenticated') {
        stopStatsUpdates();
        showLoginView();
      } else {
        updateStatsUI(stats);
      }
    }
  }, 1000);
}

function stopStatsUpdates(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}

async function initialize(): Promise<void> {
  // Check auth state
  const authState = await getAuthState();

  if (authState?.isAuthenticated) {
    showMainView(authState);
    startStatsUpdates();
  } else {
    showLoginView();
  }

  // Set up event listeners
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  toggleBtn.addEventListener('click', togglePause);
  optionsBtn.addEventListener('click', openOptions);

  // Listen for auth state changes
  browser.runtime.onMessage.addListener(function(message) {
    if (message.type === 'AUTH_STATE_CHANGED') {
      const state = message.payload as AuthState;
      if (state.isAuthenticated) {
        showMainView(state);
        startStatsUpdates();
      } else {
        stopStatsUpdates();
        showLoginView();
      }
    }
  });
}

// Clean up interval when popup closes
window.addEventListener('unload', function() {
  stopStatsUpdates();
});

// Initialize on load
document.addEventListener('DOMContentLoaded', initialize);
