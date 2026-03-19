'use strict';

module.exports = function setupGameProxy(app, gameState) {
  // /game теперь редирект на observer
  app.get('/game', (req, res) => res.redirect('/view'));
  console.log('[proxy] Game proxy: /game -> /view');
};
