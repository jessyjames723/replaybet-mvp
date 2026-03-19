# ReplayBet Observer — Техническая спецификация MVP

**Версия:** 1.0  
**Дата:** 2026-03-19  
**Статус:** Draft / Pre-development  

---

## 1. Обзор системы

ReplayBet Observer — система трансляции реального геймплея слота Sweet Bonanza 1000 (Pragmatic Play) зрителям. Бот играет на bitz.io, перехватывает HTTP-ответы слота, транслирует через WebSocket-сервер, а зрители видят настоящий визуальный движок Pragmatic с данными реального бота.

### Компоненты

| Компонент | Файл | Роль |
|-----------|------|------|
| Bot | `src/bot.js` | Playwright-агент, играет на bitz.io, отправляет game events |
| Server | `src/server.js` | WebSocket + HTTP хаб, хранит state, раздаёт события |
| Observer | `src/observer.js` | Playwright-агент, открывает observer.html, перехватывает API через `page.route()` |
| Observer Page | `public/observer.html` | UI для зрителей |
| (Service Worker) | `public/sw.js` | **НЕ используется для перехвата iframe** (см. п. 6) |

---

## 2. Форматы сообщений

### 2.1 Bot → Server (`POST /game-data`)

**Content-Type:** `application/json`

#### 2.1.1 Событие `spin` (обычный спин)

```json
{
  "type": "spin",
  "action": "doSpin",
  "raw": "tw=0.00&balance=99998.00&s=11,6,10,...&w=0.00&ntp=-2.00",
  "parsed": {
    "tw": 0.00,
    "balance": 99998.00,
    "s": [11,6,10,5,5,9,11,6,11,7,8,8,5,10,11,7,8,8,5,10,6,9,11,10,7,9,6,9,11,10],
    "w": 0.00,
    "ntp": -2.00,
    "fs_left": null,
    "bonus_win": null,
    "multipliers": null
  },
  "timestamp": 1742385600000
}
```

#### 2.1.2 Событие `spin` с бонусом (Free Spins)

```json
{
  "type": "spin",
  "action": "doSpin",
  "raw": "tw=120.00&balance=100118.00&s=5,5,5,...&w=120.00&ntp=118.00&fs_left=7&bonus_win=120.00",
  "parsed": {
    "tw": 120.00,
    "balance": 100118.00,
    "s": [5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5],
    "w": 120.00,
    "ntp": 118.00,
    "fs_left": 7,
    "bonus_win": 120.00,
    "multipliers": [2, 5, 10]
  },
  "timestamp": 1742385610000
}
```

#### 2.1.3 Событие `init` (doInit)

```json
{
  "type": "init",
  "action": "doInit",
  "raw": "def_s=11,6,10,...&reel_set0=...&sc=0.20,0.40,...",
  "parsed": {
    "def_s": [11,6,10,5,5,9,11,6,11,7,8,8,5,10,11,7,8,8,5,10,6,9,11,10,7,9,6,9,11,10],
    "reel_set0": "...",
    "sc": [0.20, 0.40, 0.60, 1.00, 2.00],
    "paytable": "..."
  },
  "timestamp": 1742385580000
}
```

**Правила парсинга `s`:**
- Строка из 30 чисел, разделённых запятыми
- Позиции: 6 строк × 5 барабанов = 30 значений
- Layout: `[col0row0, col0row1, col0row2, col0row3, col0row4, col0row5, col1row0, ...]`
- Тип: integer (0..N)

**Правила парсинга числовых полей:**
- `tw`, `balance`, `w`, `ntp`, `bonus_win` → float, parseFloat()
- `fs_left` → integer или null (если поле отсутствует в raw)
- `multipliers` → array of integers или null

---

### 2.2 Server → Observer WebSocket Events

**Протокол:** WebSocket, JSON-encoded messages  
**Порт:** 3001

#### 2.2.1 Event `spin`

