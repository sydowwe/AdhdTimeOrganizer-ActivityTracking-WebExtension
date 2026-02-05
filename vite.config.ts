import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

const browser = process.env.BROWSER || 'chrome';

// Custom plugin to copy icons
function copyIconsPlugin() {
  return {
    name: 'copy-icons',
    closeBundle() {
      const outDir = `dist/${browser}/icons`;
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }
      const sizes = [16, 32, 48, 128];
      for (const size of sizes) {
        const src = `icons/icon${size}.png`;
        const dest = `${outDir}/icon${size}.png`;
        if (existsSync(src)) {
          copyFileSync(src, dest);
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [
    webExtension({
      manifest: () => {
        const baseManifest = {
          manifest_version: 3,
          name: 'TimeOrganizer Activity Tracking',
          version: '1.0.0',
          description: 'Track browser activity and send data to a backend API',
          permissions: [
            'tabs',
            'activeTab',
            'storage',
            'idle',
            'alarms'
          ],
          host_permissions: ['<all_urls>'],
          background: browser === 'firefox'
            ? { scripts: ['src/background/index.ts'], type: 'module' as const }
            : { service_worker: 'src/background/index.ts', type: 'module' as const },
          content_scripts: [
            {
              matches: ['<all_urls>'],
              js: ['src/content/visibility.ts'],
              run_at: 'document_start'
            },
            {
              matches: ['<all_urls>'],
              js: ['src/content/videoDetector.ts'],
              run_at: 'document_idle'
            }
          ],
          action: {
            default_popup: 'src/popup/popup.html',
            default_icon: {
              '16': 'icons/icon16.png',
              '32': 'icons/icon32.png',
              '48': 'icons/icon48.png',
              '128': 'icons/icon128.png'
            }
          },
          options_ui: {
            page: 'src/options/options.html',
            open_in_tab: true
          },
          icons: {
            '16': 'icons/icon16.png',
            '32': 'icons/icon32.png',
            '48': 'icons/icon48.png',
            '128': 'icons/icon128.png'
          }
        };

        if (browser === 'firefox') {
          return {
            ...baseManifest,
            browser_specific_settings: {
              gecko: {
                id: 'timeorganizer-activity-tracking@example.com',
                strict_min_version: '109.0'
              }
            }
          };
        }

        return baseManifest;
      },
      browser,
    }),
    copyIconsPlugin(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@background': resolve(__dirname, 'src/background'),
    },
  },
  build: {
    outDir: `dist/${browser}`,
    emptyOutDir: true,
  },
});
