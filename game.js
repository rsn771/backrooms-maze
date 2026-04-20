import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import { getDatabase, get, onDisconnect, onValue, ref, runTransaction, update as updateData } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-database.js';

// BACKROOMS MAZE - Pixel Art TG Mini App Game

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tg = window.Telegram?.WebApp ?? null;
const lobbyOverlay = document.getElementById('lobbyOverlay');
const lobbyStatus = document.getElementById('lobbyStatus');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const soloBtn = document.getElementById('soloBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const roomShareBox = document.getElementById('roomShareBox');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const copyRoomLinkBtn = document.getElementById('copyRoomLinkBtn');
const playerRoster = document.getElementById('playerRoster');

const MAX_PLAYERS = 4;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_COLORS = ['#e66f5d', '#5fb0ff', '#7ce38b', '#d08cff'];

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseReady = false;
let firebaseDisabledReason = '';
let authReadyResolve;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });

const online = {
  enabled: false,
  roomId: '',
  roomSeed: 0,
  roomState: 'idle',
  joinLink: '',
  hostUid: '',
  localUid: '',
  localName: '',
  localColor: PLAYER_COLORS[0],
  players: {},
  roomListeners: [],
  syncTimer: 0,
  monsterSyncTimer: 0,
  monsterSnapshot: null,
  sharedPickedWaters: {},
  winState: null,
  safeFlags: {},
};

let fullscreenSupported = true;

function safeTgCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function getViewportHeight() {
  const telegramHeight = Math.round(tg?.viewportStableHeight || tg?.viewportHeight || 0);
  if (telegramHeight > 0) return telegramHeight;
  return Math.max(window.innerHeight, document.documentElement.clientHeight);
}

function setViewportVar(name, value) {
  document.documentElement.style.setProperty(name, `${Math.max(0, Math.round(value || 0))}px`);
}

function syncTelegramViewport() {
  const safeArea = tg?.contentSafeAreaInset || tg?.safeAreaInset || {};
  setViewportVar('--app-height', getViewportHeight());
  setViewportVar('--safe-top', safeArea.top);
  setViewportVar('--safe-right', safeArea.right);
  setViewportVar('--safe-bottom', safeArea.bottom);
  setViewportVar('--safe-left', safeArea.left);
  resize();
}

function requestTelegramFullscreen() {
  if (!tg) return;
  safeTgCall(() => tg.expand());
  safeTgCall(() => tg.disableVerticalSwipes?.());
  if (!fullscreenSupported || tg.isFullscreen) return;
  safeTgCall(() => tg.requestFullscreen?.());
}

function initTelegramWebApp() {
  syncTelegramViewport();

  if (!tg) {
    window.addEventListener('resize', syncTelegramViewport);
    window.addEventListener('orientationchange', syncTelegramViewport);
    return;
  }

  safeTgCall(() => tg.ready());
  safeTgCall(() => tg.setHeaderColor?.('#000000'));
  safeTgCall(() => tg.setBackgroundColor?.('#000000'));

  requestTelegramFullscreen();

  safeTgCall(() => tg.onEvent?.('viewportChanged', syncTelegramViewport));
  safeTgCall(() => tg.onEvent?.('safeAreaChanged', syncTelegramViewport));
  safeTgCall(() => tg.onEvent?.('contentSafeAreaChanged', syncTelegramViewport));
  safeTgCall(() => tg.onEvent?.('fullscreenChanged', syncTelegramViewport));
  safeTgCall(() => tg.onEvent?.('fullscreenFailed', ({ error } = {}) => {
    if (error === 'UNSUPPORTED') fullscreenSupported = false;
    syncTelegramViewport();
  }));
  safeTgCall(() => tg.onEvent?.('activated', () => {
    syncTelegramViewport();
    requestTelegramFullscreen();
  }));

  window.addEventListener('resize', syncTelegramViewport);
  window.addEventListener('orientationchange', () => {
    syncTelegramViewport();
    requestTelegramFullscreen();
  });
  document.addEventListener('pointerdown', requestTelegramFullscreen, { once: true, passive: true });
}

initTelegramWebApp();

function setLobbyStatus(text) {
  lobbyStatus.textContent = text;
}

function setOverlayVisible(visible) {
  lobbyOverlay.classList.toggle('hidden', !visible);
}

function sanitizeRoomCode(value) {
  return (value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function generateRoomCode() {
  let result = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) result += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  return result;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function colorForPlayer(id) {
  return PLAYER_COLORS[hashString(id) % PLAYER_COLORS.length];
}

function shortNameForPlayer(id) {
  return `P${(hashString(id) % 90) + 10}`;
}

function getRoomUrl(roomId = online.roomId) {
  const url = new URL(window.location.href);
  if (roomId) url.searchParams.set('room', roomId);
  else url.searchParams.delete('room');
  return url.toString();
}

function updateRoomShareUi() {
  const activeRoom = online.roomId || sanitizeRoomCode(roomCodeInput.value);
  if (!activeRoom) {
    roomShareBox.classList.add('hidden');
    roomCodeDisplay.textContent = '------';
    return;
  }
  roomShareBox.classList.remove('hidden');
  roomCodeDisplay.textContent = activeRoom;
}

function renderPlayerRoster() {
  const players = Object.values(online.players).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  if (!players.length) {
    playerRoster.textContent = online.enabled ? 'Waiting for players…' : '';
    return;
  }

  playerRoster.innerHTML = players.map(playerData => {
    const marker = playerData.uid === online.localUid ? ' (you)' : '';
    const crown = playerData.uid === online.hostUid ? ' [host]' : '';
    return `<div>${playerData.name || 'Explorer'}${marker}${crown}</div>`;
  }).join('');
}

async function loadFirebaseConfig() {
  try {
    const response = await fetch('/api/firebase-config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    return { enabled: false, reason: 'Firebase config route is unavailable.' };
  }
}

async function initFirebase() {
  const config = await loadFirebaseConfig();
  if (!config?.enabled) {
    firebaseDisabledReason = config?.reason || 'Firebase is not configured yet.';
    setLobbyStatus(`${firebaseDisabledReason} You can still start solo mode.`);
    return;
  }

  firebaseApp = initializeApp(config);
  firebaseAuth = getAuth(firebaseApp);
  firebaseDb = getDatabase(firebaseApp);

  onAuthStateChanged(firebaseAuth, user => {
    if (!user) return;
    online.localUid = user.uid;
    online.localName = shortNameForPlayer(user.uid);
    online.localColor = colorForPlayer(user.uid);
    firebaseReady = true;
    authReadyResolve(user);
    updateRoomShareUi();
    renderPlayerRoster();
    setLobbyStatus('Create a room or join one to start co-op.');
  });

  await signInAnonymously(firebaseAuth);
}

// ── Config ──────────────────────────────────────────────────────────────────
const CELL         = 64;  // pixels per maze cell
const COLS         = 75;  // maze width in cells
const ROWS         = 75;  // maze height in cells
const PLAYER_SPEED = 3.2; // pixels per frame
const WALL_T       = 8;   // wall thickness (top surface)
const WALL_FACE    = 16;  // visible front face height (2.5D effect)
const SCALE        = 1;
const PLAYER_START_CX = Math.floor(COLS / 2);
const PLAYER_START_CY = Math.floor(ROWS / 2);
const MONSTER_START_CX = 4;
const MONSTER_START_CY = 4;
const EXIT_CX = COLS - 2;
const EXIT_CY = ROWS - 2;

// ── Canvas sizing ────────────────────────────────────────────────────────────
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = getViewportHeight();
}
window.addEventListener('resize', () => { resize(); });
resize();

// ── Maze generation (recursive backtracker) ──────────────────────────────────
// Each cell stores which walls are OPEN (passage exists)
// Bits: 0=N, 1=E, 2=S, 3=W
let maze = new Uint8Array(COLS * ROWS); // 0 = all walls closed
let currentWorldSeed = 0;
let worldRandom = Math.random;

const DIR = [
  { dx: 0, dy: -1, bit: 0, opp: 2 }, // N
  { dx: 1, dy: 0,  bit: 1, opp: 3 }, // E
  { dx: 0, dy: 1,  bit: 2, opp: 0 }, // S
  { dx: -1, dy: 0, bit: 3, opp: 1 }, // W
];

function createSeededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cellIndex(cx, cy) {
  return cy * COLS + cx;
}

function inBounds(cx, cy) {
  return cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS;
}

function openPassage(cx, cy, bit) {
  if (!inBounds(cx, cy)) return;
  const d = DIR[bit];
  const nx = cx + d.dx;
  const ny = cy + d.dy;
  if (!inBounds(nx, ny)) return;
  maze[cellIndex(cx, cy)] |= 1 << d.bit;
  maze[cellIndex(nx, ny)] |= 1 << d.opp;
}

function openBetweenCells(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 1 && dy === 0) openPassage(ax, ay, 1);
  else if (dx === -1 && dy === 0) openPassage(ax, ay, 3);
  else if (dx === 0 && dy === 1) openPassage(ax, ay, 2);
  else if (dx === 0 && dy === -1) openPassage(ax, ay, 0);
}

function generateMaze() {
  const visited = new Uint8Array(COLS * ROWS);
  const stack = [];
  const start = { x: 1, y: 1 };
  visited[start.y * COLS + start.x] = 1;
  stack.push(start);

  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    // shuffle directions
    const dirs = DIR.slice().sort(() => worldRandom() - 0.5);
    let moved = false;
    for (const d of dirs) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      if (visited[ny * COLS + nx]) continue;
      // carve passage
      maze[cur.y * COLS + cur.x] |= (1 << d.bit);
      maze[ny  * COLS + nx]      |= (1 << d.opp);
      visited[ny * COLS + nx] = 1;
      stack.push({ x: nx, y: ny });
      moved = true;
      break;
    }
    if (!moved) stack.pop();
  }

  // Add extra loops so the maze feels more open / backrooms-like
  for (let i = 0; i < COLS * ROWS * 0.15; i++) {
    const x = 1 + Math.floor(worldRandom() * (COLS - 2));
    const y = 1 + Math.floor(worldRandom() * (ROWS - 2));
    const d = DIR[Math.floor(worldRandom() * 4)];
    const nx = x + d.dx, ny = y + d.dy;
    if (nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS) {
      maze[y * COLS + x] |= (1 << d.bit);
      maze[ny * COLS + nx] |= (1 << d.opp);
    }
  }
}