```json
{
  "type": "spin",
  "reels": [11,6,10,5,5,9,11,6,11,7,8,8,5,10,11,7,8,8,5,10,6,9,11,10,7,9,6,9,11,10],
  "win": 0.00,
  "totalWin": 0.00,
  "balance": 99998.00,
  "ntp": -2.00,
  "fsLeft": null,
  "bonusWin": null,
  "multipliers": null,
  "timestamp": 1742385600000
}
```

#### 2.2.2 Event `init`

```json
{
  "type": "init",
  "defReels": [11,6,10,5,5,9,11,6,11,7,8,8,5,10,11,7,8,8,5,10,6,9,11,10,7,9,6,9,11,10],
  "reelSet": "...",
  "stakes": [0.20, 0.40, 0.60, 1.00, 2.00],
  "paytable": "...",
  "timestamp": 1742385580000
}
```

#### 2.2.3 Event `status`

Отправляется при изменении состояния бота.

```json
{
  "type": "status",
  "botStatus": "online",
  "lastSeen": 1742385600000,
  "message": "Bot connected"
}
```

Возможные значения `botStatus`:
- `"online"` — бот активен, данные свежие
- `"offline"` — бот отвалился (нет данных > 30 сек)
- `"initializing"` — бот подключился, ждёт doInit
- `"bonus"` — идут Free Spins

#### 2.2.4 Event `error`

```json
{
  "type": "error",
  "code": "NO_DATA",
  "message": "No game data available yet"
}
```

Коды ошибок:
- `NO_DATA` — сервер ещё не получил ни одного спина
- `BOT_OFFLINE` — бот не отвечает > 30 сек
- `PARSE_ERROR` — не удалось распарсить ответ игры

---

### 2.3 Observer → Server (WebSocket upstream)

Observer — только потребитель. Upstream-сообщений нет, кроме:

```json
{
  "type": "ping"
}
```

Ответ сервера:
```json
{
  "type": "pong",
  "serverTime": 1742385600000
}
```

---

### 2.4 REST API Server

#### `POST /game-data`

Принимает данные от бота.

**Request:**
```
Content-Type: application/json
Body: { см. п. 2.1 }
```

**Response 200:**
```json
{ "ok": true }
```

**Response 400:**
```json
{ "ok": false, "error": "Missing required field: type" }
```

**Response 401:**
```json
{ "ok": false, "error": "Unauthorized" }
```

> ⚠️ Аутентификация: Bot передаёт секретный токен в заголовке `X-Bot-Token: <SECRET>`. Сервер проверяет. Токен задаётся через env `BOT_SECRET`.

#### `GET /game-state`

Возвращает текущее состояние игры (snapshot).

**Response 200:**
```json
{
  "botStatus": "online",
  "lastSpin": {
    "reels": [...],
    "win": 0.00,
    "totalWin": 0.00,
    "balance": 99998.00,
    "ntp": -2.00,
    "fsLeft": null,
    "bonusWin": null,
    "multipliers": null,
    "timestamp": 1742385600000
  },
  "initData": {
    "defReels": [...],
    "reelSet": "...",
    "stakes": [...],
    "paytable": "..."
  },
  "connectedObservers": 3,
  "serverTime": 1742385605000
}
```

**Response 200 (нет данных):**
```json
{
  "botStatus": "offline",
  "lastSpin": null,
  "initData": null,
  "connectedObservers": 0,
  "serverTime": 1742385605000
}
```

#### `GET /health`

```json
{ "status": "ok", "uptime": 12345 }
```

---

## 3. Последовательность инициализации

