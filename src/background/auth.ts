import browser from 'webextension-polyfill';
import type {AuthTokens, AuthState, LoginCredentials, LoginResponse, RefreshResponse} from '@shared/types';
import {
	API_LOGIN_ENDPOINT,
	API_REFRESH_ENDPOINT,
	API_LOGOUT_ENDPOINT,
	TOKEN_REFRESH_BUFFER_MS,
	log,
	logError
} from '@shared/config';
import {API} from './api';

const AUTH_STORAGE_KEY = 'auth';

class AuthManager {
	private tokens: AuthTokens | null = null;
	private userEmail: string | null = null;
	private refreshTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private onAuthChangeCallbacks: Array<(state: AuthState) => void> = [];

	async initialize(): Promise<void> {
		log('Initializing AuthManager');
		await this.loadStoredAuth();

		if (this.tokens) {
			this.scheduleTokenRefresh();
		}
	}

	private async loadStoredAuth(): Promise<void> {
		try {
			const result = await browser.storage.local.get(AUTH_STORAGE_KEY);
			const stored = result[AUTH_STORAGE_KEY] as { tokens: AuthTokens; userEmail: string } | undefined;

			if (stored?.tokens) {
				// Check if tokens are still valid
				if (stored.tokens.expiresAt > Date.now()) {
					this.tokens = stored.tokens;
					this.userEmail = stored.userEmail;
					log('Loaded stored auth for:', this.userEmail);
				} else {
					// Try to refresh the token
					log('Stored token expired, attempting refresh');
					const refreshed = await this.refreshToken(stored.tokens.refreshToken);
					if (refreshed) {
						this.userEmail = stored.userEmail;
					} else {
						await this.clearStoredAuth();
					}
				}
			}
		} catch (error) {
			logError('Error loading stored auth:', error);
		}
	}

	private async saveAuth(): Promise<void> {
		try {
			if (this.tokens && this.userEmail) {
				await browser.storage.local.set({
					[AUTH_STORAGE_KEY]: {
						tokens: this.tokens,
						userEmail: this.userEmail
					}
				});
			}
		} catch (error) {
			logError('Error saving auth:', error);
		}
	}

	private async clearStoredAuth(): Promise<void> {
		try {
			await browser.storage.local.remove(AUTH_STORAGE_KEY);
		} catch (error) {
			logError('Error clearing stored auth:', error);
		}
	}

	async login(credentials: LoginCredentials): Promise<{ success: boolean; error?: string }> {
		log('Attempting login for:', credentials.email);

		try {
			const response = await API.post<LoginResponse>(API_LOGIN_ENDPOINT, credentials);

			this.tokens = {
				accessToken: response.data.accessToken,
				refreshToken: response.data.refreshToken,
				expiresAt: Date.now() + (15 * 60 * 1000)
			};
			this.userEmail = credentials.email;

			await this.saveAuth();
			this.scheduleTokenRefresh();
			this.notifyAuthChange();

			log('Login successful for:', credentials.email);
			return {success: true};
		} catch (error: any) {
			const errorMessage = error.response?.data?.message || `Login failed: ${error.response?.status || 'Network error'}`;
			logError('Login error:', errorMessage);
			return {success: false, error: errorMessage};
		}
	}

	async logout(): Promise<void> {
		log('Logging out');

		// Cancel scheduled refresh
		if (this.refreshTimeoutId) {
			clearTimeout(this.refreshTimeoutId);
			this.refreshTimeoutId = null;
		}

		// Notify server (best effort)
		if (this.tokens) {
			try {
				await API.post(API_LOGOUT_ENDPOINT, {refreshToken: this.tokens.refreshToken});
			} catch {
				// Ignore logout API errors
			}
		}

		this.tokens = null;
		this.userEmail = null;
		await this.clearStoredAuth();
		this.notifyAuthChange();

		log('Logout complete');
	}

	private async refreshToken(refreshToken?: string): Promise<boolean> {
		const tokenToUse = refreshToken || this.tokens?.refreshToken;

		if (!tokenToUse) {
			log('No refresh token available');
			return false;
		}

		log('Refreshing access token');

		try {
			const response = await API.post<RefreshResponse>(API_REFRESH_ENDPOINT, {
				refreshToken: tokenToUse
			});

			this.tokens = {
				accessToken: response.data.accessToken,
				refreshToken: tokenToUse, // Keep the same refresh token
				expiresAt: Date.now() + (response.data.expiresIn * 1000)
			};

			await this.saveAuth();
			this.scheduleTokenRefresh();

			log('Token refreshed successfully');
			return true;
		} catch (error: any) {
			logError('Token refresh error:', error.response?.status || error.message);
			// If refresh fails, logout
			if (!refreshToken) {
				await this.logout();
			}
			return false;
		}
	}

	private scheduleTokenRefresh(): void {
		if (this.refreshTimeoutId) {
			clearTimeout(this.refreshTimeoutId);
		}

		if (!this.tokens) return;

		const timeUntilExpiry = this.tokens.expiresAt - Date.now();
		const refreshIn = Math.max(0, timeUntilExpiry - TOKEN_REFRESH_BUFFER_MS);

		log('Scheduling token refresh in', Math.round(refreshIn / 1000), 'seconds');

		this.refreshTimeoutId = setTimeout(() => {
			this.refreshToken();
		}, refreshIn);
	}

	getAccessToken(): string | null {
		if (!this.tokens) return null;

		// Check if token is expired
		if (this.tokens.expiresAt <= Date.now()) {
			log('Access token expired');
			return null;
		}

		return this.tokens.accessToken;
	}

	isAuthenticated(): boolean {
		return this.tokens !== null && this.tokens.expiresAt > Date.now();
	}

	getAuthState(): AuthState {
		return {
			isAuthenticated: this.isAuthenticated(),
			userEmail: this.userEmail || undefined,
			tokens: this.tokens || undefined
		};
	}

	onAuthChange(callback: (state: AuthState) => void): void {
		this.onAuthChangeCallbacks.push(callback);
	}

	private notifyAuthChange(): void {
		const state = this.getAuthState();
		for (const callback of this.onAuthChangeCallbacks) {
			try {
				callback(state);
			} catch (error) {
				logError('Error in auth change callback:', error);
			}
		}

		// Also broadcast to extension pages
		browser.runtime.sendMessage({
			type: 'AUTH_STATE_CHANGED',
			payload: state
		}).catch(() => {
			// Ignore errors when no listeners
		});
	}

	// Force refresh (for manual retry)
	async forceRefresh(): Promise<boolean> {
		return this.refreshToken();
	}
}

export const authManager = new AuthManager();
