'use strict';
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');

const CACHE_FILE = path.join(__dirname, '..', 'public', 'game_cached.html');
const PRAGMATIC_BASE = 'https://demogamesfree.mdvgprfxuu.net';

function patchHtml(html) {
  return html
    // Заменяем все URL Pragmatic на наш прокси путь
    .replace(/https:\/\/demogamesfree\.mdvgprfxuu\.net\/gs2c/g, '/pragmatic')
    // gameService уже будет /pragmatic/ge/v4/gameService - перехватим отдельно
    ;
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

  // POST /pragmatic/ge/v4/gameService — перехватываем, возвращаем данные бота
  app.post('/pragmatic/ge/v4/gameService', (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const action = params.get('action') || '';
      console.log('[proxy] gameService action:', action);

      res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (action.includes('Init') && gameState.initData?.raw) {
        return res.send(gameState.initData.raw);
      }
      if (gameState.lastSpin?.raw) {
        return res.send(gameState.lastSpin.raw);
      }
      res.send('tw=0.00&balance=100000.00&w=0.00&ntp=0.00');
    });
  });

  // OPTIONS preflight для gameService
  app.options('/pragmatic/ge/v4/gameService', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(200);
  });

  // GET /pragmatic/stats.do — отвечаем OK чтобы не мешало
  app.get('/pragmatic/stats.do', (req, res) => res.send('{"error":0,"description":"OK"}'));
  app.post('/pragmatic/stats.do', (req, res) => res.send('{"error":0,"description":"OK"}'));

  // Всё остальное /pragmatic/* — проксируем на Pragmatic
  app.use('/pragmatic', createProxyMiddleware({
    target: PRAGMATIC_BASE,
    changeOrigin: true,
    pathRewrite: { '^/pragmatic': '/gs2c' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        proxyReq.setHeader('Referer', PRAGMATIC_BASE);
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers['access-control-allow-origin'] = '*';
      },
      error: (err, req, res) => {
        console.error('[proxy] Proxy error:', err.message);
        res.status(502).send('Proxy error');
      }
    }
  }));

  console.log('[proxy] Full proxy ready: GET /game, POST /pragmatic/ge/v4/gameService, proxy /pragmatic/*');
};