```
┌─────────────────────────────────────────────────────────────────┐
│                     BOOT SEQUENCE                               │
└─────────────────────────────────────────────────────────────────┘

1. [Server] Запускается первым
   → HTTP на порту 3000 (static files)
   → WebSocket на порту 3001
   → State: { botStatus: "offline", lastSpin: null, initData: null }

2. [Bot] Playwright открывает bitz.io
   → page.route('**/ge/v4/gameService', handler)
   → Ждёт загрузки слота (timeout 30 сек, retryable)
   → Слот делает doInit автоматически при загрузке

3. [Bot] Перехватывает doInit ответ
   → Парсит initData
   → POST /game-data с type="init"
   → Server обновляет state.initData
   → Server broadcast event type="init" всем WS клиентам
   → Server устанавливает botStatus="initializing"

4. [Bot] Начинает делать спины
   → Каждые N секунд (configurable, default: 5 сек)
   → Перехватывает doSpin ответ
   → POST /game-data с type="spin"
   → Server обновляет state.lastSpin
   → Server broadcast event type="spin" всем WS клиентам
   → Server устанавливает botStatus="online"

5. [Observer] Playwright открывает observer.html
   → page.route('**/ge/v4/gameService', handler)
   → WebSocket подключается к ws://localhost:3001
   → Получает текущий state через GET /game-state
   → Ждёт WS events

6. [Observer] iframe Pragmatic загружается
   → Слот делает doInit запрос → перехватывается Playwright
   → Observer возвращает ответ из state.initData (proxied)
   → Слот инициализирован с правильными данными

7. [Observer] Слот делает doSpin
   → Перехватывается Playwright (page.route)
   → Observer возвращает данные из state.lastSpin
   → Слот анимирует барабаны с данными бота
   → UI overlay обновляется
```

---

## 4. Observer — механика перехвата запросов

### Проблема

Service Worker работает только в scope своего домена (localhost:3000). iframe загружает Pragmatic с `demogamesfree.mdvgprfxuu.net` — другой домен. SW **не может** перехватить запросы из iframe.

### Решение: Playwright `page.route()` в `src/observer.js`

`page.route()` работает на уровне браузерного процесса Chromium и перехватывает **все** сетевые запросы страницы, включая из iframe, независимо от домена.

### Алгоритм перехвата в observer.js

```
page.route('**ge/v4/gameService**', async (route, request) => {

  1. Читаем тело запроса → парсим action=?
  
  2. Если action === 'doInit':
     а. Получаем initData из state (уже есть от бота)
     б. Если initData есть → возвращаем route.fulfill({ body: initData.raw })
     в. Если нет → ждём до 10 сек (polling state), потом возвращаем ошибку или forward
  
  3. Если action === 'doSpin':
     а. Получаем lastSpin из state
     б. Если lastSpin есть → возвращаем route.fulfill({ body: lastSpin.raw })
     в. Если нет → возвращаем route.fulfill({ body: generateFallbackSpin() })
     г. После fulfill → "потребляем" данные (помечаем как использованные)
  
  4. Если action неизвестен → route.continue() (forward оригинальный запрос)
})
```

### Синхронизация данных в observer.js

Observer хранит локальный state, обновляемый по двум каналам:

```
state = {
  initData: null,      // от WS event type="init"
  lastSpin: null,      // от WS event type="spin"
  pendingSpin: null,   // spin, ожидающий consume
  botStatus: "offline"
}
```

**При получении WS event `spin`:**
- `state.lastSpin = event`
- `state.pendingSpin = event` (следующий doSpin-перехват использует его)

**При перехвате doSpin:**
- Берём `state.pendingSpin ?? state.lastSpin`
- Возвращаем `raw` из него
- Сбрасываем `state.pendingSpin = null`

> Это гарантирует, что каждый спин слота соответствует одному спину бота.

### Формат ответа route.fulfill()

```javascript
route.fulfill({
  status: 200,
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Access-Control-Allow-Origin': '*'
  },
  body: rawResponseString   // оригинальная строка вида tw=0.00&balance=...
})
```

> ⚠️ Критично: `Content-Type` должен быть `application/x-www-form-urlencoded` — именно так отвечает Pragmatic API. Слот парсит тело через URLSearchParams.

---

