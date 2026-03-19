'use strict';

module.exports = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>ReplayBet Live</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; }
#stream { max-width: 100%; max-height: 90vh; display: block; }
#status { color: #aaa; font-family: sans-serif; font-size: 12px; padding: 8px; position: fixed; top: 8px; right: 8px; background: rgba(0,0,0,0.7); border-radius: 4px; }
#overlay { color: #fff; font-family: sans-serif; font-size: 14px; padding: 8px; position: fixed; bottom: 8px; left: 8px; background: rgba(0,0,0,0.7); border-radius: 4px; }
</style>
</head>
<body>
<img id="stream" src="/frame" alt="Loading...">
<div id="status">Подключение...</div>
<div id="overlay"></div>
<script>
const img = document.getElementById('stream');
const status = document.getElementById('status');
const overlay = document.getElementById('overlay');
let fps = 0, frameCount = 0, lastFpsTime = Date.now();

function connect() {
  const ws = new WebSocket('ws://' + location.host);
  ws.binaryType = 'blob';

  ws.onopen = () => { status.textContent = '🟢 Live'; };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'frame') {
      img.src = 'data:image/jpeg;base64,' + msg.data;
      frameCount++;
      const now = Date.now();
      if (now - lastFpsTime > 1000) {
        fps = frameCount;
        frameCount = 0;
        lastFpsTime = now;
        status.textContent = '🟢 Live — ' + fps + ' fps';
      }
    } else if (msg.type === 'spin') {
      overlay.textContent = 'Win: ' + (msg.win || 0) + ' | Balance: ' + (msg.balance || 0);
    }
  };

  ws.onclose = () => {
    status.textContent = '🔴 Reconnecting...';
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
</script>
</body>
</html>`;
