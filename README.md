# TimeOrganizer Activity Tracking

A cross-browser extension for Chrome, Edge, and Firefox that tracks browser activity (which sites you use and for how long) and sends data to a backend API.

## Features

- **Activity Tracking**: Tracks time spent on websites
  - **Active tracking**: The focused tab in the focused browser window
  - **Background tracking**: Visible tabs (e.g., on second monitor) or audible tabs
- **Smart Debouncing**: Ignores visits shorter than 5 seconds
- **Idle Detection**: Pauses tracking after 3 minutes of inactivity
- **API Integration**: Sends heartbeat data every 30 seconds
- **Offline Support**: Queues events when API is unreachable
- **Privacy Controls**:
  - Blocklist domains you don't want to track
  - Choose which domains track full URLs vs domain-only

## Installation

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd TimeOrganizer-ActivityTracking
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure the API endpoint in `src/shared/config.ts`:
   ```typescript
   export const API_URL = 'https://your-api.example.com/activity';
   export const API_KEY = 'your-api-key-here';
   ```

4. Generate icons (open `icons/generate-icons.html` in a browser and save each canvas as PNG), or replace with your own icons.

### Building

Build for Chrome/Edge:
```bash
npm run build:chrome
```

Build for Firefox:
```bash
npm run build:firefox
```

Build for all browsers:
```bash
npm run build:all
```

Development mode (watch for changes):
```bash
npm run dev
```

### Loading the Extension

#### Chrome/Edge
1. Navigate to `chrome://extensions` (or `edge://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/chrome` folder

#### Firefox
1. Navigate to `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select any file in the `dist/firefox` folder

## Project Structure

```
src/
├── background/
│   ├── index.ts          # Service worker main entry
│   ├── tracker.ts        # Core tracking logic
│   ├── api.ts            # API communication
│   └── storage.ts        # Local storage helpers
├── content/
│   └── visibility.ts     # Content script for visibility detection
├── popup/
│   ├── popup.html
│   ├── popup.ts
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.ts
│   └── options.css
└── shared/
    ├── types.ts          # Shared TypeScript interfaces
    ├── config.ts         # API_URL, API_KEY constants
    └── utils.ts          # Helper functions
```

## API Integration

The extension sends heartbeat data every 30 seconds:

```typescript
interface ActivityHeartbeat {
  heartbeatAt: string; // ISO 8601 timestamp
  isIdle: boolean;
  events: ActivityEvent[];
}

interface ActivityEvent {
  type: 'start' | 'end';
  domain: string;
  url?: string; // included based on user settings
  isBackground: boolean;
  at: string; // ISO 8601 timestamp
}
```

API requests include the header `X-Api-Key: {API_KEY}`.

## Configuration

### Config File (`src/shared/config.ts`)

| Constant | Description | Default |
|----------|-------------|---------|
| `API_URL` | Backend API endpoint | - |
| `API_KEY` | API authentication key | - |
| `DEBOUNCE_THRESHOLD_MS` | Minimum visit duration to track | 5000ms |
| `HEARTBEAT_INTERVAL_MS` | API heartbeat interval | 30000ms |
| `IDLE_THRESHOLD_SECONDS` | Idle detection threshold | 180s |
| `DEBUG_LOGGING` | Enable console logging | true |

### User Settings (Options Page)

- **Blocklist**: Domains to exclude from tracking
- **Full URL Tracking**: Domains where full URL should be tracked instead of domain-only

## Browser Compatibility

- Chrome 88+ (Manifest V3)
- Edge 88+ (Manifest V3)
- Firefox 109+ (Manifest V3)

## Development

Type checking:
```bash
npm run typecheck
```

## License

MIT