## 5. Game State на сервере

```javascript
// Server internal state
const gameState = {
  botStatus: "offline",       // "offline" | "online" | "initializing" | "bonus"
  lastSeen: null,             // timestamp последнего POST /game-data
  lastSpin: null,             // объект последнего spin события
  initData: null,             // объект init события
  connectedObservers: 0,      // кол-во WS клиентов
  spinCount: 0,               // счётчик спинов с момента старта
};
```

### Watchdog (бот offline detection)

Сервер запускает таймер `setInterval(checkBotStatus, 5000)`:
- Если `Date.now() - gameState.lastSeen > 30000` И `botStatus !== "offline"`:
  - `gameState.botStatus = "offline"`
  - Broadcast event `{ type: "status", botStatus: "offline", ... }`

---

## 6. Service Worker (sw.js) — роль в MVP

В MVP `sw.js` **не используется для перехвата iframe** (ограничение браузера).

`sw.js` может быть использован для:
- Кэширования статики (observer.html, assets)
- Offline-заглушки для зрителей при разрыве соединения

Реальный перехват — только через `page.route()` в `src/observer.js`.

---

## 7. Конфигурация

Все параметры через environment variables:

| Переменная | Default | Описание |
|------------|---------|----------|
| `HTTP_PORT` | `3000` | HTTP порт сервера |
| `WS_PORT` | `3001` | WebSocket порт |
| `BOT_SECRET` | `changeme` | Токен аутентификации бота |
| `SPIN_INTERVAL_MS` | `5000` | Интервал между спинами бота (мс) |
| `BOT_OFFLINE_TIMEOUT_MS` | `30000` | Таймаут для объявления бота offline |
| `BITZ_URL` | `https://bitz.io/ru/games/sweet-bonanza-1000` | URL игры |
| `PRAGMATIC_IFRAME_URL` | `https://demogamesfree.mdvgprfxuu.net/gs2c/html5Game.do?...` | URL iframe |
| `SLOT_LOAD_TIMEOUT_MS` | `30000` | Таймаут ожидания загрузки слота |

---

## 8. Edge Cases

### 8.1 Бот отвалился (нет данных)

**Симптом:** `POST /game-data` не поступает > 30 сек  
**Детектор:** Server watchdog → botStatus = "offline"  
**Broadcast:** `{ type: "status", botStatus: "offline" }`  
**Observer реакция:**
- Overlay показывает "⚠️ Bot offline"
- Если слот делает doSpin → возвращаем `lastSpin.raw` (freeze last data)
- Слот продолжает "крутиться" с последними данными  
- Альтернатива: возвращаем `fallbackSpin` с `tw=0&w=0&ntp=-stake` (нейтральный проигрышный спин)

### 8.2 Observer подключился раньше бота

**Симптом:** `GET /game-state` возвращает `lastSpin: null, initData: null`  
**Observer реакция:**
- Overlay: "⏳ Waiting for bot..."
- page.route для doSpin → ждать (Promise с timeout 15 сек)
- page.route для doInit → ждать (Promise с timeout 30 сек)
- Если timeout → `route.continue()` (forward к реальному API, демо-режим)

### 8.3 doInit перехват — initData не готова

**Симптом:** iframe делает doInit, но сервер ещё не получил init от бота  
**Решение:** Observer делает polling `GET /game-state` каждые 500мс до 10 сек  
**Fallback:** `route.continue()` — слот инициализируется напрямую с Pragmatic (приемлемо)

### 8.4 Множественные doSpin без новых данных от бота

**Симптом:** Слот крутится быстрее, чем бот делает реальные спины  
**Решение:** Возвращаем `lastSpin.raw` для каждого запроса (последние данные)  
**Ограничение:** Зрители увидят "застывший" результат пока не придёт новый спин  
**Примечание:** Слот Pragmatic сам управляет анимацией, данные нужны только в момент запроса

### 8.5 Бонус (Free Spins)

