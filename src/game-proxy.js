'use strict';
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CACHE_FILE = path.join(__dirname, '..', 'public', 'game_cached.html');
const PRAGMATIC_HOST = 'demogamesfree.mdvgprfxuu.net';

function patchHtml(html) {
  // Вытаскиваем datapath из gameConfig чтобы подставить в GAME_URL
  const datapathMatch = html.match(/"datapath":"([^"]+)"/);
  const datapath = datapathMatch ? datapathMatch[1] : '/pragmatic/common/v1/games-html5/games/vs/vs20fruitswx/';
  
  // Inline script который предустанавливает GAME_URL до загрузки bootstrap
  const gameUrlPatch = `<script>
// ReplayBet patch: pre-set GAME_URL so bootstrap.js loads from correct path
(function() {
  var _origUHTCONFIG = null;
  Object.defineProperty(window, 'UHT_CONFIG', {
    get: function() { return _origUHTCONFIG; },
    set: function(v) {
      _origUHTCONFIG = v;
      if (v && v.GAME_URL === '') {
        v.GAME_URL = '${datapath}';
        v.GAME_URL_ALTERNATIVE = '${datapath}';
      }
    },
    configurable: true
  });
})();
</script>`;

  return html
    // Вставляем патч сразу после <head>
    .replace('<head>', '<head>' + gameUrlPatch)
    // Заменяем все URL Pragmatic CDN (НЕ заменяем ключи JSON - только значения URL)
    .replace(/https:\/\/demogamesfree\.mdvgprfxuu\.net\/gs2c/g, '/pragmatic')
    // contextPath: "/gs2c" -> "/pragmatic"
    .replace(/contextPath:\s*"\/gs2c"/g, 'contextPath: "/pragmatic"')
    // gameService в JSON: сохраняем ключ, меняем только значение
    .replace(/"gameService":"https:\/\/demogamesfree[^"]*"/g, '"gameService":"/pragmatic/ge/v4/gameService"')
    .replace(/"gameService":"http:\/\/localhost:[^"]*"/g, '"gameService":"/pragmatic/ge/v4/gameService"')
    .replace(/"gameService":"\/proxy\/gameService"/g, '"gameService":"/pragmatic/ge/v4/gameService"');
}

// Простой ручной прокси вместо http-proxy-middleware (v3 API сломан)
function proxyRequest(req, res, targetPath) {
  const options = {
    hostname: PRAGMATIC_HOST,
    port: 443,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: PRAGMATIC_HOST,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'referer': `https://${PRAGMATIC_HOST}/`,
    }
  };
  delete options.headers['x-bot-token'];

  const proxyReq = https.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('[proxy] Error:', e.message);
    res.status(502).end('Proxy error');
  });

  if (req.method === 'POST') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

module.exports = function setupGameProxy(app, gameState) {

  // GET /game — HTML слота с пропатченными URL
  app.get('/game', (req, res) => {
    const html = gameState.gameHtml || (fs.existsSync(CACHE_FILE) ? fs.readFileSync(CACHE_FILE, 'utf8') : null);
    if (!html) return res.status(503).send('<html><body style="background:#000;color:#fff;padding:40px;text-align:center"><h2>⏳ Загружаем игру...</h2><p>Обновите через 30 сек</p><script>setTimeout(()=>location.reload(),15000)</script></body></html>');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(patchHtml(html));
  });

  // OPTIONS preflight
  app.options('/pragmatic/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(200);
  });

  // POST /pragmatic/ge/v4/gameService — данные бота
  app.post('/pragmatic/ge/v4/gameService', (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const action = params.get('action') || '';
      console.log('[proxy] gameService action:', action);

      res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // doInit — отдаём данные от бота
      if (action.includes('Init')) {
        if (gameState.initData?.raw) {
          console.log('[proxy] serving initData from bot, len:', gameState.initData.raw.length);
          return res.send(gameState.initData.raw);
        }
        // Фоллбек если бот ещё не прислал init
        const now = Date.now();
        return res.send(`balance=100000.00&index=1&balance_cash=100000.00&balance_bonus=0.00&na=s&stime=${now}&sver=5&counter=1&ntp=0.00`);
      }

      // Спин — отдаём данные бота
      if (gameState.lastSpin?.raw) return res.send(gameState.lastSpin.raw);
      res.send('tw=0.00&balance=100000.00&w=0.00&ntp=0.00');
    });
  });

  // Заглушки
  app.all('/pragmatic/stats.do', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ error: 0, description: 'OK' });
  });
  app.all('/pragmatic/regulation/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ error: 0 });
  });

  // Игра может генерировать пути без /pragmatic/ префикса (/mobile/, /desktop/, /common/, /ge/)
  // Добавляем catch-all для известных путей движка
  const gameSubPaths = ['/mobile', '/desktop', '/mini', '/common', '/ge', '/saveSettings', '/regulation', '/stats', '/closeGame', '/logout', '/reloadBalance', '/jackpot', '/announcements'];
  for (const subPath of gameSubPaths) {
    app.all(subPath + '/*', (req, res) => {
      const targetPath = '/gs2c' + req.url;
      console.log('[proxy] game subpath:', req.url, '->', targetPath);
      proxyRequest(req, res, targetPath);
    });
    app.all(subPath, (req, res) => {
      const targetPath = '/gs2c' + req.url;
      proxyRequest(req, res, targetPath);
    });
  }

  // ВСЁ остальное /pragmatic/* → проксируем на Pragmatic с /gs2c/ префиксом
  app.all('/pragmatic/*', (req, res) => {
    const subPath = req.path.replace('/pragmatic', '');
    const targetPath = '/gs2c' + subPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    proxyRequest(req, res, targetPath);
  });

  console.log('[proxy] Full proxy ready: GET /game, /pragmatic/* → demogamesfree.mdvgprfxuu.net/gs2c/*');
};
