'use strict';

const { chromium } = require('playwright');

// Кешируем свежий HTML игры (обновляем каждые 15 минут)
let cachedGameHtml = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

async function fetchFreshGameHtml() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  let html = null;

  page.on('response', async res => {
    if (res.url().includes('html5Game.do') && !html) {
      try {
        const text = await res.text();
        if (!text.includes('not logged in') && text.includes('gameService')) {
          html = text;
          console.log('[proxy] Got fresh game HTML, length:', html.length);
        }
      } catch(e) {}
    }
  });

  await page.goto('https://bitz.io/ru/games/sweet-bonanza-1000', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(8000);
  await browser.close();
  return html;
}

// Патчим HTML — заменяем gameService URL на наш прокси
function patchHtml(html, serverHost) {
  const proxyUrl = `https://${serverHost}/proxy/gameService`;
  return html.replace(
    /https:\/\/demogamesfree\.mdvgprfxuu\.net\/gs2c\/ge\/v4\/gameService/g,
    proxyUrl
  );
}

// Экспортируем middleware для Express
module.exports = function setupGameProxy(app, gameState) {
  // GET /game — отдаём пропатченный HTML игры
  app.get('/game', async (req, res) => {
    try {
      const now = Date.now();
      if (!cachedGameHtml || now - cacheTime > CACHE_TTL) {
        console.log('[proxy] Fetching fresh game HTML...');
        cachedGameHtml = await fetchFreshGameHtml();
        cacheTime = now;
      }
      if (!cachedGameHtml) {
        return res.status(503).send('Game not available yet, retry in 30 seconds');
      }
      const host = req.hostname;
      const patched = patchHtml(cachedGameHtml, req.get('host'));
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store');
      res.send(patched);
    } catch(e) {
      console.error('[proxy] Error:', e.message);
      res.status(500).send('Error: ' + e.message);
    }
  });

  // POST /proxy/gameService — перехватываем запросы слота и отвечаем данными бота
  app.post('/proxy/gameService', (req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const action = params.get('action') || '';
      console.log('[proxy] gameService action:', action);

      if (action === 'doInit' || action.includes('Init')) {
        // Возвращаем initData если есть, иначе пропускаем на оригинал
        if (gameState.initData && gameState.initData.raw) {
          res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
          return res.send(gameState.initData.raw);
        }
      }

      if (action === 'doSpin' || action.includes('Spin') || !action) {
        // Возвращаем последний спин от бота
        if (gameState.lastSpin && gameState.lastSpin.raw) {
          res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
          return res.send(gameState.lastSpin.raw);
        }
      }

      // Нет данных — проксируем на оригинал
      const fetch = require('node-fetch').default;
      fetch('https://demogamesfree.mdvgprfxuu.net/gs2c/ge/v4/gameService', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...req.headers },
        body: body
      }).then(r => r.text()).then(text => {
        res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        res.send(text);
      }).catch(e => res.status(502).send('Proxy error: ' + e.message));
    });
  });

  console.log('[proxy] Game proxy routes registered: GET /game, POST /proxy/gameService');
};
