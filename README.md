# ReplayBet Observer MVP

Live slot gameplay broadcast system for Sweet Bonanza 1000 (Pragmatic Play demo).

## Architecture

```
[Bot] → plays slot → intercepts responses → POST /game-data
[Server] → stores state → broadcasts via WebSocket
[Observer] → Playwright + page.route() → serves slot to viewers
[Viewer] → browser → observer.html → iframe + overlay
```

## Components

| File | Role |
|------|------|
| `src/server.js` | Express HTTP + WebSocket hub |
| `src/bot.js` | Playwright bot that plays the slot |
| `src/observer.js` | Playwright observer with page.route() interception |
| `public/observer.html` | Viewer UI with iframe + overlay |

## Quick Start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Copy env
cp .env.example .env
# Edit BOT_SECRET and other settings

# Start server
npm run server

# Start bot (separate terminal)
npm run bot

# Start observer (separate terminal)
npm run observer

# Or all at once
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `HTTP_PORT` | `3000` | HTTP server port |
| `WS_PORT` | `3001` | WebSocket port |
| `BOT_SECRET` | `changeme` | Auth token between bot and server |
| `SPIN_INTERVAL_MS` | `5000` | Bot spin interval (ms) |
| `BOT_OFFLINE_TIMEOUT_MS` | `30000` | Bot offline detection timeout |
| `SLOT_LOAD_TIMEOUT_MS` | `30000` | Slot load timeout |

## API

### `POST /game-data`
Bot sends game events. Requires `X-Bot-Token` header.

### `GET /game-state`
Current game snapshot (observers use this on connect).

### `GET /health`
Health check.

### WebSocket `ws://host:3001`
Real-time events: `spin`, `init`, `status`, `error`.

## Railway Deployment

The server runs as the main Railway service. Bot and observer are separate processes that should be run locally or in additional Railway services.

Set env vars:
- `BOT_SECRET=replaybet-secret-2026`
- `PORT` (Railway sets automatically)

## How It Works

1. **Bot** opens the slot via Playwright, intercepts HTTP responses from Pragmatic API
2. Bot sends raw response strings to **Server** via `POST /game-data`
3. **Server** stores state and broadcasts via WebSocket
4. **Observer** (Playwright) opens `observer.html` which loads the slot in an iframe
5. Observer's `page.route()` intercepts all `ge/v4/gameService` calls from the iframe
6. Observer returns the bot's raw response strings, so the slot renders bot's actual results
7. **Viewers** visit the observer URL and see the slot running with bot's data + overlay info

## License

MIT
