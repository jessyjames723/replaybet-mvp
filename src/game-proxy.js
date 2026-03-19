'use strict';
const path = require('path');
const fs   = require('fs');
const https = require('https');

const ENGINE_DIR = path.join(__dirname, '..', 'public', 'engine');
const GAME_HTML  = path.join(ENGINE_DIR, 'game.html');

module.exports = function setupGameProxy(app, gameState) {

  // Статические файлы движка и operator_logos
  const express = require('express');
  app.use('/engine', express.static(ENGINE_DIR, { maxAge: '1h' }));
  app.use('/operator_logos', express.static(path.join(__dirname, '..', 'public', 'operator_logos'), { maxAge: '1h' }));
  // logo_info.js иногда запрашивается с /engine/ префиксом
  app.use('/engine/operator_logos', express.static(path.join(__dirname, '..', 'public', 'operator_logos'), { maxAge: '1h' }));

  // html5Game.do - Pragmatic endpoint для загрузки игры (bootstrap его вызывает)
  app.get('/html5Game.do', (req, res) => {
    let html = fs.readFileSync(GAME_HTML, 'utf8');
    const mgckey = req.query.mgckey || gameState.mgckey || 'demo-key';
    html = html.replace('__MGCKEY__', mgckey);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  // GET /game — наш HTML с конфигом
  app.get('/game', (req, res) => {
    let html = fs.readFileSync(GAME_HTML, 'utf8');
    // Подставляем mgckey если есть
    const mgckey = gameState.mgckey || 'demo-key';
    html = html.replace('__MGCKEY__', mgckey);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  // CORS preflight
  app.options('/api/*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(200);
  });

  // POST /api/gameService — данные бота (спины + init)
  app.post('/api/gameService', (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const action = params.get('action') || '';
      console.log('[proxy] gameService action:', action);

      res.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (action.includes('Init')) {
        if (gameState.initData?.raw) return res.send(gameState.initData.raw);
        const now = Date.now();
        return res.send(`balance=100000.00&index=1&balance_cash=100000.00&balance_bonus=0.00&na=s&stime=${now}&sver=5&counter=1&ntp=0.00`);
      }

      if (gameState.lastSpin?.raw) return res.send(gameState.lastSpin.raw);
      res.send('tw=0.00&balance=100000.00&w=0.00&ntp=0.00');
    });
  });

  app.get('/api/gameService', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ status: 'ok' });
  });

  // Общая статика последней (после роутов)
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  
  console.log('[proxy] Static engine ready: /engine/*, /game, /api/gameService');
};
