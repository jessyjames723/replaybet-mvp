'use strict';
const path = require('path');
const fs = require('fs');

let cachedGameHtml = null;
let cacheTime = 0;
const CACHE_FILE = path.join(__dirname, '..', 'public', 'game_cached.html');

function loadCachedHtml() {
  if (fs.existsSync(CACHE_FILE)) {
    return fs.readFileSync(CACHE_FILE, 'utf8');
  }
  return null;
}

function patchHtml(html, host) {
  return html.replace(
    /"gameService":"https:\/\/demogamesfree\.mdvgprfxuu\.net\/gs2c\/ge\/v4\/gameService"/g,
    `"gameService":"https://${host}/proxy/gameService"`
  );
}

module.exports = function setupGameProxy(app, gameState) {
  app.use(require('express').raw({ type: 'application/x-www-form-urlencoded', limit: '1mb' }));

  // GET /game — пропатченный HTML слота
  app.get('/game', (req, res) => {
    const html = loadCachedHtml();
    if (!html) return res.status(503).send('Game HTML not cached yet');
    const patched = patchHtml(html, req.get('host'));
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(patched);
  });

  // POST /proxy/gameService — перехватываем запросы слота
  app.post('/proxy/gameService', (req, res) => {
    const body = req.body ? req.body.toString() : '';
    const params = new URLSearchParams(body);
    const action = params.get('action') || 'unknown';
    console.log('[proxy] gameService action:', action, 'body len:', body.length);

    // doInit — возвращаем initData
    if (action.includes('Init')) {
      if (gameState.initData && gameState.initData.raw) {
        res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        return res.send(gameState.initData.raw);
      }
    }

    // doSpin — возвращаем последний спин
    if (gameState.lastSpin && gameState.lastSpin.raw) {
      res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      return res.send(gameState.lastSpin.raw);
    }

    res.status(503).send('tw=0.00&balance=100000.00&w=0.00&ntp=0.00');
  });

  console.log('[proxy] Routes: GET /game, POST /proxy/gameService');
};