// ── Precompute tile textures ─────────────────────────────────────────────────
// Floor tile — carpet pattern
const floorCanvas = document.createElement('canvas');
floorCanvas.width = floorCanvas.height = CELL;
const fctx = floorCanvas.getContext('2d');
(function buildFloor() {
  fctx.fillStyle = '#8a7a3e';
  fctx.fillRect(0, 0, CELL, CELL);
  // carpet weave dots
  for (let py = 0; py < CELL; py += 4) {
    for (let px = 0; px < CELL; px += 4) {
      const v = ((px + py) % 8 === 0) ? 20 : -10;
      fctx.fillStyle = `rgba(0,0,0,${Math.abs(v) / 255})`;
      if (v > 0) fctx.fillStyle = `rgba(255,220,100,${v/255})`;
      fctx.fillRect(px, py, 2, 2);
    }
  }
  // subtle noise
  for (let i = 0; i < 80; i++) {
    fctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`;
    fctx.fillRect(Math.random() * CELL, Math.random() * CELL, 1, 1);
  }
})();

// Wall tile — drywall / yellowed wallpaper
const wallCanvas = document.createElement('canvas');
wallCanvas.width = wallCanvas.height = CELL;
const wctx = wallCanvas.getContext('2d');
(function buildWall() {
  wctx.fillStyle = '#c8b96a';
  wctx.fillRect(0, 0, CELL, CELL);
  // horizontal lines (paneling)
  for (let py = 0; py < CELL; py += 8) {
    wctx.fillStyle = `rgba(0,0,0,0.12)`;
    wctx.fillRect(0, py, CELL, 1);
  }
  // vertical lines
  for (let px = 0; px < CELL; px += 8) {
    wctx.fillStyle = `rgba(0,0,0,0.07)`;
    wctx.fillRect(px, 0, 1, CELL);
  }
  // stain patches
  for (let i = 0; i < 4; i++) {
    wctx.fillStyle = `rgba(100,80,20,${Math.random() * 0.12})`;
    const sw = 4 + Math.random() * 8;
    const sh = 2 + Math.random() * 6;
    wctx.fillRect(Math.random() * CELL, Math.random() * CELL, sw, sh);
  }
})();

// Wall face tile — darker front surface with vertical paneling
const faceCanvas = document.createElement('canvas');
faceCanvas.width = CELL;
faceCanvas.height = WALL_FACE;
(function buildFace() {
  const fc = faceCanvas.getContext('2d');
  // base gradient: lighter top, darker bottom (depth)
  const grad = fc.createLinearGradient(0, 0, 0, WALL_FACE);
  grad.addColorStop(0,   '#b09040');
  grad.addColorStop(0.5, '#8a7030');
  grad.addColorStop(1,   '#3a2c0a');
  fc.fillStyle = grad;
  fc.fillRect(0, 0, CELL, WALL_FACE);
  // vertical paneling lines
  for (let px = 0; px < CELL; px += 16) {
    fc.fillStyle = 'rgba(0,0,0,0.18)';
    fc.fillRect(px, 0, 1, WALL_FACE);
  }
  // horizontal highlight at very top (where top meets face)
  fc.fillStyle = 'rgba(255,230,120,0.35)';
  fc.fillRect(0, 0, CELL, 2);
  // stains
  for (let i = 0; i < 6; i++) {
    fc.fillStyle = `rgba(60,40,0,${Math.random() * 0.15})`;
    fc.fillRect(Math.random() * CELL, Math.random() * WALL_FACE, 3 + Math.random() * 10, 2);
  }
})();

// ── TV-static noise texture (pre-baked, tiled at render time) ────────────────
const NOISE_SIZE = 256;
const noiseCanvas = document.createElement('canvas');
noiseCanvas.width = noiseCanvas.height = NOISE_SIZE;
(function buildNoise() {
  const nc  = noiseCanvas.getContext('2d');
  const img = nc.createImageData(NOISE_SIZE, NOISE_SIZE);
  const d   = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v  = Math.floor(Math.random() * 200);
    d[i]     = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = Math.floor(Math.random() * 255);
  }
  nc.putImageData(img, 0, 0);
})();

// ── Player sprite (pixel art man) ────────────────────────────────────────────
const SPRITE_W = 14, SPRITE_H = 20;
const spriteCanvas = document.createElement('canvas');
spriteCanvas.width = SPRITE_W * 4; // 4 frames
spriteCanvas.height = SPRITE_H;
const sctx = spriteCanvas.getContext('2d');

function drawSprite(frame, flipX) {
  // head
  const sx = frame * SPRITE_W;
  const sc = sctx;
  sc.clearRect(sx, 0, SPRITE_W, SPRITE_H);
  // skin
  sc.fillStyle = '#f5c8a0';
  sc.fillRect(sx + 4, 0, 6, 6); // head
  // eyes
  sc.fillStyle = '#1a1208';
  sc.fillRect(sx + 5, 1, 1, 1);
  sc.fillRect(sx + 8, 1, 1, 1);
  // shirt (yellowish uniform)
  sc.fillStyle = '#b0a04a';
  sc.fillRect(sx + 3, 6, 8, 7); // torso
  // pants
  sc.fillStyle = '#6b5c2a';
  const legPhase = frame % 2;
  sc.fillRect(sx + 3, 13, 3, 7 - legPhase); // L leg
  sc.fillRect(sx + 8, 13, 3, 5 + legPhase); // R leg
  // shoes
  sc.fillStyle = '#2a1f0a';
  sc.fillRect(sx + 2, 18 + (legPhase ? 1 : 0), 4, 2);
  sc.fillRect(sx + 8, 18 + (legPhase ? 0 : 1), 4, 2);
  // arms
  sc.fillStyle = '#b0a04a';
  const armSwing = legPhase;
  sc.fillRect(sx + 1, 7 + armSwing, 2, 5);
  sc.fillRect(sx + 11, 7 + (1 - armSwing), 2, 5);
}
// Build 4 walk frames
for (let f = 0; f < 4; f++) drawSprite(f, false);

// ── Game state ────────────────────────────────────────────────────────────────
const player = {
  x: PLAYER_START_CX * CELL + CELL / 2,
  y: PLAYER_START_CY * CELL + CELL / 2,
  vx: 0,
  vy: 0,
  frame: 0,
  frameTimer: 0,
  facing: 1, // 1=right, -1=left
  moving: false,
};

const cam = { x: 0, y: 0 };

// Exit is near bottom-right corner
const EXIT = {
  x: EXIT_CX * CELL + CELL / 2,
  y: EXIT_CY * CELL + CELL / 2,
};

// ── Safe rooms ───────────────────────────────────────────────────────────────
const SAFE_ROOM_COUNT = 5;
const SAFE_ROOM_SIZE = 3;
const SAFE_ROOM_GAP = 6;
const SAFE_ROOM_REPEL_DISTANCE = 18 * CELL;
let safeCells = new Uint8Array(COLS * ROWS);
let safeRooms = [];

function isSafeCell(cx, cy) {
  return inBounds(cx, cy) && safeCells[cellIndex(cx, cy)] === 1;
}

function rectTooClose(ax, ay, aw, ah, bx, by, bw, bh, gap) {
  return !(
    ax + aw - 1 + gap < bx ||
    bx + bw - 1 + gap < ax ||
    ay + ah - 1 + gap < by ||
    by + bh - 1 + gap < ay
  );
}

function carveSafeRoom(x, y, w, h) {
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      safeCells[cellIndex(cx, cy)] = 1;
      if (cx + 1 < x + w) openBetweenCells(cx, cy, cx + 1, cy);
      if (cy + 1 < y + h) openBetweenCells(cx, cy, cx, cy + 1);
    }
  }

  const doorCandidates = [];
  for (let cx = x; cx < x + w; cx++) {
    doorCandidates.push({ cx, cy: y, bit: 0 });
    doorCandidates.push({ cx, cy: y + h - 1, bit: 2 });
  }
  for (let cy = y; cy < y + h; cy++) {
    doorCandidates.push({ cx: x, cy, bit: 3 });
    doorCandidates.push({ cx: x + w - 1, cy, bit: 1 });
  }

  for (let i = doorCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(worldRandom() * (i + 1));
    [doorCandidates[i], doorCandidates[j]] = [doorCandidates[j], doorCandidates[i]];
  }

  const usedSides = new Set();
  let opened = 0;
  for (const door of doorCandidates) {
    const sideKey = door.bit;
    const d = DIR[door.bit];
    const nx = door.cx + d.dx;
    const ny = door.cy + d.dy;
    if (!inBounds(nx, ny)) continue;
    if (isSafeCell(nx, ny) || usedSides.has(sideKey)) continue;
    openPassage(door.cx, door.cy, door.bit);
    usedSides.add(sideKey);
    opened++;
    if (opened >= 2) break;
  }

  safeRooms.push({
    x,
    y,
    w,
    h,
    centerCX: x + ((w - 1) >> 1),
    centerCY: y + ((h - 1) >> 1),
  });
}

function generateSafeRooms() {
  let attempts = 0;
  while (safeRooms.length < SAFE_ROOM_COUNT && attempts < 600) {
    attempts++;
    const x = 2 + Math.floor(worldRandom() * (COLS - SAFE_ROOM_SIZE - 4));
    const y = 2 + Math.floor(worldRandom() * (ROWS - SAFE_ROOM_SIZE - 4));
    const centerCX = x + ((SAFE_ROOM_SIZE - 1) >> 1);
    const centerCY = y + ((SAFE_ROOM_SIZE - 1) >> 1);

    const playerDist = Math.hypot(centerCX - PLAYER_START_CX, centerCY - PLAYER_START_CY);
    const exitDist = Math.hypot(centerCX - EXIT_CX, centerCY - EXIT_CY);
    const monsterDist = Math.hypot(centerCX - MONSTER_START_CX, centerCY - MONSTER_START_CY);
    if (playerDist < 10 || exitDist < 8 || monsterDist < 8) continue;

    let overlaps = false;
    for (const room of safeRooms) {
      if (rectTooClose(x, y, SAFE_ROOM_SIZE, SAFE_ROOM_SIZE, room.x, room.y, room.w, room.h, SAFE_ROOM_GAP)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    carveSafeRoom(x, y, SAFE_ROOM_SIZE, SAFE_ROOM_SIZE);
  }
}

// ── Almond water ──────────────────────────────────────────────────────────────
const ALMOND_COUNT  = 80;
const BOOST_MULT    = 1.7;
const BOOST_SECONDS = 10;
let   speedBoostLeft = 0;

let almondWaters = [];
function spawnAlmondWaters() {
  almondWaters = [];
  const pool = [];
  for (let cy = 2; cy < ROWS - 2; cy++)
    for (let cx = 2; cx < COLS - 2; cx++)
      if (maze[cellIndex(cx, cy)] > 0 && !isSafeCell(cx, cy)) pool.push({ cx, cy });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(worldRandom() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  for (let i = 0; i < Math.min(ALMOND_COUNT, pool.length); i++) {
    almondWaters.push({
      x: pool[i].cx * CELL + CELL / 2,
      y: pool[i].cy * CELL + CELL / 2,
      bob: worldRandom() * Math.PI * 2,
      picked: false,
    });
  }
}

function initializeWorld(seed) {
  currentWorldSeed = (seed >>> 0) || hashString(`world:${Date.now()}`);
  worldRandom = createSeededRandom(currentWorldSeed);
  maze = new Uint8Array(COLS * ROWS);
  safeCells = new Uint8Array(COLS * ROWS);
  safeRooms = [];
  almondWaters = [];

  generateMaze();

  maze[cellIndex(EXIT_CX, EXIT_CY)] |= 0b1111;
  maze[cellIndex(EXIT_CX, EXIT_CY - 1)] |= 0b1111;
  maze[cellIndex(EXIT_CX - 1, EXIT_CY)] |= 0b1111;

  generateSafeRooms();
  spawnAlmondWaters();
}

// ── Monster ───────────────────────────────────────────────────────────────────
const FEAR_RANGE          = 10 * CELL;
const MONSTER_DETECT_RANGE = 8.5 * CELL;
const MONSTER_LOSE_RANGE   = 14 * CELL;
const MONSTER_SPD_PATROL   = PLAYER_SPEED * 0.92;
const MONSTER_SPD_CHASE    = PLAYER_SPEED * 1.2;
const CATCH_DIST           = 26; // pixels — triggers death

const monster = {
  x: MONSTER_START_CX * CELL + CELL / 2,
  y: MONSTER_START_CY * CELL + CELL / 2,
  dx: 1, dy: 0,
  fearLevel: 0,
  isChasing: false,
  goalCX: MONSTER_START_CX,
  goalCY: MONSTER_START_CY,
  // BFS pathfinding
  pathTargetCX: -1,
  pathTargetCY: -1,
  pathRefreshTimer: 0,
};

// Death state
let playerDead  = false;
let deathTimer  = 0;
const DEATH_DURATION = 2.2; // seconds of red screen before restart

// Shake offset (render-only, not gameplay)
let shakeX = 0, shakeY = 0;

// ── BFS pathfinding ───────────────────────────────────────────────────────────
// Returns the first cell to step into on the shortest path from→to.
function bfsNextCell(fromCX, fromCY, toCX, toCY, { avoidSafeRooms = false } = {}) {
  if (fromCX === toCX && fromCY === toCY) return null;
  const size    = COLS * ROWS;
  const visited = new Uint8Array(size);
  const parent  = new Int32Array(size).fill(-1);
  const start   = cellIndex(fromCX, fromCY);
  const goal    = cellIndex(toCX, toCY);
  const queue   = [start];
  visited[start] = 1;

  while (queue.length) {
    const idx = queue.shift();
    if (idx === goal) break;
    const cx   = idx % COLS;
    const cy   = (idx / COLS) | 0;
    const bits = maze[cellIndex(cx, cy)];
    for (const d of DIR) {
      if (!(bits & (1 << d.bit))) continue;
      const nx = cx + d.dx, ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      if (avoidSafeRooms && isSafeCell(nx, ny) && (nx !== toCX || ny !== toCY)) continue;
      const ni = cellIndex(nx, ny);
      if (visited[ni]) continue;
      visited[ni] = 1;
      parent[ni]  = idx;
      queue.push(ni);
    }
  }

  if (parent[goal] === -1 && goal !== start) return null;

  // Trace back to find the first step from start
  let node = goal;
  while (parent[node] !== start) {
    const p = parent[node];
    if (p === -1) return null;
    node = p;
  }
  return { cx: node % COLS, cy: (node / COLS) | 0 };
}

function resetMonsterPath() {
  monster.pathTargetCX = -1;
  monster.pathTargetCY = -1;
  monster.pathRefreshTimer = 0;
}

function setMonsterGoal(cx, cy) {
  monster.goalCX = cx;
  monster.goalCY = cy;
  resetMonsterPath();
}

function monsterCanUseCell(cx, cy) {
  return inBounds(cx, cy) && !isSafeCell(cx, cy);
}

function chooseMonsterPatrolGoal(fromCX, fromCY) {
  let best = null;

  for (let attempt = 0; attempt < 140; attempt++) {
    const cx = 1 + Math.floor(Math.random() * (COLS - 2));
    const cy = 1 + Math.floor(Math.random() * (ROWS - 2));
    if (!monsterCanUseCell(cx, cy)) continue;
    const dist = Math.abs(cx - fromCX) + Math.abs(cy - fromCY);
    if (dist < 8) continue;
    const score = dist + Math.random() * 6;
    if (!best || score > best.score) best = { cx, cy, score };
  }

  if (best) return best;

  for (let cy = 1; cy < ROWS - 1; cy++) {
    for (let cx = 1; cx < COLS - 1; cx++) {
      if (!monsterCanUseCell(cx, cy)) continue;
      const dist = Math.abs(cx - fromCX) + Math.abs(cy - fromCY);
      if (!best || dist > best.score) best = { cx, cy, score: dist };
    }
  }

  return best || { cx: fromCX, cy: fromCY };
}

function refreshMonsterStep(fromCX, fromCY, toCX, toCY) {
  if (!monsterCanUseCell(toCX, toCY)) return false;
  const next = bfsNextCell(fromCX, fromCY, toCX, toCY, { avoidSafeRooms: true });
  if (!next) return false;
  monster.pathTargetCX = next.cx;
  monster.pathTargetCY = next.cy;
  return true;
}

function relocateMonsterAwayFromPlayer(playerCX, playerCY) {
  let best = null;

  for (let cy = 1; cy < ROWS - 1; cy++) {
    for (let cx = 1; cx < COLS - 1; cx++) {
      if (!monsterCanUseCell(cx, cy)) continue;
      const dist = Math.hypot(cx - playerCX, cy - playerCY);
      if (dist * CELL < SAFE_ROOM_REPEL_DISTANCE) continue;
      const score = dist + Math.random() * 0.25;
      if (!best || score > best.score) best = { cx, cy, score };
    }
  }

  if (!best) best = chooseMonsterPatrolGoal(playerCX, playerCY);

  monster.x = best.cx * CELL + CELL / 2;
  monster.y = best.cy * CELL + CELL / 2;
  monster.dx = 0;
  monster.dy = 0;
  monster.isChasing = false;

  const patrolGoal = chooseMonsterPatrolGoal(best.cx, best.cy);
  setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
}

// ── Restart ───────────────────────────────────────────────────────────────────
function restartGame({ resetSharedState = !online.enabled } = {}) {
  player.x = PLAYER_START_CX * CELL + CELL / 2;
  player.y = PLAYER_START_CY * CELL + CELL / 2;
  player.frame = 0;
  playerWasInSafeRoom = false;
  speedBoostLeft = 0;
  playerDead  = false;
  deathTimer  = 0;
  if (resetSharedState) {
    monster.x = MONSTER_START_CX * CELL + CELL / 2;
    monster.y = MONSTER_START_CY * CELL + CELL / 2;
    monster.dx = 1;
    monster.dy = 0;
    monster.fearLevel = 0;
    monster.isChasing = false;
    const patrolGoal = chooseMonsterPatrolGoal(MONSTER_START_CX, MONSTER_START_CY);
    setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
    startTime = Date.now();
    gameWon = false;
    for (const aw of almondWaters) aw.picked = false;
  }
}

function getLocalPlayerSnapshot() {
  const cx = (player.x / CELL) | 0;
  const cy = (player.y / CELL) | 0;
  return {
    uid: online.localUid,
    name: online.localName,
    color: online.localColor,
    joinedAt: online.players[online.localUid]?.joinedAt || Date.now(),
    x: Math.round(player.x),
    y: Math.round(player.y),
    facing: player.facing,
    frame: player.frame,
    moving: player.moving,
    alive: !playerDead,
    inSafeRoom: isSafeCell(cx, cy),
    boostUntil: speedBoostLeft > 0 ? Date.now() + Math.round(speedBoostLeft * 1000) : 0,
    lastUpdate: Date.now(),
  };
}

function applySharedStateToLocalWorld() {
  if (!online.enabled) return;
  const pickedIds = online.sharedPickedWaters || {};
  for (let i = 0; i < almondWaters.length; i++) {
    almondWaters[i].picked = pickedIds[i] === true;
  }

  if (!online.hostUid || online.hostUid !== online.localUid) {
    if (online.monsterSnapshot) {
      monster.x = online.monsterSnapshot.x ?? monster.x;
      monster.y = online.monsterSnapshot.y ?? monster.y;
      monster.dx = online.monsterSnapshot.dx ?? monster.dx;
      monster.dy = online.monsterSnapshot.dy ?? monster.dy;
      monster.fearLevel = online.monsterSnapshot.fearLevel ?? monster.fearLevel;
      monster.isChasing = !!online.monsterSnapshot.isChasing;
    }
  }

  if (online.winState?.won) {
    gameWon = true;
  }
}

function cleanupRoomListeners() {
  for (const unsubscribe of online.roomListeners) unsubscribe();
  online.roomListeners = [];
}

async function claimHostIfNeeded() {
  if (!online.enabled || !online.roomId || !online.localUid || !firebaseDb) return;
  const livePlayers = online.players;
  if (online.hostUid && livePlayers[online.hostUid]) return;

  const hostRef = ref(firebaseDb, `rooms/${online.roomId}/hostUid`);
  const result = await runTransaction(hostRef, current => {
    if (current && livePlayers[current]) return;
    return online.localUid;
  });

  if (result.committed && result.snapshot.val() === online.localUid) {
    online.hostUid = online.localUid;
    onDisconnect(hostRef).remove().catch(() => {});
    renderPlayerRoster();
  }
}

function bindRoomListeners(roomId) {
  cleanupRoomListeners();

  const metaRef = ref(firebaseDb, `rooms/${roomId}/meta`);
  const playersRef = ref(firebaseDb, `rooms/${roomId}/players`);
  const hostRef = ref(firebaseDb, `rooms/${roomId}/hostUid`);
  const sharedRef = ref(firebaseDb, `rooms/${roomId}/shared`);

  online.roomListeners.push(onValue(metaRef, snapshot => {
    const meta = snapshot.val();
    if (!meta) return;
    if (meta.seed && meta.seed !== online.roomSeed) {
      online.roomSeed = meta.seed >>> 0;
      initializeWorld(online.roomSeed);
      restartGame({ resetSharedState: true });
    }
  }));

  online.roomListeners.push(onValue(playersRef, snapshot => {
    online.players = snapshot.val() || {};
    renderPlayerRoster();
    claimHostIfNeeded().catch(() => {});
  }));

  online.roomListeners.push(onValue(hostRef, snapshot => {
    online.hostUid = snapshot.val() || '';
    renderPlayerRoster();
    claimHostIfNeeded().catch(() => {});
  }));

  online.roomListeners.push(onValue(sharedRef, snapshot => {
    const shared = snapshot.val() || {};
    online.monsterSnapshot = shared.monster || null;
    online.sharedPickedWaters = shared.pickedWaters || {};
    online.winState = shared.win || null;
    applySharedStateToLocalWorld();
  }));
}

async function joinRoom(roomId, { create = false } = {}) {
  roomId = sanitizeRoomCode(roomId);
  if (!roomId) {
    setLobbyStatus('Enter a valid room code.');
    return false;
  }
  if (!firebaseReady) {
    setLobbyStatus(firebaseDisabledReason || 'Co-op backend is not ready yet.');
    return false;
  }

  await authReady;

  setLobbyStatus(create ? 'Creating room…' : 'Joining room…');

  const metaRef = ref(firebaseDb, `rooms/${roomId}/meta`);
  const seed = hashString(`${roomId}:${Date.now()}:${online.localUid}`);

  if (create) {
    await runTransaction(metaRef, current => current || {
      seed,
      createdAt: Date.now(),
      maxPlayers: MAX_PLAYERS,
    });
  }

  const metaSnapshot = await get(metaRef);
  if (!metaSnapshot.exists()) {
    setLobbyStatus('Room not found.');
    return false;
  }

  const roomMeta = metaSnapshot.val();
  const playersRef = ref(firebaseDb, `rooms/${roomId}/players`);
  const joinedAt = Date.now();
  const joinResult = await runTransaction(playersRef, current => {
    current ||= {};
    if (!current[online.localUid] && Object.keys(current).length >= MAX_PLAYERS) return;
    const existing = current[online.localUid] || {};
    current[online.localUid] = {
      uid: online.localUid,
      name: existing.name || online.localName,
      color: existing.color || online.localColor,
      joinedAt: existing.joinedAt || joinedAt,
      x: existing.x ?? (PLAYER_START_CX * CELL + CELL / 2),
      y: existing.y ?? (PLAYER_START_CY * CELL + CELL / 2),
      facing: existing.facing ?? 1,
      frame: existing.frame ?? 0,
      moving: false,
      alive: existing.alive ?? true,
      inSafeRoom: existing.inSafeRoom ?? false,
      boostUntil: existing.boostUntil ?? 0,
      lastUpdate: Date.now(),
    };
    return current;
  });

  if (!joinResult.committed) {
    setLobbyStatus('Room is full. Max 4 players.');
    return false;
  }

  online.enabled = true;
  online.roomId = roomId;
  online.roomSeed = roomMeta.seed >>> 0;
  online.joinLink = getRoomUrl(roomId);
  online.sharedPickedWaters = {};
  online.monsterSnapshot = null;
  online.winState = null;
  online.safeFlags = {};

  updateRoomShareUi();
  roomCodeInput.value = roomId;
  window.history.replaceState({}, '', online.joinLink);

  const localPlayerRef = ref(firebaseDb, `rooms/${roomId}/players/${online.localUid}`);
  onDisconnect(localPlayerRef).remove().catch(() => {});

  bindRoomListeners(roomId);
  initializeWorld(online.roomSeed);
  restartGame({ resetSharedState: true });
  await claimHostIfNeeded();
  setOverlayVisible(false);
  setLobbyStatus(`Connected to room ${roomId}.`);
  return true;
}

async function syncLocalPlayerToRoom(force = false) {
  if (!online.enabled || !firebaseReady || !online.roomId || !online.localUid) return;
  if (!force && online.syncTimer > 0) return;
  online.syncTimer = 0.08;

  const snapshot = getLocalPlayerSnapshot();
  online.players[online.localUid] = snapshot;
  updateData(ref(firebaseDb, `rooms/${online.roomId}/players/${online.localUid}`), snapshot).catch(() => {});
}

function listAlivePlayersForMonster() {
  if (!online.enabled) {
    const cx = (player.x / CELL) | 0;
    const cy = (player.y / CELL) | 0;
    return [{
      uid: 'local',
      x: player.x,
      y: player.y,
      inSafeRoom: isSafeCell(cx, cy),
      alive: !playerDead,
    }];
  }

  const players = [];
  for (const [uid, playerData] of Object.entries(online.players)) {
    const isLocal = uid === online.localUid;
    const px = isLocal ? player.x : (playerData.x ?? PLAYER_START_CX * CELL + CELL / 2);
    const py = isLocal ? player.y : (playerData.y ?? PLAYER_START_CY * CELL + CELL / 2);
    const cx = (px / CELL) | 0;
    const cy = (py / CELL) | 0;
    players.push({
      uid,
      x: px,
      y: py,
      inSafeRoom: isLocal ? isSafeCell(cx, cy) : !!playerData.inSafeRoom,
      alive: isLocal ? !playerDead : playerData.alive !== false,
    });
  }
  return players;
}

function getNearestMonsterTarget(players) {
  let best = null;
  for (const candidate of players) {
    if (!candidate.alive || candidate.inSafeRoom) continue;
    const dist = Math.hypot(candidate.x - monster.x, candidate.y - monster.y);
    if (!best || dist < best.dist) best = { ...candidate, dist };
  }
  return best;
}

// ── Input ─────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => { keys[e.key] = true; });
window.addEventListener('keyup',   e => { keys[e.key] = false; });

// Joystick
const joystickBase  = document.getElementById('joystickBase');
const joystickKnob  = document.getElementById('joystickKnob');
const JOY_RADIUS    = 36; // max knob displacement
let joyActive = false;
let joyStartX = 0, joyStartY = 0;
let joyDX = 0, joyDY = 0;

function getJoyCenter() {
  const r = joystickBase.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function onJoyStart(cx, cy) {
  joyActive = true;
  joyStartX = cx;
  joyStartY = cy;
  joyDX = 0; joyDY = 0;
}
function onJoyMove(cx, cy) {
  if (!joyActive) return;
  let dx = cx - joyStartX;
  let dy = cy - joyStartY;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist > JOY_RADIUS) { dx *= JOY_RADIUS / dist; dy *= JOY_RADIUS / dist; }
  joyDX = dx / JOY_RADIUS;
  joyDY = dy / JOY_RADIUS;
  joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
}
function onJoyEnd() {
  joyActive = false;
  joyDX = 0; joyDY = 0;
  joystickKnob.style.transform = 'translate(0,0)';
}

// Pointer Events + setPointerCapture — работает и на тач и на мышь,
// захватывает указатель так что события приходят даже вне элемента
joystickBase.addEventListener('pointerdown', e => {
  e.preventDefault();
  joystickBase.setPointerCapture(e.pointerId);
  const r = joystickBase.getBoundingClientRect();
  joyStartX = r.left + r.width / 2;
  joyStartY = r.top + r.height / 2;
  joyActive = true;
  onJoyMove(e.clientX, e.clientY);
});

joystickBase.addEventListener('pointermove', e => {
  if (!joyActive) return;
  e.preventDefault();
  onJoyMove(e.clientX, e.clientY);
});

joystickBase.addEventListener('pointerup',     () => onJoyEnd());
joystickBase.addEventListener('pointercancel', () => onJoyEnd());

// ── Collision helpers ─────────────────────────────────────────────────────────
function cellPassable(cx, cy) {
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
  return true; // passability depends on wall bits tested per direction
}

// Returns true if the player box can occupy world position (px, py)
// Player box: 10x16 centered on feet
const PW = 10, PH = 16;

function isWall(wx, wy) {
  const cx = Math.floor(wx / CELL);
  const cy = Math.floor(wy / CELL);
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return true;
  // A cell is always passable internally; walls are on cell boundaries
  // We need to check if crossing from one cell to adjacent is allowed
  return false; // handled by swept collision below
}

// Check if a world point (wx,wy) is inside a wall segment.

function pointInWall(wx, wy) {
  if (wx < 0 || wy < 0 || wx >= COLS * CELL || wy >= ROWS * CELL) return true;
  const cx = Math.floor(wx / CELL);
  const cy = Math.floor(wy / CELL);
  const lx = wx - cx * CELL; // local x within cell
  const ly = wy - cy * CELL;

  // Check each wall face
  // North wall: ly < WALL_T and no N passage
  if (ly < WALL_T && !(maze[cy * COLS + cx] & (1 << 0))) return true;
  // South wall: ly > CELL-WALL_T and no S passage
  if (ly > CELL - WALL_T && !(maze[cy * COLS + cx] & (1 << 2))) return true;
  // West wall: lx < WALL_T and no W passage
  if (lx < WALL_T && !(maze[cy * COLS + cx] & (1 << 3))) return true;
  // East wall: lx > CELL-WALL_T and no E passage
  if (lx > CELL - WALL_T && !(maze[cy * COLS + cx] & (1 << 1))) return true;

  return false;
}

function collides(px, py) {
  const hw = PW / 2;
  return (
    pointInWall(px - hw, py - PH) ||
    pointInWall(px + hw, py - PH) ||
    pointInWall(px - hw, py) ||
    pointInWall(px + hw, py)
  );
}

// ── Lighting / flicker ────────────────────────────────────────────────────────
let flickerAlpha = 0;
let flickerTimer = 0;
let nextFlicker  = 3 + Math.random() * 8;

// ── Timer ─────────────────────────────────────────────────────────────────────
let startTime = Date.now();
let gameWon = false;
let playerWasInSafeRoom = false;
{
  initializeWorld(hashString(`solo:${Date.now()}`));
  const patrolGoal = chooseMonsterPatrolGoal(MONSTER_START_CX, MONSTER_START_CY);
  setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;

function update(dt) {
  applySharedStateToLocalWorld();
  if (online.enabled) {
    online.syncTimer = Math.max(0, online.syncTimer - dt);
    online.monsterSyncTimer = Math.max(0, online.monsterSyncTimer - dt);
  }

  if (gameWon) return;

  // Death countdown → restart
  if (playerDead) {
    deathTimer -= dt;
    if (deathTimer <= 0) {
      restartGame();
      if (online.enabled) syncLocalPlayerToRoom(true);
    }
    return;
  }

  // Input
  let mx = 0, my = 0;
  if (keys['ArrowLeft']  || keys['a']) mx -= 1;
  if (keys['ArrowRight'] || keys['d']) mx += 1;
  if (keys['ArrowUp']   || keys['w']) my -= 1;
  if (keys['ArrowDown'] || keys['s']) my += 1;

  // Joystick overrides if active
  if (joyActive || Math.abs(joyDX) > 0.05 || Math.abs(joyDY) > 0.05) {
    mx = joyDX;
    my = joyDY;
  }

  const len = Math.sqrt(mx * mx + my * my);
  if (len > 1) { mx /= len; my /= len; }

  if (online.enabled) {
    const boostUntil = online.players[online.localUid]?.boostUntil || 0;
    speedBoostLeft = Math.max(0, (boostUntil - Date.now()) / 1000);
  } else if (speedBoostLeft > 0) {
    speedBoostLeft -= dt;
  }

  const speed = PLAYER_SPEED * (speedBoostLeft > 0 ? BOOST_MULT : 1);
  const vx = mx * speed;
  const vy = my * speed;

  player.moving = (Math.abs(vx) + Math.abs(vy)) > 0.1;
  if (vx > 0.05) player.facing = 1;
  else if (vx < -0.05) player.facing = -1;

  // Move X
  const nx = player.x + vx;
  if (!collides(nx, player.y)) player.x = nx;
  // Move Y
  const ny = player.y + vy;
  if (!collides(player.x, ny)) player.y = ny;

  // Animate
  if (player.moving) {
    player.frameTimer += dt * 60;
    if (player.frameTimer > 10) {
      player.frameTimer = 0;
      player.frame = (player.frame + 1) % 4;
    }
  }

  // Camera hard-locked to player center
  cam.x = player.x - canvas.width / 2;
  cam.y = player.y - canvas.height / 2;

  // Flicker
  flickerTimer += dt;
  if (flickerTimer > nextFlicker) {
    flickerAlpha = 0.08 + Math.random() * 0.12;
    nextFlicker = 2 + Math.random() * 10;
    flickerTimer = 0;
    setTimeout(() => { flickerAlpha = 0; }, 60 + Math.random() * 120);
  }

  const pCX = (player.x  / CELL) | 0;
  const pCY = (player.y  / CELL) | 0;
  const playerInSafeRoom = isSafeCell(pCX, pCY);

  const distToExit = Math.hypot(player.x - EXIT.x, player.y - EXIT.y);
  if (!online.enabled) {
    if (distToExit < CELL * 0.8) gameWon = true;

    for (const aw of almondWaters) {
      if (aw.picked) continue;
      if (Math.hypot(player.x - aw.x, player.y - aw.y) < CELL * 0.55) {
        aw.picked = true;
        speedBoostLeft = BOOST_SECONDS;
      }
    }
  } else {
    if (distToExit < CELL * 0.8 && !online.winState?.won) {
      online.winState = { won: true, winnerUid: online.localUid, winnerName: online.localName, at: Date.now() };
      updateData(ref(firebaseDb, `rooms/${online.roomId}/shared`), { win: online.winState }).catch(() => {});
      gameWon = true;
    }
  }

  const shouldDriveMonster = !online.enabled || online.hostUid === online.localUid;
  if (shouldDriveMonster) {
    const alivePlayers = listAlivePlayersForMonster();

    if (!online.enabled) {
      if (playerInSafeRoom && !playerWasInSafeRoom) {
        relocateMonsterAwayFromPlayer(pCX, pCY);
      }
    } else {
      const nextSafeFlags = {};
      for (const candidate of alivePlayers) {
        const cx = (candidate.x / CELL) | 0;
        const cy = (candidate.y / CELL) | 0;
        const inSafe = candidate.inSafeRoom || isSafeCell(cx, cy);
        nextSafeFlags[candidate.uid] = inSafe;
        if (inSafe && !online.safeFlags[candidate.uid]) {
          relocateMonsterAwayFromPlayer(cx, cy);
        }
      }
      online.safeFlags = nextSafeFlags;

      const playerUpdates = {};
      let pickedChanged = false;
      almondWaters.forEach((aw, index) => {
        if (aw.picked) return;
        const picker = alivePlayers.find(candidate => candidate.alive && Math.hypot(candidate.x - aw.x, candidate.y - aw.y) < CELL * 0.55);
        if (!picker) return;
        aw.picked = true;
        online.sharedPickedWaters[index] = true;
        playerUpdates[`${picker.uid}/boostUntil`] = Date.now() + BOOST_SECONDS * 1000;
        pickedChanged = true;
      });

      if (pickedChanged) {
        updateData(ref(firebaseDb, `rooms/${online.roomId}/shared`), { pickedWaters: online.sharedPickedWaters }).catch(() => {});
      }
      if (Object.keys(playerUpdates).length) {
        updateData(ref(firebaseDb, `rooms/${online.roomId}/players`), playerUpdates).catch(() => {});
      }
    }

    const targetPlayer = getNearestMonsterTarget(listAlivePlayersForMonster());
    let mCX = (monster.x / CELL) | 0;
    let mCY = (monster.y / CELL) | 0;
    let targetDist = targetPlayer ? Math.hypot(targetPlayer.x - monster.x, targetPlayer.y - monster.y) : Infinity;

    if (!targetPlayer) {
      monster.isChasing = false;
    } else if (monster.isChasing) {
      if (targetDist > MONSTER_LOSE_RANGE) {
        monster.isChasing = false;
        const patrolGoal = chooseMonsterPatrolGoal(mCX, mCY);
        setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
      }
    } else if (targetDist <= MONSTER_DETECT_RANGE) {
      monster.isChasing = true;
      setMonsterGoal((targetPlayer.x / CELL) | 0, (targetPlayer.y / CELL) | 0);
    }

    if (monster.isChasing && targetPlayer) {
      const targetCX = (targetPlayer.x / CELL) | 0;
      const targetCY = (targetPlayer.y / CELL) | 0;
      if (monster.goalCX !== targetCX || monster.goalCY !== targetCY) {
        setMonsterGoal(targetCX, targetCY);
      }
      monster.pathRefreshTimer -= dt;
      if (monster.pathRefreshTimer <= 0) {
        if (!refreshMonsterStep(mCX, mCY, targetCX, targetCY)) {
          monster.isChasing = false;
          const patrolGoal = chooseMonsterPatrolGoal(mCX, mCY);
          setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
        }
        monster.pathRefreshTimer = 0.2;
      }
    } else {
      const reachedGoal = mCX === monster.goalCX && mCY === monster.goalCY;
      if (!monsterCanUseCell(monster.goalCX, monster.goalCY) || reachedGoal) {
        const patrolGoal = chooseMonsterPatrolGoal(mCX, mCY);
        setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
      }

      monster.pathRefreshTimer -= dt;
      if (monster.pathRefreshTimer <= 0) {
        if (!refreshMonsterStep(mCX, mCY, monster.goalCX, monster.goalCY)) {
          const patrolGoal = chooseMonsterPatrolGoal(mCX, mCY);
          setMonsterGoal(patrolGoal.cx, patrolGoal.cy);
          refreshMonsterStep(mCX, mCY, monster.goalCX, monster.goalCY);
        }
        monster.pathRefreshTimer = 0.32;
      }
    }

    if (monster.pathTargetCX >= 0) {
      const tx = monster.pathTargetCX * CELL + CELL / 2;
      const ty = monster.pathTargetCY * CELL + CELL / 2;
      const ddx = tx - monster.x;
      const ddy = ty - monster.y;
      const dd = Math.hypot(ddx, ddy);
      if (dd > 2) {
        monster.dx = ddx / dd;
        monster.dy = ddy / dd;
      } else {
        resetMonsterPath();
      }
    }

    const mspd = monster.isChasing ? MONSTER_SPD_CHASE : MONSTER_SPD_PATROL;
    monster.x += monster.dx * mspd;
    monster.y += monster.dy * mspd;

    if (online.enabled) {
      if (online.monsterSyncTimer <= 0) {
        online.monsterSyncTimer = 0.08;
        online.monsterSnapshot = {
          x: Math.round(monster.x),
          y: Math.round(monster.y),
          dx: monster.dx,
          dy: monster.dy,
          fearLevel: monster.fearLevel,
          isChasing: monster.isChasing,
        };
        updateData(ref(firebaseDb, `rooms/${online.roomId}/shared`), {
          monster: online.monsterSnapshot,
        }).catch(() => {});
      }
    }
  }

  const monDist = Math.hypot(player.x - monster.x, player.y - monster.y);
  const targetFear = playerInSafeRoom || monDist >= FEAR_RANGE
    ? 0
    : Math.pow(1 - monDist / FEAR_RANGE, 1.4);
  monster.fearLevel += (targetFear - monster.fearLevel) * 0.04;

  const shakeMag = monster.fearLevel * 5;
  shakeX = (Math.random() - 0.5) * shakeMag;
  shakeY = (Math.random() - 0.5) * shakeMag;

  if (!playerInSafeRoom && monDist < CATCH_DIST) {
    playerDead = true;
    deathTimer = DEATH_DURATION;
    if (online.enabled) syncLocalPlayerToRoom(true);
  }

  playerWasInSafeRoom = playerInSafeRoom;
  if (online.enabled) syncLocalPlayerToRoom();
}

function drawMaze() {
  const startCX = Math.max(0, Math.floor(cam.x / CELL) - 1);
  const startCY = Math.max(0, Math.floor(cam.y / CELL) - 1);
  const endCX   = Math.min(COLS, startCX + Math.ceil(canvas.width  / CELL) + 2);
  const endCY   = Math.min(ROWS, startCY + Math.ceil(canvas.height / CELL) + 2);

  // ── Pass 1: floors ───────────────────────────────────────────────────────
  for (let cy = startCY; cy < endCY; cy++) {
    for (let cx = startCX; cx < endCX; cx++) {
      const wx   = cx * CELL - cam.x;
      const wy   = cy * CELL - cam.y;
      const bits = maze[cellIndex(cx, cy)];
      const pw   = CELL - WALL_T * 2; // passage / center width

      // centre corridor
      ctx.drawImage(floorCanvas, 0, 0, CELL, CELL, wx + WALL_T, wy + WALL_T, pw, pw);
      if (bits & 1) ctx.drawImage(floorCanvas, 0, 0, CELL, CELL, wx + WALL_T, wy,              pw, WALL_T); // N
      if (bits & 4) ctx.drawImage(floorCanvas, 0, 0, CELL, CELL, wx + WALL_T, wy + CELL - WALL_T, pw, WALL_T); // S
      if (bits & 8) ctx.drawImage(floorCanvas, 0, 0, CELL, CELL, wx,          wy + WALL_T,    WALL_T, pw); // W
      if (bits & 2) ctx.drawImage(floorCanvas, 0, 0, CELL, CELL, wx + CELL - WALL_T, wy + WALL_T, WALL_T, pw); // E
    }
  }

  // ── Pass 2: wall tops + south-facing wall faces ──────────────────────────
  // Iterate top-to-bottom so faces from row Y render over the floor of row Y
  for (let cy = startCY; cy < endCY; cy++) {
    for (let cx = startCX; cx < endCX; cx++) {
      const wx   = cx * CELL - cam.x;
      const wy   = cy * CELL - cam.y;
      const bits = maze[cellIndex(cx, cy)];
      const pw   = CELL - WALL_T * 2;

      // Helper: draw wall top rect from wallCanvas
      const wTop = (x, y, w, h) =>
        ctx.drawImage(wallCanvas, 0, 0, CELL, CELL, x, y, w, h);

      // Helper: draw wall face (south-facing, darker)
      const wFace = (x, y, w) =>
        ctx.drawImage(faceCanvas, 0, 0, CELL, WALL_FACE, x, y, w, WALL_FACE);

      // ── Four corners (always solid walls) ───────────────────────────────
      // NW corner — top + face (faces south into cell)
      wTop(wx,               wy, WALL_T, WALL_T);
      wFace(wx,              wy + WALL_T, WALL_T);

      // NE corner — top + face
      wTop(wx + CELL - WALL_T, wy, WALL_T, WALL_T);
      wFace(wx + CELL - WALL_T, wy + WALL_T, WALL_T);

      // SW corner — top only (face would point away from viewer)
      wTop(wx,               wy + CELL - WALL_T, WALL_T, WALL_T);

      // SE corner — top only
      wTop(wx + CELL - WALL_T, wy + CELL - WALL_T, WALL_T, WALL_T);

      // ── Mid-wall segments ────────────────────────────────────────────────
      if (!(bits & 1)) {
        // North wall closed — top strip + south-facing face
        wTop(wx + WALL_T, wy, pw, WALL_T);
        wFace(wx + WALL_T, wy + WALL_T, pw);
      }
      if (!(bits & 4)) {
        // South wall closed — top strip only (faces away)
        wTop(wx + WALL_T, wy + CELL - WALL_T, pw, WALL_T);
      }
      if (!(bits & 8)) {
        // West wall closed — vertical strip
        wTop(wx, wy + WALL_T, WALL_T, pw);
      }
      if (!(bits & 2)) {
        // East wall closed — vertical strip
        wTop(wx + CELL - WALL_T, wy + WALL_T, WALL_T, pw);
      }
    }
  }
}

function drawSafeRooms() {
  for (const room of safeRooms) {
    const rx = room.x * CELL - cam.x + WALL_T;
    const ry = room.y * CELL - cam.y + WALL_T;
    const rw = room.w * CELL - WALL_T * 2;
    const rh = room.h * CELL - WALL_T * 2;

    if (rx > canvas.width + CELL || ry > canvas.height + CELL || rx + rw < -CELL || ry + rh < -CELL) continue;

    const pulse = 0.35 + 0.18 * Math.sin(Date.now() / 700 + room.centerCX);
    ctx.save();
    ctx.fillStyle = `rgba(80, 190, 170, ${0.12 + pulse * 0.25})`;
    ctx.strokeStyle = 'rgba(170, 255, 235, 0.8)';
    ctx.lineWidth = 3;
    ctx.shadowBlur = 20;
    ctx.shadowColor = 'rgba(120, 255, 235, 0.55)';
    ctx.fillRect(rx + 6, ry + 6, rw - 12, rh - 12);
    ctx.strokeRect(rx + 6, ry + 6, rw - 12, rh - 12);
    ctx.shadowBlur = 0;
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(220,255,250,0.95)';
    ctx.fillText('SAFE', rx + rw / 2, ry + rh / 2 + 5);
    ctx.restore();
  }
}

function drawExit() {
  const ex = EXIT.x - cam.x - 12;
  const ey = EXIT.y - cam.y - 12;
  const t = Date.now() / 600;
  const pulse = 0.6 + 0.4 * Math.sin(t);
  ctx.save();
  ctx.shadowBlur = 20;
  ctx.shadowColor = `rgba(100,255,100,${pulse})`;
  ctx.fillStyle = `rgba(60,200,60,${0.5 + 0.5 * pulse})`;
  ctx.fillRect(ex, ey, 24, 24);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', EXIT.x - cam.x, EXIT.y - cam.y - 14);
  ctx.restore();
}

function drawPlayer() {
  drawCharacterSprite({
    x: player.x,
    y: player.y,
    facing: player.facing,
    frame: player.frame,
    name: online.localName || 'YOU',
    accent: online.localColor || '#f0d96a',
    local: true,
  });
}

function drawCharacterSprite({ x, y, facing, frame, name, accent, local = false }) {
  const px = Math.round(x - cam.x);
  const py = Math.round(y - cam.y);
  if (px < -48 || px > canvas.width + 48 || py < -64 || py > canvas.height + 48) return;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const scale = 2;
  const sw = SPRITE_W * scale;
  const sh = SPRITE_H * scale;

  if (!local) {
    ctx.shadowBlur = 16;
    ctx.shadowColor = accent;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py - sh / 2, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  if (facing === -1) {
    ctx.translate(px, py);
    ctx.scale(-1, 1);
    ctx.drawImage(
      spriteCanvas,
      frame * SPRITE_W, 0, SPRITE_W, SPRITE_H,
      -sw / 2, -sh, sw, sh
    );
  } else {
    ctx.drawImage(
      spriteCanvas,
      frame * SPRITE_W, 0, SPRITE_W, SPRITE_H,
      px - sw / 2, py - sh, sw, sh
    );
  }

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(px, py, 10, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (!local) {
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 4;
    ctx.strokeText(name, px, py - sh - 10);
    ctx.fillText(name, px, py - sh - 10);
  }

  ctx.restore();
}

function drawRemotePlayers() {
  if (!online.enabled) return;
  for (const [uid, playerData] of Object.entries(online.players)) {
    if (uid === online.localUid || playerData.alive === false) continue;
    drawCharacterSprite({
      x: playerData.x ?? PLAYER_START_CX * CELL + CELL / 2,
      y: playerData.y ?? PLAYER_START_CY * CELL + CELL / 2,
      facing: playerData.facing ?? 1,
      frame: playerData.frame ?? 0,
      name: playerData.name || shortNameForPlayer(uid),
      accent: playerData.color || colorForPlayer(uid),
      local: false,
    });
  }
}

function drawAlmondWaters() {
  const t = Date.now() / 700;
  for (const aw of almondWaters) {
    if (aw.picked) continue;
    const sx = Math.round(aw.x - cam.x);
    const sy = Math.round(aw.y - cam.y);
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    const bob = Math.sin(t + aw.bob) * 3;
    const glow = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + aw.bob));

    ctx.save();
    ctx.shadowBlur = 14;
    ctx.shadowColor = `rgba(140,220,255,${glow})`;

    // pixel bottle (2× scale, 16×20 display)
    const bx = sx - 8, by = sy - 10 + bob;
    ctx.fillStyle = '#78b8d0';   ctx.fillRect(bx + 4, by,      8, 3);  // cap
    ctx.fillStyle = '#d0f0ff';   ctx.fillRect(bx + 2, by + 3,  12, 14); // body
    ctx.fillStyle = '#7abcd8';   ctx.fillRect(bx + 3, by + 7,  10, 5);  // label
    ctx.fillStyle = 'rgba(80,190,230,0.75)'; ctx.fillRect(bx + 3, by + 10, 10, 5); // liquid
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(bx + 4, by + 4, 2, 9);  // highlight
    ctx.fillStyle = '#5090a8';   ctx.fillRect(bx + 2, by + 17, 12, 2);  // bottom

    ctx.restore();
  }
}

function drawMonster() {
  const sx = Math.round(monster.x - cam.x);
  const sy = Math.round(monster.y - cam.y);
  if (sx < -80 || sx > canvas.width + 80 || sy < -80 || sy > canvas.height + 80) return;

  const t   = Date.now() / 380;
  const bob = Math.sin(t) * 3;

  // Thin & tall: 10px wide, 80px tall (2.5× pixel scale)
  const BW = 10;  // body width
  const BH = 80;  // total height
  const HH = 12;  // head height
  const legPhase = Math.sin(t * 1.4);

  ctx.save();
  ctx.shadowBlur  = 18;
  ctx.shadowColor = '#000';

  const by = sy - BH + bob; // top of figure

  // Long thin legs
  ctx.fillStyle = '#0a0a0a';
  const lOff = legPhase * 5;
  ctx.fillRect(sx - 5,  by + BH - 30 - lOff, 4, 30 + lOff);   // left leg
  ctx.fillRect(sx + 1,  by + BH - 30 + lOff, 4, 30 - lOff);   // right leg

  // Narrow torso
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(sx - BW / 2, by + HH, BW, BH - HH - 28);

  // Long thin arms
  ctx.fillStyle = '#080808';
  const aOff = legPhase * 4;
  ctx.fillRect(sx - BW / 2 - 12, by + HH + 4 + aOff,  4, BH * 0.42);  // left arm
  ctx.fillRect(sx + BW / 2 +  8, by + HH + 4 - aOff,  4, BH * 0.42);  // right arm

  // Small narrow head
  ctx.fillStyle = '#111';
  ctx.fillRect(sx - BW / 2, by, BW, HH);

  // Glowing eyes (tiny, close together — unsettling)
  const eyeGlow = 0.75 + 0.25 * Math.sin(t * 2.1);
  ctx.shadowBlur  = 8;
  ctx.shadowColor = '#ff0000';
  ctx.fillStyle   = `rgba(255,20,0,${eyeGlow})`;
  ctx.fillRect(sx - 3, by + 3, 2, 3);
  ctx.fillRect(sx + 1, by + 3, 2, 3);

  ctx.restore();
}

function drawFearEffects() {
  const fear = monster.fearLevel;
  if (fear < 0.01) return;
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;

  // Extra dark overlay
  ctx.fillStyle = `rgba(0,0,0,${fear * 0.52})`;
  ctx.fillRect(0, 0, W, H);

  // Tunnel-vision vignette (shrinks with fear)
  const innerR = H * Math.max(0.05, 0.5 - fear * 0.42);
  const outerR = H * 0.75;
  const tgrad  = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
  tgrad.addColorStop(0, 'rgba(0,0,0,0)');
  tgrad.addColorStop(1, `rgba(0,0,0,${0.45 + fear * 0.5})`);
  ctx.fillStyle = tgrad;
  ctx.fillRect(0, 0, W, H);

  // TV-static: tile pre-baked noise canvas with random offset — zero CPU cost
  if (fear > 0.1) {
    ctx.save();
    ctx.globalAlpha = fear * 0.55;
    const ox = Math.floor(Math.random() * NOISE_SIZE);
    const oy = Math.floor(Math.random() * NOISE_SIZE);
    // tile across screen using pattern
    const pat = ctx.createPattern(noiseCanvas, 'repeat');
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    ctx.fillStyle = pat;
    ctx.fillRect(-ox, -oy, W + NOISE_SIZE, H + NOISE_SIZE);
    ctx.restore();
  }

  // Horizontal scanlines (cheap: just semi-transparent lines every 2px)
  if (fear > 0.3) {
    ctx.save();
    ctx.globalAlpha = fear * 0.18;
    ctx.fillStyle = '#000';
    for (let ly = 0; ly < H; ly += 2) ctx.fillRect(0, ly, W, 1);
    ctx.restore();
  }

  // Random horizontal glitch bar (GPU-friendly rect shift)
  if (fear > 0.45 && Math.random() < fear * 0.4) {
    const gy = Math.floor(Math.random() * H);
    const gh = 1 + Math.floor(Math.random() * 4);
    const gs = (Math.random() - 0.5) * fear * 35;
    ctx.save();
    ctx.globalAlpha = 0.6 + Math.random() * 0.4;
    ctx.drawImage(canvas, 0, gy, W, gh, gs, gy, W, gh);
    ctx.restore();
  }

  // Blood-red tint at extreme fear
  if (fear > 0.65) {
    ctx.fillStyle = `rgba(90,0,0,${(fear - 0.65) * 0.45})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawBoostHUD() {
  if (speedBoostLeft <= 0) {
    document.getElementById('hudLevel').textContent = 'LEVEL 0';
    return;
  }
  const secs = Math.ceil(speedBoostLeft);
  document.getElementById('hudLevel').textContent = `BOOST x1.7  ${secs}s`;
}

function drawVignette() {
  const W = canvas.width, H = canvas.height;
  const grad = ctx.createRadialGradient(W/2, H/2, H*0.2, W/2, H/2, H*0.85);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawFlicker() {
  if (flickerAlpha > 0) {
    ctx.fillStyle = `rgba(255,240,160,${flickerAlpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function drawHUD() {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  document.getElementById('hudTime').textContent = `${mm}:${ss}`;

  const pcx = Math.floor(player.x / CELL);
  const pcy = Math.floor(player.y / CELL);
  const roomInfo = online.enabled ? ` ROOM ${online.roomId} ${Object.keys(online.players).length}/${MAX_PLAYERS}` : '';
  document.getElementById('hudPos').textContent = `[${pcx},${pcy}]${roomInfo}`;
}

function drawWinScreen() {
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.fillStyle = '#c8b96a';
  ctx.shadowBlur = 30;
  ctx.shadowColor = '#c8b96a';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('YOU ESCAPED THE BACKROOMS', canvas.width/2, canvas.height/2 - 20);
  ctx.shadowBlur = 0;
  ctx.font = '16px monospace';
  ctx.fillStyle = '#fff';
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  ctx.fillText(`Time: ${mm}:${ss}`, canvas.width/2, canvas.height/2 + 20);
  ctx.restore();
}

// Mini-map
function drawMinimap() {
  const mw = 90, mh = 90;
  const mx = canvas.width - mw - 10;
  const my = 30;
  const scx = mw / COLS;
  const scy = mh / ROWS;

  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = '#1a1508';
  ctx.fillRect(mx, my, mw, mh);

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const bits = maze[cellIndex(cx, cy)];
      if (bits > 0) {
        ctx.fillStyle = isSafeCell(cx, cy) ? '#3f7c78' : '#8a7a3e';
        ctx.fillRect(mx + cx * scx, my + cy * scy, scx, scy);
      }
    }
  }

  // Exit
  ctx.fillStyle = '#3fc83f';
  ctx.fillRect(mx + (COLS-2) * scx - 1, my + (ROWS-2) * scy - 1, scx + 2, scy + 2);

  // Monster dot
  const mdx = (monster.x / CELL) * scx;
  const mdy = (monster.y / CELL) * scy;
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
  ctx.shadowBlur  = 6;
  ctx.shadowColor = '#ff0000';
  ctx.fillStyle   = `rgba(220,0,0,${0.7 + 0.3 * pulse})`;
  ctx.beginPath();
  ctx.arc(mx + mdx, my + mdy, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Player dot
  ctx.fillStyle = '#ff4444';
  const pdx = (player.x / CELL) * scx;
  const pdy = (player.y / CELL) * scy;
  ctx.beginPath();
  ctx.arc(mx + pdx, my + pdy, 2.5, 0, Math.PI * 2);
  ctx.fill();

  if (online.enabled) {
    for (const [uid, playerData] of Object.entries(online.players)) {
      if (uid === online.localUid || playerData.alive === false) continue;
      ctx.fillStyle = playerData.color || colorForPlayer(uid);
      const rdx = ((playerData.x ?? 0) / CELL) * scx;
      const rdy = ((playerData.y ?? 0) / CELL) * scy;
      ctx.beginPath();
      ctx.arc(mx + rdx, my + rdy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = '#c8b96a';
  ctx.lineWidth = 1;
  ctx.strokeRect(mx, my, mw, mh);
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawDeathScreen() {
  const progress = 1 - deathTimer / DEATH_DURATION; // 0→1
  const W = canvas.width, H = canvas.height;

  // Red overlay that fills in quickly then fades slightly
  const alpha = Math.min(1, progress * 3) * 0.88;
  ctx.fillStyle = `rgba(160,0,0,${alpha})`;
  ctx.fillRect(0, 0, W, H);

  if (progress > 0.25) {
    const textAlpha = Math.min(1, (progress - 0.25) * 4);
    ctx.save();
    ctx.globalAlpha = textAlpha;
    ctx.shadowBlur  = 20;
    ctx.shadowColor = '#ff0000';
    ctx.fillStyle   = '#ffffff';
    ctx.font        = 'bold 30px monospace';
    ctx.textAlign   = 'center';
    ctx.fillText('ВЫ ПОЙМАНЫ', W / 2, H / 2 - 20);
    ctx.shadowBlur  = 0;
    ctx.font        = '16px monospace';
    ctx.fillStyle   = '#ffaaaa';
    ctx.fillText('перезапуск...', W / 2, H / 2 + 18);
    ctx.restore();
  }
}

function render() {
  ctx.fillStyle = '#1a1508';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // World layer — translated by shake so HUD/effects stay fixed
  ctx.save();
  ctx.translate(Math.round(shakeX), Math.round(shakeY));
  drawMaze();
  drawSafeRooms();
  drawAlmondWaters();
  drawExit();
  drawMonster();
  drawRemotePlayers();
  drawPlayer();
  ctx.restore();

  // Screen-space effects (no shake)
  drawVignette();
  drawFearEffects();
  drawFlicker();
  drawMinimap();
  drawBoostHUD();
  drawHUD();

  if (playerDead) drawDeathScreen();
  if (gameWon)    drawWinScreen();
}

function loop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

function startSoloMode() {
  online.enabled = false;
  online.roomId = '';
  online.roomSeed = 0;
  online.hostUid = '';
  online.players = {};
  online.monsterSnapshot = null;
  online.sharedPickedWaters = {};
  online.winState = null;
  online.safeFlags = {};
  cleanupRoomListeners();
  initializeWorld(hashString(`solo:${Date.now()}`));
  restartGame({ resetSharedState: true });
  setOverlayVisible(false);
  window.history.replaceState({}, '', getRoomUrl(''));
}

async function bootstrapMultiplayerUi() {
  roomCodeInput.addEventListener('input', () => {
    roomCodeInput.value = sanitizeRoomCode(roomCodeInput.value);
    updateRoomShareUi();
  });

  createRoomBtn.addEventListener('click', async () => {
    if (!firebaseReady) {
      setLobbyStatus(firebaseDisabledReason || 'Firebase is not configured yet. Use solo mode for now.');
      return;
    }
    const roomId = generateRoomCode();
    await joinRoom(roomId, { create: true });
  });

  joinRoomBtn.addEventListener('click', async () => {
    await joinRoom(roomCodeInput.value, { create: false });
  });

  soloBtn.addEventListener('click', () => {
    setLobbyStatus('Solo mode started.');
    startSoloMode();
  });

  copyRoomLinkBtn.addEventListener('click', async () => {
    if (!online.joinLink) return;
    try {
      await navigator.clipboard.writeText(online.joinLink);
      setLobbyStatus('Room link copied.');
    } catch {
      setLobbyStatus(online.joinLink);
    }
  });

  try {
    await initFirebase();
  } catch (error) {
    firebaseDisabledReason = 'Failed to initialize Firebase.';
    setLobbyStatus('Co-op backend failed to initialize. Solo mode is still available.');
  }

  const autoRoom = sanitizeRoomCode(new URL(window.location.href).searchParams.get('room'));
  if (autoRoom) {
    roomCodeInput.value = autoRoom;
    updateRoomShareUi();
    if (firebaseReady) {
      const joined = await joinRoom(autoRoom, { create: false });
      if (!joined) setOverlayVisible(true);
      return;
    }
  }

  setOverlayVisible(true);
}

bootstrapMultiplayerUi();
requestAnimationFrame(ts => { lastTime = ts; loop(ts); });
