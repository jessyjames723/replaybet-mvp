'use strict';

module.exports = /* html */`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ReplayBet Live</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #0a0a0f; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: 'Segoe UI', sans-serif; overflow: hidden; }

#wrap { position: relative; width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; }
#stream { display: block; width: 100vw; height: 100vh; object-fit: contain; }

/* Статус-бар сверху */
#topbar {
  position: absolute; top: 0; left: 0; right: 0;
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 14px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.75), transparent);
  pointer-events: none;
}
#status-dot { width: 8px; height: 8px; border-radius: 50%; background: #f00; display: inline-block; margin-right: 6px; }
#status-dot.live { background: #0f0; box-shadow: 0 0 6px #0f0; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
#status-text { color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 1px; }
#fps-text { color: rgba(255,255,255,0.5); font-size: 11px; }

/* Нижний оверлей */
#bottombar {
  position: absolute; bottom: 0; left: 0; right: 0;
  padding: 12px 16px 14px;
  background: linear-gradient(to top, rgba(0,0,0,0.85), transparent);
  display: flex; justify-content: space-between; align-items: flex-end;
  pointer-events: none;
}

.stat { display: flex; flex-direction: column; align-items: center; }
.stat-label { color: rgba(255,255,255,0.5); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
.stat-value { color: #fff; font-size: 20px; font-weight: 700; }
.stat-value.gold { color: #ffd700; }
.stat-value.green { color: #4cff91; }

/* Win popup */
#win-popup {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%) scale(0);
  background: radial-gradient(ellipse at center, rgba(255,200,0,0.15), transparent 70%);
  border: 2px solid rgba(255,200,0,0.4);
  border-radius: 16px; padding: 18px 40px; text-align: center;
  transition: transform 0.2s cubic-bezier(0.34,1.56,0.64,1);
  pointer-events: none;
}
#win-popup.show { transform: translate(-50%,-50%) scale(1); }
#win-popup .win-label { color: rgba(255,200,0,0.8); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; }
#win-popup .win-amount { color: #ffd700; font-size: 42px; font-weight: 800; text-shadow: 0 0 20px rgba(255,200,0,0.6); }

/* Offline overlay */
#offline {
  position: absolute; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: #fff; gap: 12px; display: none;
}
#offline.show { display: flex; }
#offline .spinner { width: 32px; height: 32px; border: 3px solid rgba(255,255,255,0.2); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="wrap">
  <img id="stream" src="/frame" alt="">

  <!-- Top bar -->
  <div id="topbar">
    <div>
      <span id="status-dot"></span>
      <span id="status-text">CONNECTING</span>
    </div>
    <span id="fps-text">-- fps</span>
  </div>

  <!-- Bottom stats -->
  <div id="bottombar">
    <div class="stat">
      <div class="stat-label">Balance</div>
      <div class="stat-value gold" id="balance">--</div>
    </div>
    <div class="stat">
      <div class="stat-label">Last Win</div>
      <div class="stat-value green" id="last-win">--</div>
    </div>
    <div class="stat">
      <div class="stat-label">Spins</div>
      <div class="stat-value" id="spin-count">0</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Won</div>
      <div class="stat-value gold" id="total-won">0.00</div>
    </div>
  </div>

  <!-- Win popup -->
  <div id="win-popup">
    <div class="win-label">Win!</div>
    <div class="win-amount" id="win-amount">0.00</div>
  </div>

  <!-- Offline -->
  <div id="offline">
    <div class="spinner"></div>
    <div>Reconnecting...</div>
  </div>
</div>

<script>
const img = document.getElementById('stream');
const dot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const fpsEl = document.getElementById('fps-text');
const balanceEl = document.getElementById('balance');
const lastWinEl = document.getElementById('last-win');
const spinCountEl = document.getElementById('spin-count');
const totalWonEl = document.getElementById('total-won');
const winPopup = document.getElementById('win-popup');
const winAmountEl = document.getElementById('win-amount');
const offlineEl = document.getElementById('offline');

let fps = 0, frameCount = 0, lastFpsTime = Date.now();
let totalWon = 0, spinCount = 0;
let winTimer = null;

function showWin(amount) {
  if (amount <= 0) return;
  winAmountEl.textContent = amount.toFixed(2);
  winPopup.classList.add('show');
  clearTimeout(winTimer);
  winTimer = setTimeout(() => winPopup.classList.remove('show'), 2500);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => {
    dot.classList.add('live');
    statusText.textContent = 'LIVE';
    offlineEl.classList.remove('show');
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'frame') {
      img.src = 'data:image/jpeg;base64,' + msg.data;
      frameCount++;
      const now = Date.now();
      if (now - lastFpsTime >= 1000) {
        fps = Math.round(frameCount * 1000 / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
        fpsEl.textContent = fps + ' fps';
      }
    }

    if (msg.type === 'spin') {
      const win = parseFloat(msg.win) || 0;
      const balance = parseFloat(msg.balance) || 0;
      spinCount++;
      totalWon += win;

      if (balance > 0) balanceEl.textContent = balance.toFixed(2);
      lastWinEl.textContent = win > 0 ? win.toFixed(2) : '0.00';
      lastWinEl.style.color = win > 0 ? '#4cff91' : 'rgba(255,255,255,0.4)';
      spinCountEl.textContent = spinCount;
      totalWonEl.textContent = totalWon.toFixed(2);

      if (win > 0) showWin(win);
    }

    if (msg.type === 'bot_status') {
      if (msg.status === 'offline') {
        dot.classList.remove('live');
        statusText.textContent = 'BOT OFFLINE';
      }
    }
  };

  ws.onclose = () => {
    dot.classList.remove('live');
    statusText.textContent = 'RECONNECTING';
    offlineEl.classList.add('show');
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
</script>
</body>
</html>
`;
