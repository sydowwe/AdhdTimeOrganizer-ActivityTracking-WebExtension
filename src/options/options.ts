import browser from 'webextension-polyfill';
import type { UserSettings } from '@shared/types';

// DOM Elements
const blocklistInput = document.getElementById('blocklist-input') as HTMLInputElement;
const addBlocklistBtn = document.getElementById('add-blocklist') as HTMLButtonElement;
const blocklistEl = document.getElementById('blocklist') as HTMLUListElement;

const fullurlInput = document.getElementById('fullurl-input') as HTMLInputElement;
const addFullurlBtn = document.getElementById('add-fullurl') as HTMLButtonElement;
const fullurlList = document.getElementById('fullurl-list') as HTMLUListElement;

const saveStatus = document.getElementById('save-status') as HTMLElement;

let settings: UserSettings = {
  blocklist: [],
  trackFullUrlDomains: []
};

async function loadSettings(): Promise<void> {
  try {
    const result = await browser.storage.sync.get('settings');
    if (result.settings) {
      settings = result.settings;
    }
    renderLists();
  } catch (error) {
    console.error('Failed to load settings:', error);
    showStatus('Failed to load settings', true);
  }
}

async function saveSettings(): Promise<void> {
  try {
    await browser.storage.sync.set({ settings });
    // Also notify background script
    await browser.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      payload: settings
    });
    showStatus('Settings saved');
  } catch (error) {
    console.error('Failed to save settings:', error);
    showStatus('Failed to save settings', true);
  }
}

function showStatus(message: string, isError: boolean = false): void {
  saveStatus.textContent = message;
  saveStatus.className = 'save-status' + (isError ? ' error' : '');

  setTimeout(() => {
    saveStatus.textContent = '';
  }, 3000);
}

function normalizeDomain(input: string): string {
  let domain = input.trim().toLowerCase();

  // Remove protocol if present
  domain = domain.replace(/^https?:\/\//, '');

  // Remove path if present
  domain = domain.split('/')[0];

  // Remove port if present
  domain = domain.split(':')[0];

  // Remove www. prefix
  domain = domain.replace(/^www\./, '');

  return domain;
}

function isValidDomain(domain: string): boolean {
  if (!domain) return false;

  // Simple domain validation
  const domainRegex = /^[a-z0-9]+([\-.]{1}[a-z0-9]+)*\.[a-z]{2,}$/;
  return domainRegex.test(domain);
}

function renderLists(): void {
  renderBlocklist();
  renderFullUrlList();
}

function renderBlocklist(): void {
  if (settings.blocklist.length === 0) {
    blocklistEl.innerHTML = '<li class="empty-state">No blocked domains</li>';
    return;
  }

  blocklistEl.innerHTML = settings.blocklist
    .map(domain => createDomainListItem(domain, 'blocklist'))
    .join('');

  // Add event listeners to remove buttons
  blocklistEl.querySelectorAll('.btn-danger').forEach(btn => {
    btn.addEventListener('click', function(this: HTMLButtonElement) {
      const domain = this.dataset.domain;
      if (domain) {
        removeFromBlocklist(domain);
      }
    });
  });
}

function renderFullUrlList(): void {
  if (settings.trackFullUrlDomains.length === 0) {
    fullurlList.innerHTML = '<li class="empty-state">No domains configured</li>';
    return;
  }

  fullurlList.innerHTML = settings.trackFullUrlDomains
    .map(domain => createDomainListItem(domain, 'fullurl'))
    .join('');

  // Add event listeners to remove buttons
  fullurlList.querySelectorAll('.btn-danger').forEach(btn => {
    btn.addEventListener('click', function(this: HTMLButtonElement) {
      const domain = this.dataset.domain;
      if (domain) {
        removeFromFullUrlList(domain);
      }
    });
  });
}

function createDomainListItem(domain: string, listType: string): string {
  return `
    <li>
      <span class="domain-name">${escapeHtml(domain)}</span>
      <button class="btn btn-danger" data-domain="${escapeHtml(domain)}" data-list="${listType}">
        Remove
      </button>
    </li>
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function addToBlocklist(domain: string): void {
  const normalized = normalizeDomain(domain);

  if (!isValidDomain(normalized)) {
    showStatus('Please enter a valid domain', true);
    return;
  }

  if (settings.blocklist.includes(normalized)) {
    showStatus('Domain already in blocklist', true);
    return;
  }

  settings.blocklist.push(normalized);
  saveSettings();
  renderBlocklist();
  blocklistInput.value = '';
}

function removeFromBlocklist(domain: string): void {
  settings.blocklist = settings.blocklist.filter(d => d !== domain);
  saveSettings();
  renderBlocklist();
}

function addToFullUrlList(domain: string): void {
  const normalized = normalizeDomain(domain);

  if (!isValidDomain(normalized)) {
    showStatus('Please enter a valid domain', true);
    return;
  }

  if (settings.trackFullUrlDomains.includes(normalized)) {
    showStatus('Domain already in list', true);
    return;
  }

  settings.trackFullUrlDomains.push(normalized);
  saveSettings();
  renderFullUrlList();
  fullurlInput.value = '';
}

function removeFromFullUrlList(domain: string): void {
  settings.trackFullUrlDomains = settings.trackFullUrlDomains.filter(d => d !== domain);
  saveSettings();
  renderFullUrlList();
}

function setupEventListeners(): void {
  // Blocklist
  addBlocklistBtn.addEventListener('click', () => {
    addToBlocklist(blocklistInput.value);
  });

  blocklistInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addToBlocklist(blocklistInput.value);
    }
  });

  // Full URL list
  addFullurlBtn.addEventListener('click', () => {
    addToFullUrlList(fullurlInput.value);
  });

  fullurlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addToFullUrlList(fullurlInput.value);
    }
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupEventListeners();
});