**Симптом:** В ответе появились `fs_left`, `bonus_win`  
**Bot реакция:** Парсит дополнительные поля, включает в parsed  
**Server реакция:** `botStatus = "bonus"`, broadcast `type="spin"` с fsLeft, bonusWin  
**Observer реакция:** Overlay показывает "🎰 BONUS! Free Spins Left: N"  
**Важно:** `doInit` во время бонуса не вызывается — только `doSpin` с `fs_left`

### 8.6 Переподключение бота после падения

**Бот рестартует:**
1. Playwright открывает bitz.io заново
2. Слот делает новый doInit
3. Бот отправляет `type="init"` на сервер
4. Сервер обновляет initData, broadcast event
5. botStatus → "initializing"
6. После первого спина → "online"

### 8.7 WebSocket разрыв у Observer

**Симптом:** WS соединение observer.js → server потеряно  
**Observer реакция:**
- Reconnect с экспоненциальным backoff: 1s → 2s → 4s → 8s → max 30s
- При reconnect: GET /game-state для получения актуального snapshot
- Overlay: "🔄 Reconnecting..."

### 8.8 Прокси-запрос к Pragmatic возвращает ошибку

**Симптом:** route.continue() для doInit возвращает ошибку от Pragmatic  
**Fallback:** Вернуть пустой доInit-ответ с минимальными полями  
**Минимальный doInit ответ:**
```
def_s=1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1&sc=1.00&error=0
```

---

## 9. Структура файлов (финальная)

```
replaybet-mvp/
├── src/
│   ├── bot.js          # Playwright бот (bitz.io)
│   ├── server.js       # Express HTTP + WS сервер
│   └── observer.js     # Playwright observer (page.route)
├── public/
│   ├── observer.html   # UI для зрителей (overlay, статус)
│   └── sw.js           # Service Worker (только кэш статики)
├── package.json
├── .env.example
└── README.md
```

> ⚠️ В архитектуре добавлен `src/observer.js` (Playwright для observer), которого не было в исходном описании — это обязательный компонент из-за ограничения Service Worker.

---

## 10. Порядок запуска

```bash
# 1. Сначала сервер
node src/server.js

# 2. Потом бот (в отдельном процессе)
node src/bot.js

# 3. Observer (в отдельном процессе или после бота)
node src/observer.js
```

Или через `package.json` scripts:
```json
{
  "scripts": {
    "server": "node src/server.js",
    "bot": "node src/bot.js",
    "observer": "node src/observer.js",
    "dev": "concurrently \"npm run server\" \"npm run bot\" \"npm run observer\""
  }
}
```

---

## 11. Зависимости (package.json)

```json
{
  "dependencies": {
    "playwright": "^1.40.0",
    "ws": "^8.16.0",
    "express": "^4.18.0",
    "dotenv": "^16.0.0",
    "concurrently": "^8.0.0"
  }
}
```

---

## 12. ⛔ Hard Stop — подтвердить перед разработкой

Следующие вопросы требуют ответа до написания кода:

### 12.1 Правовой статус

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> Перехват и трансляция геймплея bitz.io может нарушать ToS площадки.  
> Pragmatic Play защищает свои активы авторским правом.  
> Вопрос: Есть ли юридическое заключение или согласование с bitz.io / Pragmatic?

### 12.2 Аутентификация на bitz.io

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> Как бот авторизуется на bitz.io?  
> - Учётные данные (email/password)?  
> - Уже залогиненный browser profile (persistent context)?  
> - Anon demo режим без авторизации?  
>   
> Это влияет на реализацию bot.js и на то, нужен ли `userDataDir` в Playwright.

### 12.3 Версия слота и стабильность API

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> URL `demogamesfree.mdvgprfxuu.net` — это demo endpoint Pragmatic.  
> Вопрос: Это тот же endpoint, что использует bitz.io в production?  
> Если bitz.io использует другой subdomain — observer iframe будет загружать другой экземпляр,  
> и `page.route()` должен матчить правильный URL.

