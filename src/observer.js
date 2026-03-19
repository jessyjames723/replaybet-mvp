'use strict';

require('dotenv').config();

const { chromium } = require('playwright');
const { WebSocket } = require('ws');
const path = require('path');

const SERVER_HTTP = `http://localhost:${process.env.PORT || process.env.HTTP_PORT || 3000}`;
const SERVER_WS = `ws://localhost:${process.env.WS_PORT || 3001}`;

// Observer page URL (our server serves it)
const OBSERVER_PAGE_URL = `${SERVER_HTTP}/observer.html`;

const PRAGMATIC_IFRAME_URL = process.env.PRAGMATIC_IFRAME_URL ||
  'https://demogamesfree.mdvgprfxuu.net/gs2c/html5Game.do?extGame=1&symbol=vs20fruitswx&gname=Sweet%20Bonanza%201000&jurisdictionID=99&lobbyUrl=about:blank';

// ─── Local state ──────────────────────────────────────────────────────────────
const localState = {
  initData: null,
  lastSpin: null,
  pendingSpin: null,
  botStatus: 'offline',
};

let ws = null;
let wsReconnectDelay = 1000;
const MAX_WS_RECONNECT = 30000;

// ─── Fetch current state from server ─────────────────────────────────────────
async function fetchGameState() {
  try {
    const res = await fetch(`${SERVER_HTTP}/game-state`);
    if (res.ok) {
      const state = await res.json();
      if (state.initData) localState.initData = state.initData;
      if (state.lastSpin) {
        localState.lastSpin = state.lastSpin;
        localState.pendingSpin = state.lastSpin;
      }
      localState.botStatus = state.botStatus;
      console.log(`[observer] Fetched state: botStatus=${state.botStatus}, hasSpin=${!!state.lastSpin}`);
    }
  } catch (err) {
    console.error('[observer] Failed to fetch game state:', err.message);
  }
}

// ─── WebSocket connection to server ──────────────────────────────────────────
function connectWS() {
  console.log(`[observer] Connecting WS to ${SERVER_WS}...`);
  ws = new WebSocket(SERVER_WS);

  ws.on('open', () => {
    console.log('[observer] WS connected');
    wsReconnectDelay = 1000;
    // Sync state after connect
    fetchGameState();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'spin':
          localState.lastSpin = msg;
          localState.pendingSpin = msg;
          localState.botStatus = msg.fsLeft > 0 ? 'bonus' : 'online';
          break;

        case 'init':
          localState.initData = msg;
          if (localState.botStatus === 'offline') localState.botStatus = 'initializing';
          break;

        case 'status':
          localState.botStatus = msg.botStatus;
          break;

        case 'pong':
          // ignore
          break;
      }
    } catch (err) {
      console.error('[observer] WS message parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.warn(`[observer] WS disconnected. Reconnecting in ${wsReconnectDelay}ms...`);
    setTimeout(() => {
      connectWS();
    }, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, MAX_WS_RECONNECT);
  });

  ws.on('error', (err) => {
    console.error('[observer] WS error:', err.message);
  });

  // Ping every 30 seconds
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000);
}

// ─── Wait for data with polling ───────────────────────────────────────────────
async function waitForData(getter, timeoutMs = 10000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = getter();
    if (val) return val;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ─── Build fallback spin response ─────────────────────────────────────────────
function generateFallbackSpin() {
  // Neutral losing spin
  return 'tw=0.00&balance=100000.00&s=1,2,3,4,5,6,1,2,3,4,5,6,1,2,3,4,5,6,1,2,3,4,5,6,1,2,3,4,5,6&w=0.00&ntp=-2.00';
}

// ─── Route handler ────────────────────────────────────────────────────────────
async function handleGameServiceRoute(route, request) {
  try {
    const postData = request.postData() || '';
    const params = new URLSearchParams(postData);
    const action = params.get('action') || '';

    console.log(`[observer] Intercepted: action=${action}`);

    if (action === 'doInit' || (!action && postData.includes('doInit'))) {
      // Wait for init data (up to 10 sec)
      let data = localState.initData;
      if (!data) {
        console.log('[observer] Waiting for initData...');
        data = await waitForData(() => localState.initData, 10000);
      }

      if (data && data.raw) {
        console.log('[observer] Fulfilling doInit with bot data');
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Access-Control-Allow-Origin': '*',
          },
          body: data.raw,
        });
      } else {
        console.log('[observer] No initData, forwarding doInit');
        await route.continue();
      }
      return;
    }

    if (action === 'doSpin' || (!action && postData.includes('doSpin'))) {
      // Use pending spin (one-shot) or last spin
      let spinData = localState.pendingSpin || localState.lastSpin;

      if (!spinData) {
        console.log('[observer] Waiting for spin data...');
        spinData = await waitForData(
          () => localState.pendingSpin || localState.lastSpin,
          15000
        );
      }

      if (spinData && spinData.raw) {
        // Consume pending spin
        if (localState.pendingSpin) {
          localState.pendingSpin = null;
        }
        console.log(`[observer] Fulfilling doSpin: win=${spinData.win}, balance=${spinData.balance}`);
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Access-Control-Allow-Origin': '*',
          },
          body: spinData.raw,
        });
      } else {
        // Fallback
        console.log('[observer] No spin data, using fallback');
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Access-Control-Allow-Origin': '*',
          },
          body: generateFallbackSpin(),
        });
      }
      return;
    }

    // Unknown action — forward
    console.log(`[observer] Unknown action "${action}", forwarding`);
    await route.continue();

  } catch (err) {
    console.error('[observer] Route handler error:', err.message);
    try {
      await route.continue();
    } catch (_) {}
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function startObserver() {
  console.log('[observer] Starting...');

  // Connect WS and sync initial state
  connectWS();
  await fetchGameState();

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Intercept ALL gameService calls (including from iframes)
  await page.route('**/ge/v4/gameService**', handleGameServiceRoute);

  console.log(`[observer] Opening observer page: ${OBSERVER_PAGE_URL}`);
  await page.goto(OBSERVER_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('[observer] Observer page loaded. Waiting for iframe interactions...');

  // Keep alive
  process.on('SIGINT', async () => {
    await browser.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await browser.close();
    process.exit(0);
  });
}

startObserver().catch((err) => {
  console.error('[observer] Fatal:', err);
  process.exit(1);
});
