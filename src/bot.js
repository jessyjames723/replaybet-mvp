'use strict';

require('dotenv').config();

const { chromium } = require('playwright');

const SERVER_URL = process.env.SERVER_URL || `http://localhost:${process.env.HTTP_PORT || 3000}`;
const BOT_SECRET = process.env.BOT_SECRET || 'changeme';
const SPIN_INTERVAL_MS = parseInt(process.env.SPIN_INTERVAL_MS || '5000', 10);
const SLOT_LOAD_TIMEOUT_MS = parseInt(process.env.SLOT_LOAD_TIMEOUT_MS || '30000', 10);

// Sweet Bonanza 1000 demo URL (direct Pragmatic)
const GAME_URL = process.env.PRAGMATIC_IFRAME_URL ||
  'https://demogamesfree.mdvgprfxuu.net/gs2c/html5Game.do?extGame=1&symbol=vs20fruitswx&gname=Sweet%20Bonanza%201000&jurisdictionID=99&lobbyUrl=about:blank';

let page = null;
let browser = null;
let spinInterval = null;
let isSpinning = false;

// ─── Send data to server ──────────────────────────────────────────────────────
async function postGameData(data) {
  try {
    const res = await fetch(`${SERVER_URL}/game-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Token': BOT_SECRET,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[bot] POST /game-data failed: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error('[bot] Failed to post game data:', err.message);
  }
}

// ─── Parse doSpin response ────────────────────────────────────────────────────
function parseSpinResponse(rawText) {
  const params = new URLSearchParams(rawText);

  if (!params.has('s')) return null; // not a spin response

  const reels = params.get('s').split(',').map(Number);
  const win = parseFloat(params.get('w') || '0');
  const totalWin = parseFloat(params.get('tw') || '0');
  const balanceRaw = params.get('balance') || '0';
  const balance = parseFloat(balanceRaw.replace(/,/g, ''));
  const ntp = parseFloat(params.get('ntp') || '0');
  const fsLeft = params.has('fs_left') ? parseInt(params.get('fs_left'), 10) : null;
  const bonusWin = params.has('bonus_win') ? parseFloat(params.get('bonus_win')) : null;
  const multipliers = params.has('m')
    ? params.get('m').split(',').map(Number)
    : null;

  return {
    type: 'spin',
    action: 'doSpin',
    raw: rawText,
    reels,
    win,
    totalWin,
    balance,
    ntp,
    fsLeft,
    bonusWin,
    multipliers,
    parsed: { s: reels, w: win, tw: totalWin, balance, ntp, fs_left: fsLeft, bonus_win: bonusWin, multipliers },
    timestamp: Date.now(),
  };
}

// ─── Parse doInit response ────────────────────────────────────────────────────
function parseInitResponse(rawText) {
  const params = new URLSearchParams(rawText);

  if (!params.has('def_s') && !params.has('balance')) return null;

  // If it has 's' — it's a spin, not init
  if (params.has('s') && params.has('ntp')) return null;

  const defSRaw = params.get('def_s');
  const def_s = defSRaw ? defSRaw.split(',').map(Number) : null;
  const reel_set0 = params.get('reel_set0') || null;
  const scRaw = params.get('sc');
  const sc = scRaw ? scRaw.split(',').map(parseFloat) : null;
  const balance = parseFloat((params.get('balance') || '0').replace(/,/g, ''));

  return {
    type: 'init',
    action: 'doInit',
    raw: rawText,
    parsed: { def_s, reel_set0, sc, balance, paytable: null },
    timestamp: Date.now(),
  };
}

// ─── Response interception ────────────────────────────────────────────────────
async function setupResponseInterception(pg) {
  pg.on('response', async (res) => {
    try {
      if (!res.url().includes('ge/v4/gameService')) return;

      const status = res.status();
      if (status !== 200) return;

      const text = await res.text();
      if (!text || text.length < 10) return;

      // Try spin first
      const spinData = parseSpinResponse(text);
      if (spinData) {
        console.log(`[bot] Spin intercepted: balance=${spinData.balance}, win=${spinData.win}, fsLeft=${spinData.fsLeft}`);
        await postGameData(spinData);
        return;
      }

      // Try init
      const initData = parseInitResponse(text);
      if (initData) {
        console.log(`[bot] Init intercepted: balance=${initData.parsed.balance}`);
        await postGameData(initData);
        return;
      }

      console.log(`[bot] gameService response (unrecognized): ${text.substring(0, 100)}`);
    } catch (err) {
      if (!err.message.includes('closed') && !err.message.includes('detached')) {
        console.error('[bot] Response handler error:', err.message);
      }
    }
  });
}

// ─── Main bot loop ────────────────────────────────────────────────────────────
async function startBot() {
  console.log('[bot] Starting...');
  console.log(`[bot] Game URL: ${GAME_URL}`);
  console.log(`[bot] Server: ${SERVER_URL}`);
  console.log(`[bot] Spin interval: ${SPIN_INTERVAL_MS}ms`);

  browser = await chromium.launch({
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
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  page = await context.newPage();

  // Set up response interception
  await setupResponseInterception(page);

  console.log('[bot] Opening game...');
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for slot to load (~18-20 sec)
  console.log('[bot] Waiting for slot to load (~20 sec)...');
  await page.waitForTimeout(20000);

  // Close intro by pressing Space/Enter
  console.log('[bot] Closing intro...');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  console.log('[bot] Starting spin loop...');

  // Spin every SPIN_INTERVAL_MS
  spinInterval = setInterval(async () => {
    if (isSpinning) return;
    try {
      isSpinning = true;
      await page.keyboard.press('Space');
    } catch (err) {
      if (!err.message.includes('closed') && !err.message.includes('detached')) {
        console.error('[bot] Spin error:', err.message);
      }
    } finally {
      isSpinning = false;
    }
  }, SPIN_INTERVAL_MS);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown() {
  console.log('[bot] Shutting down...');
  if (spinInterval) clearInterval(spinInterval);
  if (browser) await browser.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
startBot().catch((err) => {
  console.error('[bot] Fatal error:', err);
  process.exit(1);
});
