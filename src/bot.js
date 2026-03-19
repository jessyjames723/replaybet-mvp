'use strict';

require('dotenv').config();

const { chromium } = require('playwright');

const SERVER_URL = process.env.SERVER_URL || `http://localhost:${process.env.HTTP_PORT || 3000}`;
const BOT_SECRET = process.env.BOT_SECRET || 'changeme';
const SPIN_INTERVAL_MS = parseInt(process.env.SPIN_INTERVAL_MS || '5000', 10);
const SLOT_LOAD_TIMEOUT_MS = parseInt(process.env.SLOT_LOAD_TIMEOUT_MS || '30000', 10);

// Открываем через bitz.io — там iframe слот загружается корректно
const GAME_URL = process.env.GAME_URL ||
  'https://bitz.io/ru/games/sweet-bonanza-1000';

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
  pg.on('response', async (res) => {  // работает и для BrowserContext и для Page
    try {
      // Перехватываем HTML игры чтобы обновить кеш на сервере
      if (res.url().includes('html5Game.do')) {
        const text = await res.text().catch(() => '');
        if (text.includes('gameService') && text.length > 10000) {
          console.log('[bot] Sending fresh game HTML to server:', text.length, 'bytes');
          fetch(`${SERVER_URL}/game-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Bot-Token': BOT_SECRET },
            body: JSON.stringify({ type: 'game_html', html: text, timestamp: Date.now() })
          }).catch(() => {});
        }
        return;
      }

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

  // Перехватываем ответы на уровне контекста — включая iframe
  await setupResponseInterception(context);

  page = await context.newPage();

  console.log('[bot] Opening game...');
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for slot to load (~18-20 sec)
  console.log('[bot] Waiting for slot to load (~20 sec)...');
  await page.waitForTimeout(20000);

  // Закрываем intro — нужно несколько нажатий (carousel из нескольких слайдов)
  // Получаем свежий URL iframe слота и отправляем на сервер
  try {
    const frames = page.frames();
    const gameFrame = frames.find(f => f.url().includes('mdvgprfxuu') || f.url().includes('gsfastpro'));
    if (gameFrame) {
      const iframeUrl = gameFrame.url();
      console.log('[bot] Game iframe URL:', iframeUrl.substring(0, 80));
      // Сохраняем iframe URL в game-state через отдельный эндпоинт
      // Временно: шлём как кастомный заголовок в следующем init
      // Сохраняем напрямую через fetch
      try {
        await fetch(`${SERVER_URL}/game-data`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bot-Token': BOT_SECRET },
          body: JSON.stringify({ type: 'iframe_url', url: iframeUrl, timestamp: Date.now() })
        });
      } catch(e) {}
      // Также пробуем старый сервер через query param
      try {
        await fetch(`${SERVER_URL}/game-data?iframeUrl=` + encodeURIComponent(iframeUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bot-Token': BOT_SECRET },
          body: JSON.stringify({ type: 'init', parsed: { iframeUrl }, raw: '', timestamp: Date.now() })
        });
      } catch(e) {}
    }
  } catch (e) { console.error('[bot] iframe URL error:', e.message); }

  console.log('[bot] Closing intro...');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(2000);

  console.log('[bot] Starting spin loop...');

  // Кликаем на iframe чтобы дать ему фокус перед спинами
  try {
    const frames = page.frames();
    const gameFrame = frames.find(f => f.url().includes('mdvgprfxuu') || f.url().includes('gsfastpro'));
    if (gameFrame) {
      const canvas = await gameFrame.$('canvas');
      if (canvas) {
        await canvas.click();
        console.log('[bot] Clicked canvas to focus game frame');
      }
    } else {
      // Кликаем по центру страницы
      await page.mouse.click(640, 360);
    }
  } catch (e) { /* ignore */ }

  await page.waitForTimeout(1000);

  // Spin every SPIN_INTERVAL_MS
  spinInterval = setInterval(async () => {
    if (isSpinning) return;
    try {
      isSpinning = true;
      // Нажимаем Space в контексте game frame
      const frames = page.frames();
      const gameFrame = frames.find(f => f.url().includes('mdvgprfxuu') || f.url().includes('gsfastpro'));
      if (gameFrame) {
        await gameFrame.press('canvas', 'Space').catch(() => {});
      }
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
