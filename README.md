# TimeOrganizer Activity Tracking

A cross-browser extension for Chrome, Edge, and Firefox that tracks browser activity (which sites you use and for how long) and sends data to a backend API.

## Features

- **JWT Authentication**: Secure login with access and refresh tokens
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

3. Configure the API endpoints in `src/shared/config.ts`:
   ```typescript
   export const API_BASE_URL = 'https://your-api.example.com';
   export const API_ACTIVITY_ENDPOINT = '/activity-tracking/web-extension/heartbeat';
   export const API_LOGIN_ENDPOINT = '/user/extension/login';
   export const API_REFRESH_ENDPOINT = '/user/extension/refresh';
   export const API_LOGOUT_ENDPOINT = '/user/extension/logout';
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
│   ├── auth.ts           # JWT authentication manager
│   └── storage.ts        # Local storage helpers
├── content/
│   └── visibility.ts     # Content script for visibility detection
├── popup/
│   ├── popup.html        # Popup with login form
│   ├── popup.ts
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.ts
│   └── options.css
└── shared/
    ├── types.ts          # Shared TypeScript interfaces
    ├── config.ts         # API endpoints, configuration
    └── utils.ts          # Helper functions
```

## API Integration

### Authentication

The extension uses JWT authentication with access and refresh tokens.

#### Login Endpoint
**POST** `/user/extension/login`

Request:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Response:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "dGhpcyBpcyBhIHJlZnJl...",
  "expiresIn": 3600
}
```

#### Refresh Endpoint
**POST** `/user/extension/refresh`

Request:
```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJl..."
}
```

Response:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 3600
}
```

#### Logout Endpoint (optional)
**POST** `/user/extension/logout`

Request:
```json
{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJl..."
}
```

### Activity Heartbeat

**POST** `/activity-tracking/web-extension/heartbeat`

Headers:
```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Request:
```json
{
  "heartbeatAt": "2024-01-15T10:30:00.000Z",
  "isIdle": false,
  "events": [
    {
      "type": "start",
      "domain": "github.com",
      "url": "https://github.com/user/repo",
      "isBackground": false,
      "at": "2024-01-15T10:29:55.000Z"
    },
    {
      "type": "end",
      "domain": "stackoverflow.com",
      "isBackground": false,
      "at": "2024-01-15T10:29:50.000Z"
    }
  ]
}
```

## Configuration

### Config File (`src/shared/config.ts`)

| Constant | Description | Default |
|----------|-------------|---------|
| `API_BASE_URL` | Backend API base URL | - |
| `API_ACTIVITY_ENDPOINT` | Activity heartbeat endpoint | `/activity-tracking/web-extension/heartbeat` |
| `API_LOGIN_ENDPOINT` | Login endpoint | `/user/extension/login` |
| `API_REFRESH_ENDPOINT` | Token refresh endpoint | `/user/extension/refresh` |
| `API_LOGOUT_ENDPOINT` | Logout endpoint | `/user/extension/logout` |
| `DEBOUNCE_THRESHOLD_MS` | Minimum visit duration to track | 5000ms |
| `HEARTBEAT_INTERVAL_MS` | API heartbeat interval | 30000ms |
| `IDLE_THRESHOLD_SECONDS` | Idle detection threshold | 180s |
| `TOKEN_REFRESH_BUFFER_MS` | Refresh token before expiry | 60000ms |
| `DEBUG_LOGGING` | Enable console logging | true |

### User Settings (Options Page)

- **Blocklist**: Domains to exclude from tracking
- **Full URL Tracking**: Domains where full URL should be tracked instead of domain-only

## Authentication Flow

1. User opens popup and sees login form
2. User enters email and password
3. Extension sends credentials to `/auth/login`
4. Backend returns access token, refresh token, and expiry time
5. Tokens are stored in `chrome.storage.local`
6. Access token is included in `Authorization` header for API calls
7. Token is automatically refreshed 1 minute before expiry
8. On 401 response, token refresh is attempted automatically
9. If refresh fails, user is logged out and must re-authenticate

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
