'use strict';
const path = require('path');
const fs = require('fs');

const CACHE_FILE = path.join(__dirname, '..', 'public', 'game_cached.html');

function patchHtml(html) {
  // Используем относительный URL - работает на любом домене
  return html
    .replace(
      /"gameService":"https:\/\/demogamesfree\.mdvgprfxuu\.net\/gs2c\/ge\/v4\/gameService"/g,
      '"gameService":"/proxy/gameService"'
    )
    .replace(
      /"gameService":"http:\/\/localhost:[0-9]+\/proxy\/gameService"/g,
      '"gameService":"/proxy/gameService"'
    );
}

module.exports = function setupGameProxy(app, gameState) {

  // GET /game — пропатченный HTML слота
  app.get('/game', (req, res) => {
    // Сначала пробуем свежий HTML из памяти (от бота)
    let html = gameState.gameHtml || null;

    // Fallback: читаем из файла
    if (!html && fs.existsSync(CACHE_FILE)) {
      html = fs.readFileSync(CACHE_FILE, 'utf8');
    }

    if (!html) {
      return res.status(503).send(`
        <html><body style="background:#000;color:#fff;font-family:sans-serif;padding:40px;text-align:center">
        <h2>⏳ Загружаем игру...</h2>
        <p>Бот подключается к слоту. Обновите страницу через 30 секунд.</p>
        <script>setTimeout(()=>location.reload(), 15000)</script>
        </body></html>
      `);
    }

    const patched = patchHtml(html);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(patched);
  });

  // POST /proxy/gameService — перехватываем запросы слота, возвращаем данные бота
  app.post('/proxy/gameService', (req, res) => {
    const body = req.body ? req.body.toString() : '';
    const params = new URLSearchParams(body);
    const action = params.get('action') || 'unknown';
    console.log('[proxy] gameService action:', action);

    res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // doInit — возвращаем initData от бота
    if (action.includes('Init') || action === 'doInit') {
      if (gameState.initData && gameState.initData.raw) {
        return res.send(gameState.initData.raw);
      }
    }

    // Все остальные (doSpin и др.) — последний спин от бота
    if (gameState.lastSpin && gameState.lastSpin.raw) {
      return res.send(gameState.lastSpin.raw);
    }

    // Нет данных — дефолт
    res.send('tw=0.00&balance=100000.00&w=0.00&ntp=0.00&s=1,2,3,4,5,6,7,8,9,10,11,1,2,3,4,5,6,7,8,9,10,11,1,2,3,4,5,6,7,8');
  });

  console.log('[proxy] Routes: GET /game, POST /proxy/gameService');
};
