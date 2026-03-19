'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const HTTP_PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || '3000', 10);
const WS_PORT = parseInt(process.env.WS_PORT || '3001', 10);
const BOT_SECRET = process.env.BOT_SECRET || 'changeme';
const BOT_OFFLINE_TIMEOUT_MS = parseInt(process.env.BOT_OFFLINE_TIMEOUT_MS || '30000', 10);

// ─── Game State ─────────────────────────────────────────────────────────────
const gameState = {
  botStatus: 'offline',
  lastSeen: null,
  lastSpin: null,
  initData: null,
  connectedObservers: 0,
  spinCount: 0,
  recentSpins: [],
  iframeUrl: null, // свежий URL iframe от бота
};

// ─── Express HTTP Server ──────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
// Serve observer.html from embedded source (avoids Docker layer cache)
const observerHtml = require('./observer-html');
app.get('/', (req, res) => res.redirect('/observer.html'));
app.get('/observer.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(observerHtml);
});
// Static middleware removed - all routes served explicitly

// Health check
// Отдаём свежий iframe URL боту
app.get('/iframe-url', (req, res) => {
  res.json({ url: gameState.iframeUrl });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// Game state snapshot
app.get('/game-state', (req, res) => {
  res.json({
    botStatus: gameState.botStatus,
    lastSpin: gameState.lastSpin,
    initData: gameState.initData,
    iframeUrl: gameState.iframeUrl,
    connectedObservers: gameState.connectedObservers,
    serverTime: Date.now(),
  });
});

// Bot posts game data
app.post('/game-data', (req, res) => {
  // Auth check
  const token = req.headers['x-bot-token'];
  if (token !== BOT_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const data = req.body;

  // Validate required field
  if (!data || !data.type) {
    return res.status(400).json({ ok: false, error: 'Missing required field: type' });
  }

  gameState.lastSeen = Date.now();

  if (data.type === 'init') {
    gameState.initData = {
      defReels: data.parsed?.def_s || null,
      reelSet: data.parsed?.reel_set0 || null,
      stakes: data.parsed?.sc || null,
      paytable: data.parsed?.paytable || null,
      raw: data.raw || '',
      timestamp: data.timestamp || Date.now(),
    };
    gameState.botStatus = 'initializing';

    const event = {
      type: 'init',
      defReels: gameState.initData.defReels,
      reelSet: gameState.initData.reelSet,
      stakes: gameState.initData.stakes,
      paytable: gameState.initData.paytable,
      timestamp: gameState.initData.timestamp,
    };
    broadcast(event);
    console.log('[server] Bot init received, broadcasting to observers');

  } else if (data.type === 'spin') {
    const spin = {
      reels: data.reels || data.parsed?.s || null,
      win: data.win ?? data.parsed?.w ?? 0,
      totalWin: data.totalWin ?? data.parsed?.tw ?? 0,
      balance: data.balance ?? data.parsed?.balance ?? 0,
      ntp: data.ntp ?? data.parsed?.ntp ?? 0,
      fsLeft: data.fsLeft ?? data.parsed?.fs_left ?? null,
      bonusWin: data.bonusWin ?? data.parsed?.bonus_win ?? null,
      multipliers: data.multipliers ?? data.parsed?.multipliers ?? null,
      raw: data.raw || '',
      timestamp: data.timestamp || Date.now(),
    };

    gameState.lastSpin = spin;
    gameState.spinCount++;

    // Keep last 10 spins
    gameState.recentSpins.push(spin);
    if (gameState.recentSpins.length > 10) {
      gameState.recentSpins.shift();
    }

    // Detect bonus mode
    if (spin.fsLeft !== null && spin.fsLeft > 0) {
      gameState.botStatus = 'bonus';
    } else {
      gameState.botStatus = 'online';
    }

    const event = {
      type: 'spin',
      reels: spin.reels,
      win: spin.win,
      totalWin: spin.totalWin,
      balance: spin.balance,
      ntp: spin.ntp,
      fsLeft: spin.fsLeft,
      bonusWin: spin.bonusWin,
      multipliers: spin.multipliers,
      timestamp: spin.timestamp,
    };
    broadcast(event);

    if (gameState.spinCount % 10 === 0) {
      console.log(`[server] Spin #${gameState.spinCount}, balance=${spin.balance}, win=${spin.win}`);
    }

  } else {
  } else if (data.type === 'iframe_url') {
    gameState.iframeUrl = data.url;
    console.log('[server] iframe URL updated:', data.url.substring(0, 80));
  } else {
    return res.status(400).json({ ok: false, error: `Unknown type: ${data.type}` });
  }
  }

  res.json({ ok: true });
});

// ─── WebSocket Server (на том же HTTP сервере, не отдельный порт) ────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  gameState.connectedObservers = wss.clients.size;
  console.log(`[ws] Observer connected. Total: ${gameState.connectedObservers}`);

  // Send current status on connect
  ws.send(JSON.stringify({
    type: 'status',
    botStatus: gameState.botStatus,
    lastSeen: gameState.lastSeen,
    message: gameState.botStatus === 'offline' ? 'Waiting for bot...' : 'Bot active',
  }));

  // If we have init data, send it immediately
  if (gameState.initData) {
    ws.send(JSON.stringify({
      type: 'init',
      defReels: gameState.initData.defReels,
      reelSet: gameState.initData.reelSet,
      stakes: gameState.initData.stakes,
      paytable: gameState.initData.paytable,
      timestamp: gameState.initData.timestamp,
    }));
  }

  // If we have last spin, send it immediately
  if (gameState.lastSpin) {
    ws.send(JSON.stringify({
      type: 'spin',
      reels: gameState.lastSpin.reels,
      win: gameState.lastSpin.win,
      totalWin: gameState.lastSpin.totalWin,
      balance: gameState.lastSpin.balance,
      ntp: gameState.lastSpin.ntp,
      fsLeft: gameState.lastSpin.fsLeft,
      bonusWin: gameState.lastSpin.bonusWin,
      multipliers: gameState.lastSpin.multipliers,
      timestamp: gameState.lastSpin.timestamp,
    }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    gameState.connectedObservers = wss.clients.size;
    console.log(`[ws] Observer disconnected. Total: ${gameState.connectedObservers}`);
  });

  ws.on('error', (err) => {
    console.error('[ws] Client error:', err.message);
  });
});

// ─── Bot Watchdog ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (gameState.botStatus === 'offline') return;
  if (!gameState.lastSeen) return;

  const elapsed = Date.now() - gameState.lastSeen;
  if (elapsed > BOT_OFFLINE_TIMEOUT_MS) {
    console.warn(`[watchdog] Bot offline (${Math.floor(elapsed / 1000)}s silent)`);
    gameState.botStatus = 'offline';
    broadcast({
      type: 'status',
      botStatus: 'offline',
      lastSeen: gameState.lastSeen,
      message: 'Bot disconnected',
    });
  }
}, 5000);

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(HTTP_PORT, () => {
  console.log(`[server] HTTP+WS listening on port ${HTTP_PORT}`);
  console.log(`[server] BOT_SECRET: ${BOT_SECRET.substring(0, 4)}****`);
});

httpServer.on('error', (err) => {
  console.error('[server] Fatal:', err);
  process.exit(1);
});