### 12.4 CORS и заголовки Pragmatic API

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> При `route.fulfill()` возвращаем данные от бота.  
> Слот может проверять дополнительные поля в ответе (hmac, session token, timestamp).  
> Вопрос: Был ли протестирован полный цикл (doInit + doSpin через подменённые данные)?  
> Нужно убедиться, что слот не падает с ошибкой при кастомном ответе.

### 12.5 Как бот делает спины на bitz.io?

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> Бот нажимает кнопку Spin через Playwright click()?  
> Или вызывает API напрямую через `page.evaluate()`?  
>   
> Вариант через click:  
> - Нужен selector кнопки Spin  
> - Нужно ждать анимации барабанов (~3 сек) перед следующим спином  
>   
> Вариант через evaluate:  
> - Быстрее, но может потребовать reverse engineering JS слота  
> - Риск детекта как бот

### 12.6 Observer — один инстанс или много?

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> `src/observer.js` запускает один Playwright браузер и делает `page.route()`.  
> Это один observer для всех зрителей или каждый зритель — отдельный Playwright?  
>   
> Если один (серверный observer) → зрители видят iframe через `observer.html` в своём браузере  
> без Playwright (нужен другой механизм перехвата для зрительского браузера).  
>   
> Если каждый зритель — отдельный Playwright → масштабирование дорогое.  
>   
> **Рекомендация:** Один серверный observer.js + зрители через браузер со своим `page.route()`  
> или через iframe, который проксируется через наш сервер.

### 12.7 Staking механика

> **[ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ]**  
> В описании сказано "зрители делают ставки на мультипликатор".  
> Это входит в MVP или выходит за скоп?  
> Если входит — нужен дополнительный betting API, который не описан в этой спецификации.

---

## Приложение A: Пример сырого ответа Pragmatic

### doSpin (обычный проигрыш):
```
tw=0.00&balance=99998.00&s=11,6,10,5,5,9,11,6,11,7,8,8,5,10,11,7,8,8,5,10,6,9,11,10,7,9,6,9,11,10&w=0.00&ntp=-2.00
```

### doSpin (выигрыш):
```
tw=10.00&balance=100006.00&s=5,5,5,10,9,6,5,5,5,8,7,6,5,5,5,11,9,8,5,5,5,10,6,9,5,5,5,10,7,6&w=10.00&ntp=8.00
```

### doSpin (Free Spins):
```
tw=120.00&balance=100118.00&s=5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5&w=120.00&ntp=118.00&fs_left=7&bonus_win=120.00&m=2,5,10
```

---

## Приложение B: Схема потоков данных

```
bitz.io слот
    │
    │ HTTP POST ge/v4/gameService (реальный)
    ▼
[Playwright Bot page.route()]
    │
    │ route.continue() → получаем реальный ответ
    │ Парсируем raw response
    │
    ▼
POST /game-data (HTTP, localhost:3000)
    │
    ▼
[Server]
    │─────── обновляет gameState
    │─────── broadcast WS event
    │
    ├──── WS event ──────────────────────────────► [Observer.js WS client]
    │                                                    │ обновляет local state
    │                                                    │
    │                    iframe GET html5Game.do          │
    │                         ────────────►              │
    │                    Pragmatic доставляет HTML        │
    │                         ◄────────────             │
    │                                                    │
    │                    iframe POST ge/v4/gameService   │
    │                         ─────────────────────────► page.route() ──► route.fulfill(lastSpin.raw)
    │                         ◄─────────────────────────
    │                    Слот анимирует барабаны          │
    │                                                    │
    ▼                                                    ▼
[HTTP :3000]                                      [observer.html UI]
  раздаёт observer.html                             overlay: win/balance/status
```

---

*Спецификация готова к review. После подтверждения Hard Stop пунктов — старт разработки.*
