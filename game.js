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
const locationOptionButtons = Array.from(document.querySelectorAll('[data-location-option]'));

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
  roomLocationId: '',
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
  remoteVisuals: {},
  lastSentSnapshot: null,
};

let fullscreenSupported = true;
const REMOTE_SYNC_INTERVAL_MOVING = 0.05;
const REMOTE_SYNC_INTERVAL_IDLE = 0.12;
const REMOTE_EXTRAPOLATION_MAX = 0.12;

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
const COLS         = 45;  // maze width in cells
const ROWS         = 45;  // maze height in cells
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
const LOCATION_BACKROOMS = 'backrooms';
const LOCATION_FOREST_VILLAGE = 'forestVillage';
let selectedCreateLocationId = LOCATION_BACKROOMS;

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
let currentLocationId = LOCATION_BACKROOMS;
let currentLocationName = 'BACKROOMS';

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

function getLocationFromSeed(seed) {
  return ((seed >>> 0) & 1) === 0 ? LOCATION_FOREST_VILLAGE : LOCATION_BACKROOMS;
}

function normalizeLocationId(locationId) {
  return locationId === LOCATION_FOREST_VILLAGE ? LOCATION_FOREST_VILLAGE : LOCATION_BACKROOMS;
}

function getLocationLabel(locationId) {
  return normalizeLocationId(locationId) === LOCATION_FOREST_VILLAGE ? 'Forest Village' : 'Backrooms';
}

function applyLocationTheme(locationId) {
  currentLocationId = normalizeLocationId(locationId);
  currentLocationName = currentLocationId === LOCATION_FOREST_VILLAGE ? 'FOREST VILLAGE' : 'BACKROOMS';
}

function setSelectedCreateLocation(locationId) {
  selectedCreateLocationId = normalizeLocationId(locationId);
  for (const button of locationOptionButtons) {
    button.classList.toggle('active', button.dataset.locationOption === selectedCreateLocationId);
  }
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

function generateOpenForestWorld() {
  maze.fill(0);
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      if (cx + 1 < COLS) openPassage(cx, cy, 1);
      if (cy + 1 < ROWS) openPassage(cx, cy, 2);
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

// Forest village textures
const forestFloorCanvas = document.createElement('canvas');
forestFloorCanvas.width = forestFloorCanvas.height = CELL;
(function buildForestFloor() {
  const fc = forestFloorCanvas.getContext('2d');
  // Base solid dark green
  fc.fillStyle = '#0d1f0f';
  fc.fillRect(0, 0, CELL, CELL);
  // Pixel grass tufts - subtle color variation in 2x2 blocks
  for (let py = 0; py < CELL; py += 2) {
    for (let px = 0; px < CELL; px += 2) {
      const r = Math.random();
      if (r < 0.18) {
        fc.fillStyle = '#162a14';
        fc.fillRect(px, py, 2, 2);
      } else if (r < 0.32) {
        fc.fillStyle = '#0b1a0d';
        fc.fillRect(px, py, 2, 2);
      } else if (r < 0.42) {
        fc.fillStyle = '#1a2e18';
        fc.fillRect(px, py, 2, 1);
      }
    }
  }
  // Sparse bright grass blades (1px)
  for (let i = 0; i < 28; i++) {
    fc.fillStyle = '#1f3a1c';
    fc.fillRect(Math.floor(Math.random() * CELL), Math.floor(Math.random() * CELL), 1, 3);
  }
  // Very subtle small stones
  for (let i = 0; i < 4; i++) {
    fc.fillStyle = `rgba(80,75,60,${0.12 + Math.random() * 0.1})`;
    fc.fillRect(Math.floor(Math.random() * (CELL - 4)), Math.floor(Math.random() * (CELL - 3)), 3, 2);
  }
})();

const forestWallCanvas = document.createElement('canvas');
forestWallCanvas.width = forestWallCanvas.height = CELL;
(function buildForestWall() {
  const fc = forestWallCanvas.getContext('2d');
  fc.fillStyle = '#0f1b12';
  fc.fillRect(0, 0, CELL, CELL);
  for (let i = 0; i < 180; i++) {
    fc.fillStyle = `rgba(${12 + Math.floor(Math.random() * 12)}, ${28 + Math.floor(Math.random() * 36)}, ${14 + Math.floor(Math.random() * 18)}, ${0.15 + Math.random() * 0.22})`;
    fc.fillRect(Math.random() * CELL, Math.random() * CELL, 2 + Math.random() * 6, 2 + Math.random() * 10);
  }
})();

const forestFaceCanvas = document.createElement('canvas');
forestFaceCanvas.width = CELL;
forestFaceCanvas.height = WALL_FACE;
(function buildForestFace() {
  const fc = forestFaceCanvas.getContext('2d');
  const grad = fc.createLinearGradient(0, 0, 0, WALL_FACE);
  grad.addColorStop(0, '#1d3420');
  grad.addColorStop(1, '#081109');
  fc.fillStyle = grad;
  fc.fillRect(0, 0, CELL, WALL_FACE);
  for (let px = 0; px < CELL; px += 8) {
    fc.fillStyle = 'rgba(0,0,0,0.2)';
    fc.fillRect(px, 0, 2, WALL_FACE);
  }
})();

const houseFloorCanvas = document.createElement('canvas');
houseFloorCanvas.width = houseFloorCanvas.height = CELL;
(function buildHouseFloor() {
  const fc = houseFloorCanvas.getContext('2d');
  fc.fillStyle = '#6c4a2c';
  fc.fillRect(0, 0, CELL, CELL);
  for (let py = 0; py < CELL; py += 10) {
    fc.fillStyle = 'rgba(0,0,0,0.12)';
    fc.fillRect(0, py, CELL, 1);
  }
  for (let px = 0; px < CELL; px += 12) {
    fc.fillStyle = 'rgba(255,220,150,0.05)';
    fc.fillRect(px, 0, 1, CELL);
  }
})();

const houseWallCanvas = document.createElement('canvas');
houseWallCanvas.width = houseWallCanvas.height = CELL;
(function buildHouseWall() {
  const fc = houseWallCanvas.getContext('2d');
  fc.fillStyle = '#8a5c33';
  fc.fillRect(0, 0, CELL, CELL);
  for (let py = 0; py < CELL; py += 7) {
    fc.fillStyle = 'rgba(70,35,12,0.2)';
    fc.fillRect(0, py, CELL, 1);
  }
})();

const houseFaceCanvas = document.createElement('canvas');
houseFaceCanvas.width = CELL;
houseFaceCanvas.height = WALL_FACE;
(function buildHouseFace() {
  const fc = houseFaceCanvas.getContext('2d');
  const grad = fc.createLinearGradient(0, 0, 0, WALL_FACE);
  grad.addColorStop(0, '#a36b34');
  grad.addColorStop(1, '#4f2f14');
  fc.fillStyle = grad;
  fc.fillRect(0, 0, CELL, WALL_FACE);
  for (let py = 2; py < WALL_FACE; py += 5) {
    fc.fillStyle = 'rgba(255,228,170,0.06)';
    fc.fillRect(0, py, CELL, 1);
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
// Frames: 0-3 side walk, 4-5 front walk, 6-7 back walk
const spriteCanvas = document.createElement('canvas');
spriteCanvas.width = SPRITE_W * 8;
spriteCanvas.height = SPRITE_H;
const sctx = spriteCanvas.getContext('2d');

function drawSprite(frame) {
  // True side-profile view facing RIGHT (mirrored for left by drawCharacterSprite)
  const sx = frame * SPRITE_W;
  const sc = sctx;
  sc.clearRect(sx, 0, SPRITE_W, SPRITE_H);
  const lp = frame % 2; // 0 or 1 walk phase

  // Head — profile, pushed right (facing direction)
  sc.fillStyle = '#f5c8a0';
  sc.fillRect(sx + 6, 0, 5, 5);   // head block
  sc.fillRect(sx + 10, 2, 1, 2);  // nose/snout
  sc.fillRect(sx + 7, 5, 3, 2);   // neck

  // Single eye (front of face = right side)
  sc.fillStyle = '#1a1208';
  sc.fillRect(sx + 9, 1, 1, 1);

  // Torso — narrow (side view = ~5px wide)
  sc.fillStyle = '#b0a04a';
  sc.fillRect(sx + 6, 6, 5, 7);

  // Arms — front arm swings forward/back, back arm subtly opposite
  if (lp === 0) {
    // Front arm forward (extends left/front)
    sc.fillStyle = '#b0a04a';
    sc.fillRect(sx + 4, 7, 2, 5);
    // Back arm behind torso (darker)
    sc.fillStyle = '#907828';
    sc.fillRect(sx + 10, 8, 2, 4);
  } else {
    // Front arm back
    sc.fillStyle = '#907828';
    sc.fillRect(sx + 4, 8, 2, 4);
    // Back arm forward
    sc.fillStyle = '#b0a04a';
    sc.fillRect(sx + 10, 7, 2, 5);
  }

  // Belt
  sc.fillStyle = '#5a4c1a';
  sc.fillRect(sx + 6, 13, 5, 2);

  // Legs — one in front, one behind (profile stagger)
  sc.fillStyle = '#6b5c2a';
  if (lp === 0) {
    sc.fillRect(sx + 7, 15, 3, 4);  // front leg (steps forward)
    sc.fillStyle = '#4a3c18';        // back leg (darker, behind)
    sc.fillRect(sx + 6, 15, 2, 3);
    sc.fillStyle = '#2a1f0a';        // front shoe (extends forward)
    sc.fillRect(sx + 6, 18, 5, 2);
    sc.fillStyle = '#1c1508';        // back shoe
    sc.fillRect(sx + 5, 17, 3, 1);
  } else {
    sc.fillRect(sx + 6, 15, 3, 4);  // front leg (other step)
    sc.fillStyle = '#4a3c18';
    sc.fillRect(sx + 8, 15, 2, 3);  // back leg
    sc.fillStyle = '#2a1f0a';
    sc.fillRect(sx + 5, 18, 5, 2);  // front shoe
    sc.fillStyle = '#1c1508';
    sc.fillRect(sx + 8, 17, 3, 1);  // back shoe
  }
}

function drawSpriteFront(frame) {
  // frame 4-5: front-facing walk
  const sx = frame * SPRITE_W;
  const sc = sctx;
  sc.clearRect(sx, 0, SPRITE_W, SPRITE_H);
  const lp = (frame - 4) % 2;
  // Head (front, both eyes)
  sc.fillStyle = '#f5c8a0'; sc.fillRect(sx + 3, 0, 8, 6);
  sc.fillStyle = '#1a1208';
  sc.fillRect(sx + 4, 1, 2, 2);
  sc.fillRect(sx + 8, 1, 2, 2);
  sc.fillStyle = '#8b3030'; sc.fillRect(sx + 5, 4, 4, 1);
  // Torso (front, wider)
  sc.fillStyle = '#b0a04a'; sc.fillRect(sx + 2, 6, 10, 7);
  sc.fillStyle = '#908030'; sc.fillRect(sx + 6, 7, 2, 5);
  // Pants
  sc.fillStyle = '#6b5c2a';
  sc.fillRect(sx + 2, 13, 4, 7);
  sc.fillRect(sx + 8, 13, 4, 7);
  // Shoes
  sc.fillStyle = '#2a1f0a';
  if (lp === 0) { sc.fillRect(sx + 1, 18, 5, 2); sc.fillRect(sx + 8, 19, 5, 1); }
  else          { sc.fillRect(sx + 1, 19, 5, 1); sc.fillRect(sx + 8, 18, 5, 2); }
  // Arms (both sides)
  sc.fillStyle = '#b0a04a';
  sc.fillRect(sx + 0, 6 + lp, 2, 6);
  sc.fillRect(sx + 12, 6 + (1-lp), 2, 6);
}

function drawSpriteBack(frame) {
  // frame 6-7: back-facing walk
  const sx = frame * SPRITE_W;
  const sc = sctx;
  sc.clearRect(sx, 0, SPRITE_W, SPRITE_H);
  const lp = (frame - 6) % 2;
  // Head (back view – hair)
  sc.fillStyle = '#2a1a08'; sc.fillRect(sx + 3, 0, 8, 5);
  sc.fillStyle = '#f5c8a0'; sc.fillRect(sx + 4, 4, 6, 3);
  // Torso back
  sc.fillStyle = '#a09040'; sc.fillRect(sx + 2, 6, 10, 7);
  sc.fillStyle = '#888028'; sc.fillRect(sx + 6, 7, 2, 5);
  // Pants
  sc.fillStyle = '#5b4c1a';
  sc.fillRect(sx + 2, 13, 4, 7);
  sc.fillRect(sx + 8, 13, 4, 7);
  // Shoes back
  sc.fillStyle = '#2a1f0a';
  if (lp === 0) { sc.fillRect(sx + 2, 18, 4, 2); sc.fillRect(sx + 8, 19, 4, 1); }
  else          { sc.fillRect(sx + 2, 19, 4, 1); sc.fillRect(sx + 8, 18, 4, 2); }
  // Arms back
  sc.fillStyle = '#a09040';
  sc.fillRect(sx + 0, 6 + lp, 2, 6);
  sc.fillRect(sx + 12, 6 + (1-lp), 2, 6);
}

for (let f = 0; f < 4; f++) drawSprite(f);
drawSpriteFront(4); drawSpriteFront(5);
drawSpriteBack(6);  drawSpriteBack(7);

// ── Game state ────────────────────────────────────────────────────────────────
const player = {
  x: PLAYER_START_CX * CELL + CELL / 2,
  y: PLAYER_START_CY * CELL + CELL / 2,
  vx: 0,
  vy: 0,
  frame: 0,
  frameTimer: 0,
  facing: 1,   // 1=right, -1=left
  direction: 'side', // 'side' | 'front' | 'back'
  swimming: false,
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
let houseCells = new Uint8Array(COLS * ROWS);
let windowMaze = new Uint8Array(COLS * ROWS);
let villageHouses = [];
let villageProps = [];
let villagePropsOrdered = [];
let forestRiver = null;
let forestBridge = null;
let forestRiverCells = new Uint8Array(COLS * ROWS);
let forestPaths = [];
let forestPathCells = new Uint8Array(COLS * ROWS);
let minimapBaseCanvas = null;
let forestTerrainCanvas = null;
const treeSpriteCache = new Map();

function isSafeCell(cx, cy) {
  return inBounds(cx, cy) && safeCells[cellIndex(cx, cy)] === 1;
}

function isHouseCell(cx, cy) {
  return inBounds(cx, cy) && houseCells[cellIndex(cx, cy)] === 1;
}

function rectTooClose(ax, ay, aw, ah, bx, by, bw, bh, gap) {
  return !(
    ax + aw - 1 + gap < bx ||
    bx + bw - 1 + gap < ax ||
    ay + ah - 1 + gap < by ||
    by + bh - 1 + gap < ay
  );
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq <= 0.0001) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nx = ax + abx * t;
  const ny = ay + aby * t;
  return Math.hypot(px - nx, py - ny);
}

function minDistanceToPolyline(px, py, points) {
  if (!points || points.length === 0) return Infinity;
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const dist = pointToSegmentDistance(px, py, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
    if (dist < best) best = dist;
  }
  return best;
}

function hasMarkedCellNear(target, cx, cy, radius = 0) {
  const rr = Math.max(0, Math.ceil(radius));
  for (let y = cy - rr; y <= cy + rr; y++) {
    for (let x = cx - rr; x <= cx + rr; x++) {
      if (!inBounds(x, y)) continue;
      if (target[cellIndex(x, y)] === 1) return true;
    }
  }
  return false;
}

function markCellsNearPolyline(target, points, widthCells) {
  if (!points || points.length < 2) return;
  let minX = COLS;
  let maxX = 0;
  let minY = ROWS;
  let maxY = 0;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const pad = Math.ceil(widthCells + 2);
  const startX = Math.max(0, Math.floor(minX - pad));
  const endX = Math.min(COLS - 1, Math.ceil(maxX + pad));
  const startY = Math.max(0, Math.floor(minY - pad));
  const endY = Math.min(ROWS - 1, Math.ceil(maxY + pad));

  for (let cy = startY; cy <= endY; cy++) {
    for (let cx = startX; cx <= endX; cx++) {
      const px = cx + 0.5;
      const py = cy + 0.5;
      if (minDistanceToPolyline(px, py, points) <= widthCells) {
        target[cellIndex(cx, cy)] = 1;
      }
    }
  }
}

function getPolylineXAtY(points, y) {
  if (!points || !points.length) return COLS / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (y < minY || y > maxY) continue;
    const t = maxY === minY ? 0 : (y - a.y) / (b.y - a.y);
    return a.x + (b.x - a.x) * t;
  }
  return points[points.length - 1].x;
}

function isRiverCell(cx, cy) {
  return inBounds(cx, cy) && forestRiverCells[cellIndex(cx, cy)] === 1;
}

function isPathCell(cx, cy) {
  return inBounds(cx, cy) && forestPathCells[cellIndex(cx, cy)] === 1;
}

function isBridgeCell(cx, cy) {
  if (!forestBridge) return false;
  return (
    Math.abs(cx + 0.5 - forestBridge.cx) <= forestBridge.halfWidth &&
    Math.abs(cy + 0.5 - forestBridge.cy) <= forestBridge.halfHeight
  );
}

function rectTouchesRiver(x, y, w, h, padding = 0) {
  for (let cy = y - padding; cy < y + h + padding; cy++) {
    for (let cx = x - padding; cx < x + w + padding; cx++) {
      if (!inBounds(cx, cy)) continue;
      if (isBridgeCell(cx, cy)) continue;
      if (isRiverCell(cx, cy)) return true;
    }
  }
  return false;
}

function pointInBridge(wx, wy) {
  if (!forestBridge) return false;
  const px = wx / CELL;
  const py = wy / CELL;
  return (
    Math.abs(px - forestBridge.cx) <= forestBridge.halfWidth &&
    Math.abs(py - forestBridge.cy) <= forestBridge.halfHeight
  );
}

function pointInForestRiver(wx, wy) {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE || !forestRiver) return false;
  if (pointInBridge(wx, wy)) return false;
  const px = wx / CELL;
  const py = wy / CELL;
  return minDistanceToPolyline(px, py, forestRiver.points) <= forestRiver.halfWidth;
}

function isSwimmingPosition(wx, wy) {
  return currentLocationId === LOCATION_FOREST_VILLAGE && pointInForestRiver(wx, wy);
}

function generateForestRiver() {
  forestRiver = null;
  forestBridge = null;
  forestRiverCells = new Uint8Array(COLS * ROWS);
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;

  const baseX = COLS * (0.36 + worldRandom() * 0.18);
  const swingA = 4.5 + worldRandom() * 1.8;
  const swingB = 2 + worldRandom() * 1.8;
  const phaseA = worldRandom() * Math.PI * 2;
  const phaseB = worldRandom() * Math.PI * 2;
  const points = [];

  for (let y = -2; y <= ROWS + 2; y += 4) {
    const x = baseX
      + Math.sin(y * 0.19 + phaseA) * swingA
      + Math.sin(y * 0.47 + phaseB) * swingB
      + (worldRandom() - 0.5) * 1.4;
    points.push({
      x: Math.max(8.5, Math.min(COLS - 7.5, x + 0.5)),
      y: y + 0.5,
    });
  }

  const halfWidth = 1.45 + worldRandom() * 0.25;
  forestRiver = { points, halfWidth };
  markCellsNearPolyline(forestRiverCells, points, halfWidth + 0.85);

  const bridgeY = Math.max(12.5, Math.min(ROWS - 11.5, Math.floor(ROWS * (0.48 + (worldRandom() - 0.5) * 0.12)) + 0.5));
  const bridgeX = getPolylineXAtY(points, bridgeY);
  forestBridge = {
    cx: bridgeX,
    cy: bridgeY,
    halfWidth: halfWidth + 1.7,
    halfHeight: 0.72,
  };
}

function createForestTrail(start, end, wobble = 2.5) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const steps = Math.max(4, Math.ceil(len / 6));
  const phase = worldRandom() * Math.PI * 2;
  const points = [{ x: start.x, y: start.y }];

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const swell = Math.sin(t * Math.PI);
    const drift = Math.sin(t * Math.PI * 2 + phase) * wobble * 0.45 + (worldRandom() - 0.5) * wobble;
    points.push({
      x: start.x + dx * t + nx * drift * swell,
      y: start.y + dy * t + ny * drift * swell,
    });
  }

  points.push({ x: end.x, y: end.y });
  return points;
}

function pushForestPath(start, end, wobble = 2.5) {
  const path = createForestTrail(start, end, wobble);
  forestPaths.push(path);
  markCellsNearPolyline(forestPathCells, path, 0.72);
}

function getHousePathAnchor(house, towardX, towardY) {
  const anchors = [];
  for (const win of (house.windows || [])) {
    const d = DIR[win.bit];
    anchors.push({
      x: win.cx + 0.5 + d.dx * 0.78,
      y: win.cy + 0.5 + d.dy * 0.78,
    });
  }

  if (!anchors.length) {
    anchors.push({ x: house.x - 0.35, y: house.centerCY + 0.5 });
    anchors.push({ x: house.x + house.w + 0.35, y: house.centerCY + 0.5 });
    anchors.push({ x: house.centerCX + 0.5, y: house.y - 0.35 });
    anchors.push({ x: house.centerCX + 0.5, y: house.y + house.h + 0.35 });
  }

  let best = anchors[0];
  let bestDist = Infinity;
  for (const anchor of anchors) {
    const dist = Math.hypot(anchor.x - towardX, anchor.y - towardY);
    if (dist < bestDist) {
      best = anchor;
      bestDist = dist;
    }
  }
  return best;
}

function connectForestPoiCluster(seedNodes, targets) {
  const connected = seedNodes.slice();
  const remaining = targets.slice();

  while (remaining.length) {
    let best = null;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      for (const anchor of connected) {
        const from = anchor.resolvePoint ? anchor.resolvePoint(candidate.x, candidate.y) : { x: anchor.x, y: anchor.y };
        const to = candidate.resolvePoint ? candidate.resolvePoint(from.x, from.y) : { x: candidate.x, y: candidate.y };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const score = dist + (candidate.kind === 'camp' ? 4 : 0) + (candidate.kind === 'house' ? 0 : 1.5);
        if (!best || score < best.score) {
          best = { index: i, candidate, anchor, from, to, dist, score };
        }
      }
    }

    const wobble = Math.max(0.85, Math.min(2.05, 0.9 + best.dist * 0.05));
    pushForestPath(best.from, best.to, wobble);
    connected.push(best.candidate);
    remaining.splice(best.index, 1);
  }
}

function generateForestPaths() {
  forestPaths = [];
  forestPathCells = new Uint8Array(COLS * ROWS);
  if (currentLocationId !== LOCATION_FOREST_VILLAGE || !forestBridge) return;

  const leftBridge = { x: forestBridge.cx - (forestBridge.halfWidth + 0.6), y: forestBridge.cy };
  const rightBridge = { x: forestBridge.cx + (forestBridge.halfWidth + 0.6), y: forestBridge.cy };
  const leftSeeds = [
    { x: leftBridge.x, y: leftBridge.y, kind: 'bridge' },
    { x: PLAYER_START_CX + 0.5, y: PLAYER_START_CY + 0.5, kind: 'spawn' },
    { x: MONSTER_START_CX + 1.5, y: MONSTER_START_CY + 1.5, kind: 'spawn' },
  ];
  const rightSeeds = [
    { x: rightBridge.x, y: rightBridge.y, kind: 'bridge' },
    { x: EXIT_CX + 0.5, y: EXIT_CY + 0.5, kind: 'exit' },
  ];
  const leftTargets = [];
  const rightTargets = [];

  for (const house of villageHouses) {
    const point = {
      x: house.centerCX + 0.5,
      y: house.centerCY + 0.5,
      kind: 'house',
      resolvePoint: (towardX, towardY) => getHousePathAnchor(house, towardX, towardY),
    };
    if (point.x < forestBridge.cx) leftTargets.push(point);
    else rightTargets.push(point);
  }

  for (const prop of villageProps) {
    if (prop.type !== 'campfire') continue;
    const point = { x: prop.cx + 0.5, y: prop.cy + 0.5, kind: 'camp' };
    if (point.x < forestBridge.cx) leftTargets.push(point);
    else rightTargets.push(point);
  }

  pushForestPath({ x: PLAYER_START_CX + 0.5, y: PLAYER_START_CY + 0.5 }, leftBridge, 2.2);
  pushForestPath(rightBridge, { x: EXIT_CX + 0.5, y: EXIT_CY + 0.5 }, 2.4);
  connectForestPoiCluster(leftSeeds, leftTargets);
  connectForestPoiCluster(rightSeeds, rightTargets);
}

function markSafeZoneArea(x, y, w, h, extra = {}) {
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      safeCells[cellIndex(cx, cy)] = 1;
    }
  }

  safeRooms.push({
    x,
    y,
    w,
    h,
    centerCX: x + ((w - 1) >> 1),
    centerCY: y + ((h - 1) >> 1),
    type: 'room',
    label: 'SAFE',
    ...extra,
  });
}

function carveSafeRoom(x, y, w, h) {
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
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

  markSafeZoneArea(x, y, w, h);
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

function clearCellConnections(cx, cy) {
  const idx = cellIndex(cx, cy);
  const bits = maze[idx];
  for (const d of DIR) {
    if (!(bits & (1 << d.bit))) continue;
    const nx = cx + d.dx;
    const ny = cy + d.dy;
    if (!inBounds(nx, ny)) continue;
    maze[cellIndex(nx, ny)] &= ~(1 << d.opp);
  }
  maze[idx] = 0;
}

function generateHouseFurniture({ x, y, w, h }) {
  const items = [];
  const left = x * CELL + 18;
  const top = y * CELL + 18;
  const right = (x + w) * CELL - 18;
  const bottom = (y + h) * CELL - 18;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const roomW = Math.max(26, right - left);
  const roomH = Math.max(26, bottom - top);

  items.push({
    type: 'rug',
    x: centerX,
    y: centerY + 4,
    width: Math.max(28, Math.min(roomW - 8, 28 + w * 8)),
    height: Math.max(20, Math.min(roomH - 10, 20 + h * 6)),
    tint: worldRandom() < 0.5 ? 'warm' : 'teal',
  });

  const tableX = centerX + (worldRandom() - 0.5) * 10;
  const tableY = centerY + (worldRandom() - 0.5) * 8;
  items.push({ type: 'table', x: tableX, y: tableY, width: 24 + Math.min(18, w * 3), height: 14 + Math.min(12, h * 2) });
  items.push({ type: 'chair', x: tableX - 16, y: tableY + 6, facing: 'left' });
  items.push({ type: 'chair', x: tableX + 16, y: tableY + 6, facing: 'right' });
  if (h >= 4) items.push({ type: 'chair', x: tableX, y: tableY - 12, facing: 'up' });

  items.push({
    type: 'cabinet',
    x: right - 10,
    y: top + 18,
    width: 16,
    height: Math.min(34, 18 + h * 4),
  });

  items.push({
    type: 'armchair',
    x: left + 16,
    y: top + 20,
    width: 18,
    height: 18,
    tint: worldRandom() < 0.5 ? 'olive' : 'brown',
  });

  if (w >= 5 || h >= 5) {
    items.push({
      type: 'bed',
      x: left + 24,
      y: bottom - 14,
      width: Math.min(34, roomW * 0.45),
      height: 18,
      blanket: worldRandom() < 0.5 ? 'blue' : 'green',
    });
  }

  items.push({
    type: 'crate',
    x: right - 20,
    y: bottom - 10,
    width: 14,
    height: 12,
  });

  if (w >= 5) {
    items.push({
      type: 'shelf',
      x: centerX,
      y: top + 12,
      width: Math.min(34, roomW * 0.42),
      height: 10,
    });
  }

  return items;
}

function carveVillageHouse(x, y, w, h) {
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      clearCellConnections(cx, cy);
      houseCells[cellIndex(cx, cy)] = 1;
    }
  }

  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      if (cx + 1 < x + w) openBetweenCells(cx, cy, cx + 1, cy);
      if (cy + 1 < y + h) openBetweenCells(cx, cy, cx, cy + 1);
    }
  }

  const doors = [];
  for (let cx = x + 1; cx < x + w - 1; cx++) {
    doors.push({ cx, cy: y, bit: 0 });
    doors.push({ cx, cy: y + h - 1, bit: 2 });
  }
  for (let cy = y + 1; cy < y + h - 1; cy++) {
    doors.push({ cx: x, cy, bit: 3 });
    doors.push({ cx: x + w - 1, cy, bit: 1 });
  }

  for (let i = doors.length - 1; i > 0; i--) {
    const j = Math.floor(worldRandom() * (i + 1));
    [doors[i], doors[j]] = [doors[j], doors[i]];
  }

  let opened = 0;
  const usedSides = new Set();
  for (const door of doors) {
    const d = DIR[door.bit];
    const nx = door.cx + d.dx;
    const ny = door.cy + d.dy;
    if (!inBounds(nx, ny) || isHouseCell(nx, ny)) continue;
    if (usedSides.has(door.bit)) continue;
    openPassage(door.cx, door.cy, door.bit);
    usedSides.add(door.bit);
    opened++;
    if (opened >= 2) break;
  }

  // ── Windows: player-only passages on remaining sides ──
  const houseWindows = [];
  const windowCandidates = [];
  for (let cx = x + 1; cx < x + w - 1; cx++) {
    if (!usedSides.has(0)) windowCandidates.push({ cx, cy: y,     bit: 0 });
    if (!usedSides.has(2)) windowCandidates.push({ cx, cy: y+h-1, bit: 2 });
  }
  for (let cy = y + 1; cy < y + h - 1; cy++) {
    if (!usedSides.has(3)) windowCandidates.push({ cx: x,     cy, bit: 3 });
    if (!usedSides.has(1)) windowCandidates.push({ cx: x+w-1, cy, bit: 1 });
  }
  for (let i = windowCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(worldRandom() * (i + 1));
    [windowCandidates[i], windowCandidates[j]] = [windowCandidates[j], windowCandidates[i]];
  }
  let winOpened = 0;
  const winUsedSides = new Set();
  for (const win of windowCandidates) {
    if (winUsedSides.has(win.bit)) continue;
    const d = DIR[win.bit];
    const nx = win.cx + d.dx;
    const ny = win.cy + d.dy;
    if (!inBounds(nx, ny) || isHouseCell(nx, ny)) continue;
    openPassage(win.cx, win.cy, win.bit);
    windowMaze[cellIndex(win.cx, win.cy)] |= (1 << win.bit);
    windowMaze[cellIndex(nx, ny)] |= (1 << d.opp);
    houseWindows.push({ cx: win.cx, cy: win.cy, bit: win.bit });
    winUsedSides.add(win.bit);
    winOpened++;
    if (winOpened >= 2) break;
  }

  const house = {
    x,
    y,
    w,
    h,
    centerCX: x + ((w - 1) >> 1),
    centerCY: y + ((h - 1) >> 1),
    roofTone: 24 + Math.floor(worldRandom() * 30),
    wallTone: 44 + Math.floor(worldRandom() * 26),
    glow: 0.45 + worldRandom() * 0.35,
    windows: houseWindows,
  };
  house.furniture = generateHouseFurniture(house);
  villageHouses.push(house);
}

function generateVillageHouses() {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;

  let attempts = 0;
  while (villageHouses.length < 18 && attempts < 2400) {
    attempts++;
    const sizeRoll = worldRandom();
    const w = sizeRoll < 0.2 ? 6 + Math.floor(worldRandom() * 2) : 3 + Math.floor(worldRandom() * 4);
    const h = sizeRoll < 0.2 ? 5 + Math.floor(worldRandom() * 2) : 3 + Math.floor(worldRandom() * 4);
    const x = 2 + Math.floor(worldRandom() * (COLS - w - 4));
    const y = 2 + Math.floor(worldRandom() * (ROWS - h - 4));
    const centerCX = x + ((w - 1) >> 1);
    const centerCY = y + ((h - 1) >> 1);

    const playerDist = Math.hypot(centerCX - PLAYER_START_CX, centerCY - PLAYER_START_CY);
    const exitDist = Math.hypot(centerCX - EXIT_CX, centerCY - EXIT_CY);
    const monsterDist = Math.hypot(centerCX - MONSTER_START_CX, centerCY - MONSTER_START_CY);
    if (playerDist < 9 || exitDist < 7 || monsterDist < 7) continue;
    if (rectTouchesRiver(x, y, w, h, 2)) continue;
    if (hasMarkedCellNear(forestRiverCells, centerCX, centerCY, 2)) continue;
    if (isBridgeCell(centerCX, centerCY)) continue;

    let blocked = false;
    for (const room of safeRooms) {
      if (rectTooClose(x, y, w, h, room.x, room.y, room.w, room.h, 4)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    for (const house of villageHouses) {
      if (rectTooClose(x, y, w, h, house.x, house.y, house.w, house.h, 4)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    carveVillageHouse(x, y, w, h);
  }
}

function isVillagePropPlacementAllowed(cx, cy, minDistance = 0, minPropGap = 1.2, options = {}) {
  const {
    avoidPaths = false,
    pathGap = 0,
  } = options;
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return false;
  if (!inBounds(cx, cy) || !maze[cellIndex(cx, cy)]) return false;
  if (isSafeCell(cx, cy) || isHouseCell(cx, cy)) return false;
  if (isRiverCell(cx, cy) || isBridgeCell(cx, cy)) return false;
  if (Math.hypot(cx - PLAYER_START_CX, cy - PLAYER_START_CY) < minDistance) return false;
  if (Math.hypot(cx - EXIT_CX, cy - EXIT_CY) < minDistance) return false;
  if (Math.hypot(cx - MONSTER_START_CX, cy - MONSTER_START_CY) < minDistance) return false;
  if (avoidPaths && hasMarkedCellNear(forestPathCells, cx, cy, pathGap)) return false;
  return !villageProps.some(prop => Math.hypot(prop.cx - cx, prop.cy - cy) < minPropGap);
}

function pushVillageProp(prop) {
  villageProps.push({
    ...prop,
    x: prop.cx * CELL + CELL / 2 + (prop.offsetX || 0),
    y: prop.cy * CELL + CELL / 2 + (prop.offsetY || 0),
  });
}

function generateVillageProps() {
  villageProps = [];
  forestPaths = [];
  forestPathCells = new Uint8Array(COLS * ROWS);
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;

  let campCount = 0;
  let campAttempts = 0;
  while (campCount < 18 && campAttempts < 1800) {
    campAttempts++;
    const cx = 3 + Math.floor(worldRandom() * (COLS - 6));
    const cy = 3 + Math.floor(worldRandom() * (ROWS - 6));
    if (!isVillagePropPlacementAllowed(cx, cy, 6, 2.4)) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 2)) continue;

    pushVillageProp({
      type: 'campfire',
      cx,
      cy,
      blocking: true,
      shape: 'circle',
      radius: 9,
      flicker: worldRandom() * Math.PI * 2,
    });
    campCount++;

    const tentSpots = [
      { cx: cx + 1, cy },
      { cx: cx - 1, cy },
      { cx, cy: cy + 1 },
      { cx, cy: cy - 1 },
      { cx: cx + 1, cy: cy + 1 },
      { cx: cx - 1, cy: cy - 1 },
      { cx: cx + 1, cy: cy - 1 },
      { cx: cx - 1, cy: cy + 1 },
      { cx: cx + 2, cy },
      { cx: cx - 2, cy },
      { cx, cy: cy + 2 },
      { cx, cy: cy - 2 },
    ].sort(() => worldRandom() - 0.5);

    const tentTarget = 2 + Math.floor(worldRandom() * 3);
    let tentsPlaced = 0;
    for (const spot of tentSpots) {
      if (!isVillagePropPlacementAllowed(spot.cx, spot.cy, 1, 1.55)) continue;
      if (hasMarkedCellNear(forestRiverCells, spot.cx, spot.cy, 1)) continue;
      pushVillageProp({
        type: 'tent',
        cx: spot.cx,
        cy: spot.cy,
        blocking: false,
        shape: 'rect',
        width: 30 + worldRandom() * 6,
        height: 20 + worldRandom() * 4,
        entranceSide: worldRandom() < 0.5 ? -1 : 1,
      });
      tentsPlaced++;
      if (tentsPlaced >= tentTarget) break;
    }

    if (worldRandom() < 0.9) {
      const logSpots = [
        { cx: cx + 1, cy: cy + 2 },
        { cx: cx - 1, cy: cy - 2 },
        { cx: cx + 2, cy: cy - 1 },
        { cx: cx - 2, cy: cy + 1 },
      ].sort(() => worldRandom() - 0.5);

      for (const spot of logSpots.slice(0, 2)) {
        if (!isVillagePropPlacementAllowed(spot.cx, spot.cy, 1, 1.25)) continue;
        pushVillageProp({
          type: 'log',
          cx: spot.cx,
          cy: spot.cy,
          blocking: true,
          shape: 'rect',
          width: 24 + worldRandom() * 12,
          height: 9 + worldRandom() * 3,
          angle: worldRandom() * Math.PI,
        });
      }
    }
  }

  generateForestPaths();

  let treeCount = 0;
  let treeAttempts = 0;
  while (treeCount < 580 && treeAttempts < 7600) {
    treeAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 4, 0.96, { avoidPaths: true, pathGap: 0 })) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    const dead = worldRandom() < 0.16;
    pushVillageProp({
      type: dead ? 'deadTree' : 'tree',
      cx,
      cy,
      blocking: true,
      shape: 'circle',
      radius: dead ? 10 + worldRandom() * 3 : 13 + worldRandom() * 7,
      sway: worldRandom() * Math.PI * 2,
      size: 1.15 + worldRandom() * 0.55,
    });
    treeCount++;
  }

  let bushCount = 0;
  let bushAttempts = 0;
  while (bushCount < 140 && bushAttempts < 3200) {
    bushAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 2, 0.8, { avoidPaths: true, pathGap: 0 })) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    const dense = worldRandom() < 0.28;
    pushVillageProp({
      type: 'bush',
      cx,
      cy,
      blocking: dense,
      shape: 'circle',
      radius: dense ? 8 + worldRandom() * 4 : 0,
      size: 0.8 + worldRandom() * 0.5,
      tint: worldRandom(),
    });
    bushCount++;
  }

  let rockCount = 0;
  let rockAttempts = 0;
  while (rockCount < 90 && rockAttempts < 2200) {
    rockAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 3, 1.08, { avoidPaths: true, pathGap: 0 })) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    pushVillageProp({
      type: 'rock',
      cx,
      cy,
      blocking: true,
      shape: 'circle',
      radius: 8 + worldRandom() * 6,
      width: 16 + worldRandom() * 12,
      height: 12 + worldRandom() * 10,
      tilt: worldRandom() * Math.PI,
    });
    rockCount++;
  }

  let stumpCount = 0;
  let stumpAttempts = 0;
  while (stumpCount < 42 && stumpAttempts < 1200) {
    stumpAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 3, 1.14, { avoidPaths: true, pathGap: 0 })) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    pushVillageProp({
      type: 'stump',
      cx,
      cy,
      blocking: true,
      shape: 'circle',
      radius: 8 + worldRandom() * 2,
      width: 14 + worldRandom() * 8,
      height: 10 + worldRandom() * 5,
    });
    stumpCount++;
  }

  let mushCount = 0, mushAttempts = 0;
  while (mushCount < 90 && mushAttempts < 2200) {
    mushAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 2, 0.65)) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    pushVillageProp({
      type: 'mushroom', cx, cy,
      blocking: false, shape: 'circle', radius: 0,
      red: worldRandom() < 0.55,
      size: 0.7 + worldRandom() * 0.55,
    });
    mushCount++;
  }

  let barrelCount = 0, barrelAttempts = 0;
  while (barrelCount < 32 && barrelAttempts < 1000) {
    barrelAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 3, 1.4)) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    pushVillageProp({
      type: 'barrel', cx, cy,
      blocking: true, shape: 'circle', radius: 10,
      broken: worldRandom() < 0.22,
    });
    barrelCount++;
  }

  let lanternCount = 0, lanternAttempts = 0;
  while (lanternCount < 20 && lanternAttempts < 800) {
    lanternAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 3, 1.8, { avoidPaths: false })) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    // Place near paths / houses preferred but random is fine
    pushVillageProp({
      type: 'lantern', cx, cy,
      blocking: false, shape: 'circle', radius: 0,
      flicker: worldRandom() * Math.PI * 2,
    });
    lanternCount++;
  }

  let logCount = 0;
  let logAttempts = 0;
  while (logCount < 28 && logAttempts < 900) {
    logAttempts++;
    const cx = 1 + Math.floor(worldRandom() * (COLS - 2));
    const cy = 1 + Math.floor(worldRandom() * (ROWS - 2));
    if (!isVillagePropPlacementAllowed(cx, cy, 3, 1.12, { avoidPaths: true, pathGap: 0 })) continue;
    if (hasMarkedCellNear(forestRiverCells, cx, cy, 1)) continue;
    pushVillageProp({
      type: 'log',
      cx,
      cy,
      blocking: true,
      shape: 'rect',
      width: 26 + worldRandom() * 12,
      height: 8 + worldRandom() * 4,
      angle: worldRandom() * Math.PI,
    });
    logCount++;
  }

  villagePropsOrdered = villageProps.slice().sort((a, b) => a.y - b.y);
}

function pointInVillageObstacle(wx, wy, { allowWater = false } = {}) {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return false;
  if (!allowWater && pointInForestRiver(wx, wy)) return true;
  for (const prop of villageProps) {
    if (!prop.blocking) continue;
    if (prop.shape === 'circle') {
      if (Math.hypot(wx - prop.x, wy - prop.y) <= prop.radius) return true;
      continue;
    }
    if (prop.shape === 'rect') {
      const hw = prop.width / 2;
      const hh = prop.height / 2;
      if (wx >= prop.x - hw && wx <= prop.x + hw && wy >= prop.y - hh && wy <= prop.y + hh) return true;
    }
  }
  return false;
}

function isBlockedNavigationCell(cx, cy) {
  return pointInVillageObstacle(cx * CELL + CELL / 2, cy * CELL + CELL / 2);
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
      if (maze[cellIndex(cx, cy)] > 0 && !isSafeCell(cx, cy) && !pointInVillageObstacle(cx * CELL + CELL / 2, cy * CELL + CELL / 2)) pool.push({ cx, cy });
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

// ── Weapons ───────────────────────────────────────────────────────────────────
const WEAPON_COUNT = 60;
let weapons = [];
let ammo = 0; // shots in hand
const MAX_AMMO = 5;

function spawnWeapons() {
  weapons = [];
  const pool = [];
  for (let cy = 2; cy < ROWS - 2; cy++)
    for (let cx = 2; cx < COLS - 2; cx++)
      if (maze[cellIndex(cx, cy)] > 0 && !isSafeCell(cx, cy) && !pointInVillageObstacle(cx * CELL + CELL / 2, cy * CELL + CELL / 2)) pool.push({ cx, cy });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(worldRandom() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Skip first slots used by almond waters
  const start = Math.min(ALMOND_COUNT, pool.length);
  for (let i = start; i < Math.min(start + WEAPON_COUNT, pool.length); i++) {
    weapons.push({
      x: pool[i].cx * CELL + CELL / 2,
      y: pool[i].cy * CELL + CELL / 2,
      bob: worldRandom() * Math.PI * 2,
      picked: false,
    });
  }
}

// ── Bullets ───────────────────────────────────────────────────────────────────
const BULLET_SPEED  = 10;
const BULLET_RADIUS = 6;
const STUN_DURATION = 3;
let bullets = [];
let monsterStunTime = 0;

function fireBullet(angle) {
  if (ammo <= 0) return;
  ammo--;
  updateAmmoHud();
  bullets.push({
    x: player.x,
    y: player.y,
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    life: 1.2, // seconds
  });
}

function updateAmmoHud() {
  const el = document.getElementById('ammoHud');
  if (!el) return;
  el.innerHTML = '';
  for (let i = 0; i < MAX_AMMO; i++) {
    const b = document.createElement('div');
    b.className = 'ammoBullet' + (i >= ammo ? ' spent' : '');
    el.appendChild(b);
  }
}

function initializeWorld(seed, locationId = null) {
  currentWorldSeed = (seed >>> 0) || hashString(`world:${Date.now()}`);
  worldRandom = createSeededRandom(currentWorldSeed);
  applyLocationTheme(locationId || getLocationFromSeed(currentWorldSeed));
  maze = new Uint8Array(COLS * ROWS);
  safeCells = new Uint8Array(COLS * ROWS);
  safeRooms = [];
  houseCells = new Uint8Array(COLS * ROWS);
  windowMaze = new Uint8Array(COLS * ROWS);
  villageHouses = [];
  villageProps = [];
  villagePropsOrdered = [];
  forestRiver = null;
  forestBridge = null;
  forestRiverCells = new Uint8Array(COLS * ROWS);
  forestPaths = [];
  forestPathCells = new Uint8Array(COLS * ROWS);
  minimapBaseCanvas = null;
  forestTerrainCanvas = null;
  almondWaters = [];
  weapons = [];
  bullets = [];

  if (currentLocationId === LOCATION_FOREST_VILLAGE) generateOpenForestWorld();
  else generateMaze();

  maze[cellIndex(EXIT_CX, EXIT_CY)] |= 0b1111;
  maze[cellIndex(EXIT_CX, EXIT_CY - 1)] |= 0b1111;
  maze[cellIndex(EXIT_CX - 1, EXIT_CY)] |= 0b1111;

  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    generateForestRiver();
    generateVillageHouses();
    generateVillageProps();
    rebuildForestTerrainCanvas();
  } else {
    generateSafeRooms();
  }
  spawnAlmondWaters();
  spawnWeapons();
  rebuildMinimapBase();
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
      if (windowMaze[cellIndex(cx, cy)] & (1 << d.bit)) continue; // windows: player only
      const nx = cx + d.dx, ny = cy + d.dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      if (isBlockedNavigationCell(nx, ny) && (nx !== toCX || ny !== toCY)) continue;
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
  return inBounds(cx, cy) && !isSafeCell(cx, cy) && !isBlockedNavigationCell(cx, cy);
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
  player.direction = 'side';
  player.swimming = false;
  playerWasInSafeRoom = false;
  speedBoostLeft = 0;
  playerDead  = false;
  deathTimer  = 0;
  // Reset weapon state
  ammo = 0;
  bullets = [];
  monsterStunTime = 0;
  for (const w of weapons) w.picked = false;
  updateAmmoHud();
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
    direction: player.direction,
    frame: player.frame,
    moving: player.moving,
    swimming: player.swimming,
    alive: !playerDead,
    inSafeRoom: isSafeCell(cx, cy),
    boostUntil: speedBoostLeft > 0 ? Date.now() + Math.round(speedBoostLeft * 1000) : 0,
    lastUpdate: Date.now(),
  };
}

function syncRemoteVisuals(playersSnapshot = {}) {
  const now = Date.now();
  const nextVisuals = {};

  for (const [uid, playerData] of Object.entries(playersSnapshot)) {
    if (uid === online.localUid) continue;

    const targetX = playerData.x ?? (PLAYER_START_CX * CELL + CELL / 2);
    const targetY = playerData.y ?? (PLAYER_START_CY * CELL + CELL / 2);
    const serverTime = playerData.lastUpdate || now;
    const prev = online.remoteVisuals[uid];

    let displayX = targetX;
    let displayY = targetY;
    let velocityX = 0;
    let velocityY = 0;

    if (prev) {
      displayX = prev.displayX;
      displayY = prev.displayY;
      velocityX = prev.velocityX || 0;
      velocityY = prev.velocityY || 0;

      if (serverTime === prev.serverTime && targetX === prev.targetX && targetY === prev.targetY) {
        nextVisuals[uid] = {
          ...prev,
          facing: playerData.facing ?? prev.facing ?? 1,
          direction: playerData.direction ?? prev.direction ?? 'side',
          frame: playerData.frame ?? prev.frame ?? 0,
          moving: playerData.moving ?? prev.moving ?? false,
          swimming: !!(playerData.swimming ?? prev.swimming),
          alive: playerData.alive !== false,
          name: playerData.name || prev.name || shortNameForPlayer(uid),
          color: playerData.color || prev.color || colorForPlayer(uid),
        };
        continue;
      }

      const dtServer = Math.min(0.25, Math.max(0.016, (serverTime - (prev.serverTime || serverTime)) / 1000));
      const dx = targetX - prev.targetX;
      const dy = targetY - prev.targetY;
      velocityX = dx / dtServer;
      velocityY = dy / dtServer;

      const teleportDist = Math.hypot(targetX - prev.displayX, targetY - prev.displayY);
      if (teleportDist > CELL * 3.5 || playerData.alive === false) {
        displayX = targetX;
        displayY = targetY;
        velocityX = 0;
        velocityY = 0;
      }
    }

    nextVisuals[uid] = {
      uid,
      targetX,
      targetY,
      displayX,
      displayY,
      velocityX,
      velocityY,
      serverTime,
      receivedAt: now,
      facing: playerData.facing ?? prev?.facing ?? 1,
      direction: playerData.direction ?? prev?.direction ?? 'side',
      frame: playerData.frame ?? prev?.frame ?? 0,
      moving: playerData.moving ?? prev?.moving ?? false,
      swimming: !!(playerData.swimming ?? prev?.swimming),
      alive: playerData.alive !== false,
      name: playerData.name || shortNameForPlayer(uid),
      color: playerData.color || colorForPlayer(uid),
    };
  }

  online.remoteVisuals = nextVisuals;
}

function updateRemoteVisuals(dt) {
  if (!online.enabled) return;

  const smoothing = 1 - Math.exp(-dt * 16);
  const now = Date.now();

  for (const remote of Object.values(online.remoteVisuals)) {
    if (!remote.alive) continue;

    const extrapolation = Math.min(REMOTE_EXTRAPOLATION_MAX, Math.max(0, (now - remote.receivedAt) / 1000));
    const predictedX = remote.targetX + remote.velocityX * extrapolation;
    const predictedY = remote.targetY + remote.velocityY * extrapolation;

    const snapDist = Math.hypot(predictedX - remote.displayX, predictedY - remote.displayY);
    if (snapDist > CELL * 2.25) {
      remote.displayX = predictedX;
      remote.displayY = predictedY;
      continue;
    }

    remote.displayX += (predictedX - remote.displayX) * smoothing;
    remote.displayY += (predictedY - remote.displayY) * smoothing;
  }
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
    const nextSeed = meta.seed >>> 0;
    const nextLocationId = normalizeLocationId(meta.locationId || getLocationFromSeed(nextSeed));
    if (nextSeed && (nextSeed !== online.roomSeed || nextLocationId !== online.roomLocationId)) {
      online.roomSeed = nextSeed;
      online.roomLocationId = nextLocationId;
      initializeWorld(online.roomSeed, online.roomLocationId);
      restartGame({ resetSharedState: true });
    }
  }));

  online.roomListeners.push(onValue(playersRef, snapshot => {
    online.players = snapshot.val() || {};
    syncRemoteVisuals(online.players);
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

async function joinRoom(roomId, { create = false, locationId = null } = {}) {
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
  const selectedLocationId = normalizeLocationId(locationId || selectedCreateLocationId);

  if (create) {
    await runTransaction(metaRef, current => current || {
      seed,
      createdAt: Date.now(),
      maxPlayers: MAX_PLAYERS,
      locationId: selectedLocationId,
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
  online.roomLocationId = normalizeLocationId(roomMeta.locationId || getLocationFromSeed(online.roomSeed));
  online.joinLink = getRoomUrl(roomId);
  online.sharedPickedWaters = {};
  online.monsterSnapshot = null;
  online.winState = null;
  online.safeFlags = {};
  online.remoteVisuals = {};
  online.lastSentSnapshot = null;

  updateRoomShareUi();
  roomCodeInput.value = roomId;
  window.history.replaceState({}, '', online.joinLink);

  const localPlayerRef = ref(firebaseDb, `rooms/${roomId}/players/${online.localUid}`);
  onDisconnect(localPlayerRef).remove().catch(() => {});

  bindRoomListeners(roomId);
  initializeWorld(online.roomSeed, online.roomLocationId);
  restartGame({ resetSharedState: true });
  await claimHostIfNeeded();
  setOverlayVisible(false);
  setLobbyStatus(`Connected to room ${roomId} (${getLocationLabel(online.roomLocationId)}).`);
  return true;
}

async function syncLocalPlayerToRoom(force = false) {
  if (!online.enabled || !firebaseReady || !online.roomId || !online.localUid) return;
  const snapshot = getLocalPlayerSnapshot();
  const prev = online.lastSentSnapshot;
  const stateChanged = !prev ||
    snapshot.moving !== prev.moving ||
    snapshot.facing !== prev.facing ||
    snapshot.direction !== prev.direction ||
    snapshot.swimming !== prev.swimming ||
    snapshot.alive !== prev.alive ||
    snapshot.inSafeRoom !== prev.inSafeRoom;
  if (!force && !stateChanged && online.syncTimer > 0) return;
  online.syncTimer = snapshot.moving ? REMOTE_SYNC_INTERVAL_MOVING : REMOTE_SYNC_INTERVAL_IDLE;

  online.players[online.localUid] = snapshot;
  online.lastSentSnapshot = snapshot;
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

// ── Shoot joystick ────────────────────────────────────────────────────────────
const shootBase      = document.getElementById('shootBase');
const shootKnob      = document.getElementById('shootKnob');
const SHOOT_JOY_RADIUS = 36;
let shootActive = false;
let shootStartX = 0, shootStartY = 0;
let shootRawDX = 0, shootRawDY = 0; // clamped knob offsets in px

shootBase.addEventListener('pointerdown', e => {
  e.preventDefault();
  shootBase.setPointerCapture(e.pointerId);
  const r = shootBase.getBoundingClientRect();
  shootStartX = r.left + r.width / 2;
  shootStartY = r.top + r.height / 2;
  shootActive = true;
  shootRawDX = 0; shootRawDY = 0;
  shootKnob.style.transform = 'translate(0,0)';
});

shootBase.addEventListener('pointermove', e => {
  if (!shootActive) return;
  e.preventDefault();
  let dx = e.clientX - shootStartX;
  let dy = e.clientY - shootStartY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > SHOOT_JOY_RADIUS) { dx *= SHOOT_JOY_RADIUS / dist; dy *= SHOOT_JOY_RADIUS / dist; }
  shootRawDX = dx;
  shootRawDY = dy;
  shootKnob.style.transform = `translate(${dx}px, ${dy}px)`;
});

function onShootEnd() {
  if (!shootActive) return;
  shootActive = false;
  // Only fire if dragged far enough (≥25% of radius)
  const nx = shootRawDX / SHOOT_JOY_RADIUS;
  const ny = shootRawDY / SHOOT_JOY_RADIUS;
  if (Math.sqrt(nx * nx + ny * ny) > 0.25) {
    fireBullet(Math.atan2(ny, nx));
  }
  shootRawDX = 0; shootRawDY = 0;
  shootKnob.style.transform = 'translate(0,0)';
}

shootBase.addEventListener('pointerup',     () => onShootEnd());
shootBase.addEventListener('pointercancel', () => {
  shootActive = false;
  shootRawDX = 0; shootRawDY = 0;
  shootKnob.style.transform = 'translate(0,0)';
});

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
  if (pointInVillageObstacle(wx, wy, { allowWater: true })) return true;
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
  updateAmmoHud();
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let lastTime = 0;

function update(dt) {
  applySharedStateToLocalWorld();
  if (online.enabled) {
    online.syncTimer = Math.max(0, online.syncTimer - dt);
    online.monsterSyncTimer = Math.max(0, online.monsterSyncTimer - dt);
    updateRemoteVisuals(dt);
  }

  // Stun countdown
  monsterStunTime = Math.max(0, monsterStunTime - dt);

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

  const waterSpeedScale = isSwimmingPosition(player.x, player.y) ? 0.58 : 1;
  const speed = PLAYER_SPEED * (speedBoostLeft > 0 ? BOOST_MULT : 1) * waterSpeedScale;
  const vx = mx * speed;
  const vy = my * speed;

  player.moving = (Math.abs(vx) + Math.abs(vy)) > 0.1;
  if (vx > 0.05) player.facing = 1;
  else if (vx < -0.05) player.facing = -1;
  if (Math.abs(vy) > Math.abs(vx) + 0.05) {
    player.direction = vy > 0 ? 'front' : 'back';
  } else if (Math.abs(vx) > 0.05) {
    player.direction = 'side';
  }

  // Move X
  const nx = player.x + vx;
  if (!collides(nx, player.y)) player.x = nx;
  // Move Y
  const ny = player.y + vy;
  if (!collides(player.x, ny)) player.y = ny;
  player.swimming = isSwimmingPosition(player.x, player.y);

  // Animate
  if (player.moving) {
    player.frameTimer += dt * 60;
    if (player.frameTimer > (player.swimming ? 6 : 10)) {
      player.frameTimer = 0;
      player.frame = (player.frame + 1) % (player.swimming ? 2 : 4);
    }
  } else if (player.swimming) {
    player.frameTimer += dt * 60;
    if (player.frameTimer > 12) {
      player.frameTimer = 0;
      player.frame = (player.frame + 1) % 2;
    }
  }

  // Camera hard-locked to player center
  cam.x = player.x - canvas.width / 2;
  cam.y = player.y - canvas.height / 2;

  // Flicker
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) {
    flickerTimer += dt;
    if (flickerTimer > nextFlicker) {
      flickerAlpha = 0.08 + Math.random() * 0.12;
      nextFlicker = 2 + Math.random() * 10;
      flickerTimer = 0;
      setTimeout(() => { flickerAlpha = 0; }, 60 + Math.random() * 120);
    }
  } else {
    flickerAlpha = 0;
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
    if (monsterStunTime <= 0) {
      monster.x += monster.dx * mspd;
      monster.y += monster.dy * mspd;
    }

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
  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    monster.fearLevel = 0;
    shakeX = 0;
    shakeY = 0;
  } else {
    const targetFear = playerInSafeRoom || monDist >= FEAR_RANGE
      ? 0
      : Math.pow(1 - monDist / FEAR_RANGE, 1.4);
    monster.fearLevel += (targetFear - monster.fearLevel) * 0.04;

    const shakeMag = monster.fearLevel * 5;
    shakeX = (Math.random() - 0.5) * shakeMag;
    shakeY = (Math.random() - 0.5) * shakeMag;
  }

  if (!playerInSafeRoom && monDist < CATCH_DIST) {
    playerDead = true;
    deathTimer = DEATH_DURATION;
    if (online.enabled) syncLocalPlayerToRoom(true);
  }

  // ── Weapon pickups ────────────────────────────────────────────────────────
  for (const w of weapons) {
    if (w.picked) continue;
    if (Math.hypot(player.x - w.x, player.y - w.y) < CELL * 0.55) {
      w.picked = true;
      ammo = Math.min(MAX_AMMO, ammo + 1);
      updateAmmoHud();
    }
  }

  // ── Bullet updates ────────────────────────────────────────────────────────
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    if (b.life <= 0) { bullets.splice(i, 1); continue; }

    const nbx = b.x + b.vx;
    const nby = b.y + b.vy;

    if (pointInWall(nbx, nby)) {
      bullets.splice(i, 1);
      continue;
    }
    b.x = nbx;
    b.y = nby;

    // Monster collision (hit radius ~22px — monster torso is ~10px wide but 80px tall)
    if (monsterStunTime <= 0 && Math.hypot(b.x - monster.x, b.y - monster.y) < 22) {
      monsterStunTime = STUN_DURATION;
      monster.isChasing = false;
      monster.dx = 0;
      monster.dy = 0;
      bullets.splice(i, 1);
    }
  }

  playerWasInSafeRoom = playerInSafeRoom;
  if (online.enabled) syncLocalPlayerToRoom();
}

function getFloorTileForCell(cx, cy) {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    return isHouseCell(cx, cy) ? houseFloorCanvas : forestFloorCanvas;
  }
  return floorCanvas;
}

function getWallTopTileForCell(cx, cy) {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    return isHouseCell(cx, cy) ? houseWallCanvas : forestWallCanvas;
  }
  return wallCanvas;
}

function getWallFaceTileForSegment(cx, cy, bit) {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return faceCanvas;
  const d = DIR[bit];
  const nx = cx + d.dx;
  const ny = cy + d.dy;
  return (isHouseCell(cx, cy) || isHouseCell(nx, ny)) ? houseFaceCanvas : forestFaceCanvas;
}

function traceWorldPolyline(points, renderCtx = ctx, offsetX = -cam.x, offsetY = -cam.y) {
  if (!points || points.length < 2) return false;
  renderCtx.beginPath();
  renderCtx.moveTo(points[0].x * CELL + offsetX, points[0].y * CELL + offsetY);
  for (let i = 1; i < points.length; i++) {
    renderCtx.lineTo(points[i].x * CELL + offsetX, points[i].y * CELL + offsetY);
  }
  return true;
}

function drawForestGroundDetails(renderCtx = ctx, offsetX = -cam.x, offsetY = -cam.y) {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;

  renderCtx.save();
  renderCtx.lineCap = 'round';
  renderCtx.lineJoin = 'round';

  for (const path of forestPaths) {
    if (!traceWorldPolyline(path, renderCtx, offsetX, offsetY)) continue;
    renderCtx.strokeStyle = 'rgba(48, 35, 21, 0.18)';
    renderCtx.lineWidth = CELL * 0.48;
    renderCtx.stroke();

    traceWorldPolyline(path, renderCtx, offsetX, offsetY);
    renderCtx.strokeStyle = 'rgba(98, 78, 52, 0.2)';
    renderCtx.lineWidth = CELL * 0.28;
    renderCtx.stroke();
  }

  if (forestRiver) {
    traceWorldPolyline(forestRiver.points, renderCtx, offsetX, offsetY);
    renderCtx.strokeStyle = 'rgba(64, 48, 26, 0.34)';
    renderCtx.lineWidth = (forestRiver.halfWidth * 2 + 0.45) * CELL;
    renderCtx.stroke();

    traceWorldPolyline(forestRiver.points, renderCtx, offsetX, offsetY);
    renderCtx.strokeStyle = 'rgba(18, 48, 63, 0.86)';
    renderCtx.lineWidth = (forestRiver.halfWidth * 2) * CELL;
    renderCtx.stroke();

    traceWorldPolyline(forestRiver.points, renderCtx, offsetX, offsetY);
    renderCtx.strokeStyle = 'rgba(66, 126, 152, 0.24)';
    renderCtx.lineWidth = Math.max(10, (forestRiver.halfWidth * 2 - 0.7) * CELL);
    renderCtx.stroke();
  }

  if (forestBridge) {
    const bx = forestBridge.cx * CELL + offsetX;
    const by = forestBridge.cy * CELL + offsetY;
    const bw = forestBridge.halfWidth * CELL * 2 + 20;
    const bh = Math.max(28, forestBridge.halfHeight * CELL * 2 + 18);

    renderCtx.save();
    renderCtx.translate(bx, by);
    renderCtx.fillStyle = 'rgba(0, 0, 0, 0.24)';
    renderCtx.fillRect(-bw / 2, -bh / 2 + 5, bw, bh);
    renderCtx.fillStyle = '#5f4428';
    renderCtx.fillRect(-bw / 2, -bh / 2, bw, bh);
    renderCtx.fillStyle = '#7f6038';
    for (let x = -bw / 2; x < bw / 2; x += 12) {
      renderCtx.fillRect(x, -bh / 2, 8, bh);
    }
    renderCtx.fillStyle = '#3f2a18';
    renderCtx.fillRect(-bw / 2, -bh / 2, bw, 4);
    renderCtx.fillRect(-bw / 2, bh / 2 - 4, bw, 4);
    renderCtx.restore();
  }

  renderCtx.restore();
}

function rebuildForestTerrainCanvas() {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) {
    forestTerrainCanvas = null;
    return;
  }

  const worldWidth = COLS * CELL;
  const worldHeight = ROWS * CELL;
  forestTerrainCanvas = document.createElement('canvas');
  forestTerrainCanvas.width = worldWidth;
  forestTerrainCanvas.height = worldHeight;

  const tc = forestTerrainCanvas.getContext('2d');
  tc.imageSmoothingEnabled = false;

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      tc.drawImage(getFloorTileForCell(cx, cy), 0, 0, CELL, CELL, cx * CELL, cy * CELL, CELL, CELL);
    }
  }

  drawForestGroundDetails(tc, 0, 0);

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const wx = cx * CELL;
      const wy = cy * CELL;
      const bits = maze[cellIndex(cx, cy)];
      const topTile = getWallTopTileForCell(cx, cy);
      const wTop = (x, y, w, h) => tc.drawImage(topTile, 0, 0, CELL, CELL, x, y, w, h);
      const northFace = (x, y, w) => tc.drawImage(getWallFaceTileForSegment(cx, cy, 0), 0, 0, CELL, WALL_FACE, x, y, w, WALL_FACE);

      if (!(bits & 1)) {
        wTop(wx + WALL_T, wy, CELL - WALL_T * 2, WALL_T);
        northFace(wx + WALL_T, wy + WALL_T, CELL - WALL_T * 2);
      }
      if (!(bits & 4)) wTop(wx + WALL_T, wy + CELL - WALL_T, CELL - WALL_T * 2, WALL_T);
      if (!(bits & 8)) wTop(wx, wy + WALL_T, WALL_T, CELL - WALL_T * 2);
      if (!(bits & 2)) wTop(wx + CELL - WALL_T, wy + WALL_T, WALL_T, CELL - WALL_T * 2);

      if (!(bits & 1) || !(bits & 8)) {
        wTop(wx, wy, WALL_T, WALL_T);
        if (!(bits & 1)) northFace(wx, wy + WALL_T, WALL_T);
      }
      if (!(bits & 1) || !(bits & 2)) {
        wTop(wx + CELL - WALL_T, wy, WALL_T, WALL_T);
        if (!(bits & 1)) northFace(wx + CELL - WALL_T, wy + WALL_T, WALL_T);
      }
      if (!(bits & 4) || !(bits & 8)) wTop(wx, wy + CELL - WALL_T, WALL_T, WALL_T);
      if (!(bits & 4) || !(bits & 2)) wTop(wx + CELL - WALL_T, wy + CELL - WALL_T, WALL_T, WALL_T);
    }
  }
}

function drawForestWorld() {
  if (forestTerrainCanvas) {
    const srcX = Math.max(0, Math.floor(cam.x));
    const srcY = Math.max(0, Math.floor(cam.y));
    const dx = -(cam.x - srcX);
    const dy = -(cam.y - srcY);
    const sw = Math.min(forestTerrainCanvas.width - srcX, Math.ceil(canvas.width - dx) + 2);
    const sh = Math.min(forestTerrainCanvas.height - srcY, Math.ceil(canvas.height - dy) + 2);
    ctx.drawImage(forestTerrainCanvas, srcX, srcY, sw, sh, dx, dy, sw, sh);
    return;
  }

  const startCX = Math.max(0, Math.floor(cam.x / CELL) - 1);
  const startCY = Math.max(0, Math.floor(cam.y / CELL) - 1);
  const endCX   = Math.min(COLS, startCX + Math.ceil(canvas.width  / CELL) + 2);
  const endCY   = Math.min(ROWS, startCY + Math.ceil(canvas.height / CELL) + 2);

  for (let cy = startCY; cy < endCY; cy++) {
    for (let cx = startCX; cx < endCX; cx++) {
      const wx = cx * CELL - cam.x;
      const wy = cy * CELL - cam.y;
      ctx.drawImage(getFloorTileForCell(cx, cy), 0, 0, CELL, CELL, wx, wy, CELL, CELL);
    }
  }

  drawForestGroundDetails();

  for (let cy = startCY; cy < endCY; cy++) {
    for (let cx = startCX; cx < endCX; cx++) {
      const wx = cx * CELL - cam.x;
      const wy = cy * CELL - cam.y;
      const bits = maze[cellIndex(cx, cy)];
      const topTile = getWallTopTileForCell(cx, cy);
      const wTop = (x, y, w, h) => ctx.drawImage(topTile, 0, 0, CELL, CELL, x, y, w, h);
      const northFace = (x, y, w) => ctx.drawImage(getWallFaceTileForSegment(cx, cy, 0), 0, 0, CELL, WALL_FACE, x, y, w, WALL_FACE);

      if (!(bits & 1)) {
        wTop(wx + WALL_T, wy, CELL - WALL_T * 2, WALL_T);
        northFace(wx + WALL_T, wy + WALL_T, CELL - WALL_T * 2);
      }
      if (!(bits & 4)) wTop(wx + WALL_T, wy + CELL - WALL_T, CELL - WALL_T * 2, WALL_T);
      if (!(bits & 8)) wTop(wx, wy + WALL_T, WALL_T, CELL - WALL_T * 2);
      if (!(bits & 2)) wTop(wx + CELL - WALL_T, wy + WALL_T, WALL_T, CELL - WALL_T * 2);

      if (!(bits & 1) || !(bits & 8)) {
        wTop(wx, wy, WALL_T, WALL_T);
        if (!(bits & 1)) northFace(wx, wy + WALL_T, WALL_T);
      }
      if (!(bits & 1) || !(bits & 2)) {
        wTop(wx + CELL - WALL_T, wy, WALL_T, WALL_T);
        if (!(bits & 1)) northFace(wx + CELL - WALL_T, wy + WALL_T, WALL_T);
      }
      if (!(bits & 4) || !(bits & 8)) wTop(wx, wy + CELL - WALL_T, WALL_T, WALL_T);
      if (!(bits & 4) || !(bits & 2)) wTop(wx + CELL - WALL_T, wy + CELL - WALL_T, WALL_T, WALL_T);
    }
  }
}

function drawMaze() {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    drawForestWorld();
    return;
  }

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
      const floorTile = getFloorTileForCell(cx, cy);

      // centre corridor
      ctx.drawImage(floorTile, 0, 0, CELL, CELL, wx + WALL_T, wy + WALL_T, pw, pw);
      if (bits & 1) ctx.drawImage(floorTile, 0, 0, CELL, CELL, wx + WALL_T, wy,              pw, WALL_T); // N
      if (bits & 4) ctx.drawImage(floorTile, 0, 0, CELL, CELL, wx + WALL_T, wy + CELL - WALL_T, pw, WALL_T); // S
      if (bits & 8) ctx.drawImage(floorTile, 0, 0, CELL, CELL, wx,          wy + WALL_T,    WALL_T, pw); // W
      if (bits & 2) ctx.drawImage(floorTile, 0, 0, CELL, CELL, wx + CELL - WALL_T, wy + WALL_T, WALL_T, pw); // E
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
      const cornerTopTile = getWallTopTileForCell(cx, cy);

      // Helper: draw wall top rect from wallCanvas
      const wTop = (tile, x, y, w, h) =>
        ctx.drawImage(tile, 0, 0, CELL, CELL, x, y, w, h);

      // Helper: draw wall face (south-facing, darker)
      const wFace = (tile, x, y, w) =>
        ctx.drawImage(tile, 0, 0, CELL, WALL_FACE, x, y, w, WALL_FACE);

      // ── Four corners (always solid walls) ───────────────────────────────
      // NW corner — top + face (faces south into cell)
      wTop(cornerTopTile, wx,               wy, WALL_T, WALL_T);
      wFace(getWallFaceTileForSegment(cx, cy, 0), wx, wy + WALL_T, WALL_T);

      // NE corner — top + face
      wTop(cornerTopTile, wx + CELL - WALL_T, wy, WALL_T, WALL_T);
      wFace(getWallFaceTileForSegment(cx, cy, 0), wx + CELL - WALL_T, wy + WALL_T, WALL_T);

      // SW corner — top only (face would point away from viewer)
      wTop(cornerTopTile, wx,               wy + CELL - WALL_T, WALL_T, WALL_T);

      // SE corner — top only
      wTop(cornerTopTile, wx + CELL - WALL_T, wy + CELL - WALL_T, WALL_T, WALL_T);

      // ── Mid-wall segments ────────────────────────────────────────────────
      if (!(bits & 1)) {
        // North wall closed — top strip + south-facing face
        wTop(getWallTopTileForCell(cx, cy), wx + WALL_T, wy, pw, WALL_T);
        wFace(getWallFaceTileForSegment(cx, cy, 0), wx + WALL_T, wy + WALL_T, pw);
      }
      if (!(bits & 4)) {
        // South wall closed — top strip only (faces away)
        wTop(getWallTopTileForCell(cx, cy), wx + WALL_T, wy + CELL - WALL_T, pw, WALL_T);
      }
      if (!(bits & 8)) {
        // West wall closed — vertical strip
        wTop(getWallTopTileForCell(cx, cy), wx, wy + WALL_T, WALL_T, pw);
      }
      if (!(bits & 2)) {
        // East wall closed — vertical strip
        wTop(getWallTopTileForCell(cx, cy), wx + CELL - WALL_T, wy + WALL_T, WALL_T, pw);
      }
    }
  }
}

function drawSafeRooms() {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    for (const room of safeRooms) {
      const cx = room.centerCX * CELL + CELL / 2 - cam.x;
      const cy = room.centerCY * CELL + CELL / 2 - cam.y + 12;
      if (cx < -90 || cx > canvas.width + 90 || cy < -90 || cy > canvas.height + 90) continue;

      const pulse = 0.45 + 0.2 * Math.sin(Date.now() / 700 + (room.pulseOffset || room.centerCX));
      ctx.save();
      ctx.fillStyle = `rgba(110, 210, 175, ${0.12 + pulse * 0.16})`;
      ctx.strokeStyle = `rgba(180, 255, 225, ${0.35 + pulse * 0.35})`;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 22;
      ctx.shadowColor = 'rgba(110, 240, 200, 0.35)';
      ctx.beginPath();
      ctx.ellipse(cx, cy, 22, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

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

function getCachedTreeSprite(size = 1) {
  const quantized = Math.max(0.8, Math.min(2.2, Math.round(size * 10) / 10));
  const key = quantized.toFixed(1);
  if (treeSpriteCache.has(key)) return treeSpriteCache.get(key);

  const canvas = document.createElement('canvas');
  const width = Math.ceil(58 * quantized);
  const height = Math.ceil(92 * quantized);
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;

  const bx = Math.round(width / 2);
  const by = Math.round(height - 6);
  const trunkW = Math.max(4, Math.round(5 * quantized));
  const trunkH = Math.max(14, Math.round(18 * quantized));

  c.fillStyle = '#160a03';
  c.fillRect(Math.round(bx - trunkW / 2), by - trunkH + 4, trunkW, trunkH);
  c.fillStyle = '#2c160a';
  c.fillRect(Math.round(bx - trunkW / 2 + 1), by - trunkH + 4, 1, trunkH);

  const tiers = [
    { dy: -72, hw: 2, th: 3, main: '#0e2812', hi: '#1c4020', dk: '#071208' },
    { dy: -68, hw: 4, th: 3, main: '#0e2812', hi: '#1c4020', dk: '#071208' },
    { dy: -65, hw: 2, th: 3, main: '#112e16', hi: '#1e4624', dk: '#08160a' },
    { dy: -61, hw: 6, th: 3, main: '#112e16', hi: '#1e4624', dk: '#08160a' },
    { dy: -58, hw: 4, th: 3, main: '#13321a', hi: '#224a28', dk: '#09180c' },
    { dy: -54, hw: 7, th: 4, main: '#163a1e', hi: '#265230', dk: '#0b1c10' },
    { dy: -50, hw: 5, th: 4, main: '#163a1e', hi: '#265230', dk: '#0b1c10' },
    { dy: -46, hw: 9, th: 4, main: '#193e22', hi: '#2a5634', dk: '#0c2012' },
    { dy: -42, hw: 7, th: 4, main: '#1b4226', hi: '#2e5c38', dk: '#0e2214' },
    { dy: -38, hw: 11, th: 4, main: '#1d4628', hi: '#306038', dk: '#0f2416' },
    { dy: -34, hw: 9, th: 4, main: '#1f4a2c', hi: '#32643c', dk: '#102618' },
    { dy: -29, hw: 13, th: 5, main: '#204e2e', hi: '#346840', dk: '#112818' },
    { dy: -24, hw: 11, th: 5, main: '#235232', hi: '#386c44', dk: '#122a1a' },
    { dy: -19, hw: 15, th: 5, main: '#255636', hi: '#3c7048', dk: '#13301c' },
    { dy: -14, hw: 13, th: 5, main: '#27583a', hi: '#3e724a', dk: '#14321e' },
    { dy: -9, hw: 17, th: 6, main: '#285c3c', hi: '#427650', dk: '#143420' },
    { dy: -3, hw: 15, th: 6, main: '#2a5e3e', hi: '#447852', dk: '#163622' },
    { dy: 4, hw: 19, th: 6, main: '#2b6040', hi: '#467a54', dk: '#163822' },
  ];

  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const w = Math.max(3, Math.round(tier.hw * 2 * quantized));
    const h = Math.max(2, Math.round(tier.th * quantized));
    const tx = Math.round(bx - w / 2);
    const ty = Math.round(by + tier.dy * quantized);
    c.fillStyle = tier.main;
    c.fillRect(tx, ty, w, h);
    c.fillStyle = tier.hi;
    c.fillRect(tx, ty, Math.max(2, Math.round(w * 0.22)), h - 1);
    c.fillRect(tx + Math.round(w * 0.3), ty, Math.round(w * 0.35), 1);
    c.fillStyle = tier.dk;
    c.fillRect(tx, ty + h - 1, w, 1);
    c.fillRect(tx + w - 1, ty + 1, 1, h - 1);
    if (ti % 3 === 0) {
      c.fillStyle = 'rgba(200,240,210,0.18)';
      c.fillRect(tx + Math.round(w * 0.35), ty, Math.round(w * 0.3), 1);
    }
  }

  c.fillStyle = '#0e2812';
  c.fillRect(Math.round(bx - 1), Math.round(by - 76 * quantized), 2, 5);
  c.fillStyle = '#1c4020';
  c.fillRect(Math.round(bx), Math.round(by - 79 * quantized), 1, 4);

  const sprite = {
    canvas,
    originX: Math.round(width / 2),
    originY: height - 6,
  };
  treeSpriteCache.set(key, sprite);
  return sprite;
}

function drawVillageProps() {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;
  const orderedProps = villagePropsOrdered.length ? villagePropsOrdered : villageProps;

  for (const prop of orderedProps) {
    const sx = Math.round(prop.x - cam.x);
    const sy = Math.round(prop.y - cam.y);
    if (sx < -80 || sx > canvas.width + 80 || sy < -80 || sy > canvas.height + 80) continue;

    ctx.save();

    if (prop.type === 'tree') {
      const sprite = getCachedTreeSprite(prop.size || 1);
      ctx.drawImage(sprite.canvas, Math.round(sx - sprite.originX), Math.round(sy - sprite.originY));
    } else if (prop.type === 'deadTree') {
      ctx.strokeStyle = '#24160e';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(sx, sy + 18);
      ctx.lineTo(sx, sy - 16);
      ctx.lineTo(sx - 8, sy - 26);
      ctx.moveTo(sx, sy - 4);
      ctx.lineTo(sx - 10, sy - 14);
      ctx.moveTo(sx, sy - 8);
      ctx.lineTo(sx + 12, sy - 20);
      ctx.stroke();
    } else if (prop.type === 'rock') {
      ctx.fillStyle = '#4b5354';
      ctx.beginPath();
      ctx.ellipse(sx, sy + 6, prop.width / 2, prop.height / 2, prop.tilt || 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.ellipse(sx - 3, sy + 3, prop.width / 3.4, prop.height / 3.8, prop.tilt || 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (prop.type === 'stump') {
      ctx.fillStyle = '#4b2d17';
      ctx.fillRect(sx - 8, sy - 2, 16, 14);
      ctx.fillStyle = '#7a5732';
      ctx.beginPath();
      ctx.ellipse(sx, sy - 2, prop.width / 2.3, prop.height / 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(55, 31, 14, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(sx, sy - 2, prop.width / 4.2, prop.height / 4, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (prop.type === 'bush') {
      const size = prop.size || 1;
      const deep = prop.blocking ? 1 : 0.7;
      ctx.fillStyle = `rgba(${Math.floor(28 + prop.tint * 18)}, ${Math.floor(52 + prop.tint * 24)}, ${Math.floor(24 + prop.tint * 16)}, 0.95)`;
      ctx.beginPath();
      ctx.arc(sx - 8 * size, sy + 3, 8 * size, 0, Math.PI * 2);
      ctx.arc(sx + 7 * size, sy + 2, 9 * size, 0, Math.PI * 2);
      ctx.arc(sx, sy - 5, 10 * size * deep, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(70, 94, 48, 0.2)';
      ctx.beginPath();
      ctx.arc(sx - 2, sy - 7, 5 * size, 0, Math.PI * 2);
      ctx.fill();
    } else if (prop.type === 'log') {
      ctx.translate(sx, sy + 3);
      ctx.rotate(prop.angle || 0);
      ctx.fillStyle = '#4c311c';
      ctx.fillRect(-prop.width / 2, -prop.height / 2, prop.width, prop.height);
      ctx.fillStyle = '#6d4726';
      ctx.fillRect(-prop.width / 2 + 3, -prop.height / 2 + 2, prop.width - 6, prop.height - 4);
      ctx.strokeStyle = 'rgba(32, 20, 10, 0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-prop.width / 2 + 6, 0);
      ctx.lineTo(prop.width / 2 - 6, 0);
      ctx.stroke();
    } else if (prop.type === 'tent') {
      ctx.fillStyle = '#695233';
      ctx.beginPath();
      ctx.moveTo(sx - 18, sy + 10);
      ctx.lineTo(sx, sy - 12);
      ctx.lineTo(sx + 18, sy + 10);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#3a2816';
      ctx.fillRect(sx - 2, sy - 10, 4, 22);
      ctx.strokeStyle = 'rgba(255,230,170,0.2)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - 10, sy + 6);
      ctx.lineTo(sx, sy - 4);
      ctx.lineTo(sx + 10, sy + 6);
      ctx.stroke();
      ctx.fillStyle = 'rgba(160, 255, 210, 0.12)';
      ctx.beginPath();
      ctx.arc(sx + 8 * (prop.entranceSide || 1), sy + 6, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (prop.type === 'campfire') {
      // Ground ember glow
      ctx.fillStyle = 'rgba(255,80,10,0.08)';
      ctx.fillRect(sx - 16, sy - 4, 32, 14);

      // Logs — two crossing rectangles
      ctx.fillStyle = '#2e1608';
      ctx.fillRect(sx - 11, sy,     22, 5);  // horizontal log
      ctx.fillRect(sx -  2, sy - 8, 5,  16); // vertical log
      ctx.fillStyle = '#4a2812';
      ctx.fillRect(sx - 10, sy + 1, 20, 2);
      ctx.fillRect(sx -  1, sy - 7, 3,  14);
      // Log ends (lighter cross-section)
      ctx.fillStyle = '#7a5038';
      ctx.fillRect(sx - 12, sy,     2, 5);
      ctx.fillRect(sx +  10, sy,    2, 5);

      // Pixel flames — layered rects, tallest in center
      const fh = 18;
      // Outer red-orange base
      ctx.fillStyle = 'rgba(200,44,0,0.76)';
      ctx.fillRect(sx - 8, sy - fh + 4, 16, fh - 2);
      // Mid orange
      ctx.fillStyle = 'rgba(255,96,0,0.86)';
      ctx.fillRect(sx - 6, sy - fh + 2, 12, fh);
      // Inner yellow-orange
      ctx.fillStyle = 'rgba(255,164,24,0.88)';
      ctx.fillRect(sx - 4, sy - fh, 8, fh + 1);
      // Core bright yellow
      ctx.fillStyle = 'rgba(255,240,120,0.92)';
      ctx.fillRect(sx - 2, sy - fh - 2, 4, fh - 2);
      // White-hot tip
      ctx.fillStyle = 'rgba(255,255,220,0.46)';
      ctx.fillRect(sx - 1, sy - fh - 4, 2, 4);
    } else if (prop.type === 'mushroom') {
      const ms = prop.size || 1;
      const red = prop.red;
      const sW = Math.max(3, Math.round(4 * ms));
      const sH = Math.max(5, Math.round(7 * ms));
      const cW = Math.max(8, Math.round(14 * ms));
      const cH = Math.max(5, Math.round(8 * ms));
      const ox = sx, oy = sy;
      // Stem
      ctx.fillStyle = '#c8c0a4';
      ctx.fillRect(ox - Math.round(sW / 2), oy - sH, sW, sH);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(ox + 1, oy - sH, 1, sH);
      // Cap
      ctx.fillStyle = red ? '#b81818' : '#a06428';
      ctx.fillRect(ox - Math.round(cW / 2), oy - sH - cH + 2, cW, cH);
      ctx.fillStyle = red ? '#d42424' : '#c07c38';
      ctx.fillRect(ox - Math.round(cW / 2) + 2, oy - sH - cH, cW - 4, 2);
      // White dots on red mushroom
      if (red) {
        ctx.fillStyle = '#f0f0e8';
        ctx.fillRect(ox - 3, oy - sH - cH + 2, 3, 3);
        ctx.fillRect(ox + 4, oy - sH - cH + 3, 2, 2);
        ctx.fillRect(ox - 6, oy - sH - cH + 3, 2, 2);
      }
      // Gill underside
      ctx.fillStyle = 'rgba(240,230,190,0.65)';
      ctx.fillRect(ox - Math.round(cW / 2) + 2, oy - sH + 2, cW - 4, 2);
    } else if (prop.type === 'barrel') {
      const bw = 16, bh = 22;
      const bx2 = sx - bw / 2, by2 = sy - bh + 4;
      // Main stave
      ctx.fillStyle = '#4a2c10';
      ctx.fillRect(bx2, by2, bw, bh);
      ctx.fillStyle = '#6a4220';
      ctx.fillRect(bx2 + 2, by2, bw - 4, bh);
      // Metal hoops
      ctx.fillStyle = '#707060';
      ctx.fillRect(bx2, by2 + 3, bw, 2);
      ctx.fillRect(bx2, by2 + bh - 6, bw, 2);
      ctx.fillRect(bx2, by2 + Math.round(bh / 2) - 1, bw, 2);
      // Top cap
      ctx.fillStyle = '#583c18';
      ctx.fillRect(bx2 + 1, by2, bw - 2, 3);
      // Shadow side
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(bx2 + bw - 3, by2 + 2, 3, bh - 4);
      if (prop.broken) {
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.fillRect(bx2 + 4, by2, 5, Math.round(bh * 0.55));
      }
    } else if (prop.type === 'lantern') {
      // Pole
      ctx.fillStyle = '#1c1208';
      ctx.fillRect(sx - 2, sy - 36, 4, 36);
      ctx.fillStyle = '#2c1c0c';
      ctx.fillRect(sx - 1, sy - 36, 1, 36);
      // Lantern cage
      ctx.fillStyle = '#3a3020';
      ctx.fillRect(sx - 7, sy - 42, 14, 12);
      ctx.fillStyle = '#2a2010';
      ctx.fillRect(sx - 7, sy - 42, 14, 2);
      ctx.fillRect(sx - 7, sy - 32, 14, 2);
      // Glow inside
      ctx.fillStyle = 'rgba(255,210,80,0.82)';
      ctx.fillRect(sx - 4, sy - 40, 8, 8);
      // Hook at top
      ctx.fillStyle = '#2a2010';
      ctx.fillRect(sx - 1, sy - 44, 2, 4);
    }

    ctx.restore();
  }
}

function drawVillageHouses() {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;
  for (const house of villageHouses) {
    const x = house.x * CELL - cam.x;
    const y = house.y * CELL - cam.y;
    const w = house.w * CELL;
    const h = house.h * CELL;

    if (x > canvas.width + CELL || y > canvas.height + CELL || x + w < -CELL || y + h < -CELL) continue;

    ctx.save();
    const roofTone = house.roofTone || 40;
    const wallTone = house.wallTone || 54;
    const glow = house.glow || 0.6;
    ctx.strokeStyle = `rgba(${Math.max(20, roofTone - 4)}, ${Math.max(12, Math.floor(roofTone * 0.55))}, 10, 0.92)`;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 8, y + 8, w - 16, h - 16);
    ctx.fillStyle = `rgba(${wallTone}, ${Math.max(26, Math.floor(wallTone * 0.74))}, 28, 0.24)`;
    ctx.fillRect(x + 10, y + 10, w - 20, h - 20);

    ctx.fillStyle = `rgba(${roofTone}, ${Math.max(22, Math.floor(roofTone * 0.5))}, 14, 0.48)`;
    ctx.fillRect(x + 8, y + 6, w - 16, 14);
    ctx.fillStyle = 'rgba(24, 20, 16, 0.34)';
    ctx.fillRect(x + 16, y + 18, w - 32, h - 36);

    for (const item of (house.furniture || [])) {
      const fx = item.x - cam.x;
      const fy = item.y - cam.y;

      if (item.type === 'rug') {
        ctx.fillStyle = item.tint === 'teal' ? '#355a5a' : '#5d4131';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.fillStyle = item.tint === 'teal' ? '#4c7b7a' : '#835844';
        ctx.fillRect(fx - item.width / 2 + 4, fy - item.height / 2 + 3, item.width - 8, item.height - 6);
        ctx.fillStyle = 'rgba(230, 214, 160, 0.18)';
        for (let rx = -item.width / 2 + 6; rx < item.width / 2 - 4; rx += 8) {
          ctx.fillRect(Math.round(fx + rx), Math.round(fy - item.height / 2 + 5), 2, item.height - 10);
        }
      } else if (item.type === 'table') {
        ctx.fillStyle = '#5f4127';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.fillStyle = '#7d5734';
        ctx.fillRect(fx - item.width / 2 + 2, fy - item.height / 2 + 2, item.width - 4, item.height - 4);
        ctx.fillStyle = '#3b2617';
        ctx.fillRect(fx - item.width / 2 + 2, fy + item.height / 2 - 1, 3, 6);
        ctx.fillRect(fx + item.width / 2 - 5, fy + item.height / 2 - 1, 3, 6);
      } else if (item.type === 'chair') {
        ctx.fillStyle = '#4e3521';
        ctx.fillRect(fx - 5, fy - 4, 10, 8);
        ctx.fillStyle = '#6c4b30';
        ctx.fillRect(fx - 4, fy - 3, 8, 6);
        if (item.facing === 'up') ctx.fillRect(fx - 5, fy - 8, 10, 3);
        if (item.facing === 'left') ctx.fillRect(fx - 8, fy - 4, 3, 8);
        if (item.facing === 'right') ctx.fillRect(fx + 5, fy - 4, 3, 8);
      } else if (item.type === 'cabinet') {
        ctx.fillStyle = '#4c3119';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.fillStyle = '#6f4b28';
        ctx.fillRect(fx - item.width / 2 + 2, fy - item.height / 2 + 2, item.width - 4, item.height - 4);
        ctx.fillStyle = '#2b1c10';
        ctx.fillRect(fx - 1, fy - item.height / 2 + 3, 2, item.height - 6);
        ctx.fillRect(fx - item.width / 2 + 3, fy - 2, item.width - 6, 2);
      } else if (item.type === 'armchair') {
        ctx.fillStyle = item.tint === 'olive' ? '#4d5a31' : '#6d4634';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.fillStyle = item.tint === 'olive' ? '#667644' : '#8a5c46';
        ctx.fillRect(fx - item.width / 2 + 3, fy - item.height / 2 + 3, item.width - 6, item.height - 8);
        ctx.fillStyle = '#342218';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, 3, item.height);
        ctx.fillRect(fx + item.width / 2 - 3, fy - item.height / 2, 3, item.height);
      } else if (item.type === 'bed') {
        ctx.fillStyle = '#5a4028';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.fillStyle = '#d6d0c0';
        ctx.fillRect(fx - item.width / 2 + 2, fy - item.height / 2 + 2, Math.min(12, item.width * 0.35), 6);
        ctx.fillStyle = item.blanket === 'blue' ? '#4c6794' : '#53754f';
        ctx.fillRect(fx - item.width / 2 + 2, fy - item.height / 2 + 8, item.width - 4, item.height - 10);
      } else if (item.type === 'crate') {
        ctx.fillStyle = '#53361f';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.strokeStyle = 'rgba(28,18,10,0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(fx - item.width / 2 + 0.5, fy - item.height / 2 + 0.5, item.width - 1, item.height - 1);
        ctx.beginPath();
        ctx.moveTo(fx - item.width / 2 + 2, fy - item.height / 2 + 2);
        ctx.lineTo(fx + item.width / 2 - 2, fy + item.height / 2 - 2);
        ctx.moveTo(fx + item.width / 2 - 2, fy - item.height / 2 + 2);
        ctx.lineTo(fx - item.width / 2 + 2, fy + item.height / 2 - 2);
        ctx.stroke();
      } else if (item.type === 'shelf') {
        ctx.fillStyle = '#4a311c';
        ctx.fillRect(fx - item.width / 2, fy - item.height / 2, item.width, item.height);
        ctx.fillStyle = '#75502e';
        ctx.fillRect(fx - item.width / 2 + 2, fy - item.height / 2 + 2, item.width - 4, 2);
        ctx.fillRect(fx - item.width / 2 + 2, fy + item.height / 2 - 4, item.width - 4, 2);
        ctx.fillStyle = '#b58b42';
        ctx.fillRect(fx - item.width / 2 + 4, fy - 1, 4, 3);
        ctx.fillStyle = '#8b3f2c';
        ctx.fillRect(fx, fy - 2, 4, 4);
      }
    }

    // Draw actual window passages as glowing yellow panes
    ctx.fillStyle = `rgba(255, 214, 120, ${glow || 0.6})`;
    for (const win of (house.windows || [])) {
      const wx2 = win.cx * CELL - cam.x;
      const wy2 = win.cy * CELL - cam.y;
      // Draw a bright rect on the appropriate wall face
      if (win.bit === 0) ctx.fillRect(wx2 + WALL_T + 2, wy2,              CELL - WALL_T * 2 - 4, WALL_T);
      if (win.bit === 2) ctx.fillRect(wx2 + WALL_T + 2, wy2 + CELL - WALL_T, CELL - WALL_T * 2 - 4, WALL_T);
      if (win.bit === 3) ctx.fillRect(wx2,              wy2 + WALL_T + 2, WALL_T, CELL - WALL_T * 2 - 4);
      if (win.bit === 1) ctx.fillRect(wx2 + CELL - WALL_T, wy2 + WALL_T + 2, WALL_T, CELL - WALL_T * 2 - 4);
    }
    ctx.fillStyle = 'rgba(18, 12, 8, 0.88)';
    ctx.fillRect(x + w / 2 - 7, y + h - 18, 14, 10);

    ctx.restore();
  }
}

function drawForestAtmosphere() {
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) return;
}

function drawExit() {
  const ex = EXIT.x - cam.x - 12;
  const ey = EXIT.y - cam.y - 12;
  const t = Date.now() / 600;
  const pulse = 0.6 + 0.4 * Math.sin(t);
  ctx.save();
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) {
    ctx.shadowBlur = 20;
    ctx.shadowColor = `rgba(100,255,100,${pulse})`;
  }
  ctx.fillStyle = currentLocationId === LOCATION_FOREST_VILLAGE
    ? 'rgba(60,200,60,0.8)'
    : `rgba(60,200,60,${0.5 + 0.5 * pulse})`;
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
    direction: player.direction,
    frame: player.frame,
    swimming: player.swimming,
    name: online.localName || 'YOU',
    accent: online.localColor || '#f0d96a',
    local: true,
  });
}

function drawSwimmingCharacterSprite({ px, py, facing, frame, name, accent, local = false }) {
  const swimFrame = frame % 2;
  const bob = swimFrame === 0 ? -1 : 1;

  ctx.save();
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = 'rgba(20, 74, 116, 0.46)';
  ctx.fillRect(px - 16, py - 8, 32, 4);
  ctx.fillStyle = 'rgba(120, 196, 235, 0.26)';
  ctx.fillRect(px - 12, py - 7, 24, 1);
  ctx.fillRect(px - 8, py - 5, 16, 1);

  ctx.fillStyle = '#f5c8a0';
  ctx.fillRect(px - 5, py - 20 + bob, 10, 8);
  ctx.fillStyle = '#1a1208';
  ctx.fillRect(px - 2, py - 18 + bob, 1, 1);
  ctx.fillRect(px + 1, py - 18 + bob, 1, 1);

  ctx.fillStyle = '#b0a04a';
  ctx.fillRect(px - 5, py - 12 + bob, 10, 4);
  ctx.fillStyle = '#8f7f2c';
  ctx.fillRect(px - 1, py - 12 + bob, 2, 4);

  ctx.fillStyle = '#f5c8a0';
  if (swimFrame === 0) {
    ctx.fillRect(px - 12, py - 11, 7, 3);
    ctx.fillRect(px + 5, py - 9, 7, 3);
  } else {
    ctx.fillRect(px - 12, py - 9, 7, 3);
    ctx.fillRect(px + 5, py - 11, 7, 3);
  }

  ctx.fillStyle = 'rgba(160, 230, 255, 0.45)';
  ctx.fillRect(px - 13, py - 4, 6, 1);
  ctx.fillRect(px + 7, py - 4, 6, 1);
  ctx.fillRect(px - 5, py - 2, 10, 1);

  if (!local) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = currentLocationId === LOCATION_FOREST_VILLAGE ? 2 : 3;
    ctx.beginPath();
    ctx.arc(px, py - 12, 15, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 4;
    ctx.strokeText(name, px, py - 34);
    ctx.fillText(name, px, py - 34);
  }

  ctx.restore();
}

function drawCharacterSprite({ x, y, facing, direction = 'side', frame, swimming = false, name, accent, local = false }) {
  const px = Math.round(x - cam.x);
  const py = Math.round(y - cam.y);
  if (px < -48 || px > canvas.width + 48 || py < -64 || py > canvas.height + 48) return;

  if (swimming) {
    drawSwimmingCharacterSprite({ px, py, facing, frame, name, accent, local });
    return;
  }

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const scale = 2;
  const sw = SPRITE_W * scale;
  const sh = SPRITE_H * scale;

  if (!local) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = currentLocationId === LOCATION_FOREST_VILLAGE ? 2 : 3;
    ctx.beginPath();
    ctx.arc(px, py - sh / 2, 15, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Choose sprite row based on direction
  let spriteFrameX;
  let flipX = false;
  if (direction === 'front') {
    spriteFrameX = (4 + (frame % 2)) * SPRITE_W;
  } else if (direction === 'back') {
    spriteFrameX = (6 + (frame % 2)) * SPRITE_W;
  } else {
    spriteFrameX = (frame % 4) * SPRITE_W;
    if (facing === -1) flipX = true;
  }

  if (flipX) {
    ctx.translate(px, py);
    ctx.scale(-1, 1);
    ctx.drawImage(spriteCanvas, spriteFrameX, 0, SPRITE_W, SPRITE_H, -sw / 2, -sh, sw, sh);
  } else {
    ctx.drawImage(spriteCanvas, spriteFrameX, 0, SPRITE_W, SPRITE_H, px - sw / 2, py - sh, sw, sh);
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
  for (const [uid, playerData] of Object.entries(online.remoteVisuals)) {
    if (playerData.alive === false) continue;
    drawCharacterSprite({
      x: playerData.displayX ?? playerData.targetX ?? PLAYER_START_CX * CELL + CELL / 2,
      y: playerData.displayY ?? playerData.targetY ?? PLAYER_START_CY * CELL + CELL / 2,
      facing: playerData.facing ?? 1,
      direction: playerData.direction ?? 'side',
      frame: playerData.frame ?? 0,
      swimming: !!playerData.swimming,
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

function drawWeapons() {
  const t = Date.now() / 700;
  for (const w of weapons) {
    if (w.picked) continue;
    const sx = Math.round(w.x - cam.x);
    const sy = Math.round(w.y - cam.y);
    if (sx < -30 || sx > canvas.width + 30 || sy < -30 || sy > canvas.height + 30) continue;

    const bob  = Math.sin(t + w.bob) * 3;
    const glow = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.3 + w.bob));

    ctx.save();
    ctx.shadowBlur  = 10;
    ctx.shadowColor = `rgba(230,100,80,${glow})`;

    // pixel-art handgun (20×12 px, centred on sx,sy+bob)
    const gx = sx - 10;
    const gy = sy - 6 + bob;
    // barrel
    ctx.fillStyle = '#999990';
    ctx.fillRect(gx,      gy + 2, 14, 4);
    // muzzle
    ctx.fillStyle = '#bbbbaa';
    ctx.fillRect(gx,      gy + 2, 2, 2);
    // slide / top
    ctx.fillStyle = '#777768';
    ctx.fillRect(gx + 2,  gy,     10, 6);
    // grip
    ctx.fillStyle = '#4a3020';
    ctx.fillRect(gx + 7,  gy + 6, 5, 7);
    // trigger guard
    ctx.fillStyle = '#666655';
    ctx.fillRect(gx + 8,  gy + 7, 3, 3);
    // highlight dot
    ctx.fillStyle = 'rgba(255,255,220,0.6)';
    ctx.fillRect(gx + 3,  gy + 1, 2, 1);

    ctx.restore();
  }
}

function drawBullets() {
  for (const b of bullets) {
    const sx = Math.round(b.x - cam.x);
    const sy = Math.round(b.y - cam.y);
    ctx.save();
    ctx.shadowBlur  = 8;
    ctx.shadowColor = '#ffaa44';
    ctx.fillStyle   = '#ffee88';
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function getAimPreview() {
  if (!shootActive) return null;
  const len = Math.hypot(shootRawDX, shootRawDY);
  if (len < SHOOT_JOY_RADIUS * 0.18) return null;

  const dx = shootRawDX / len;
  const dy = shootRawDY / len;
  const step = 12;
  const maxDistance = CELL * 9.5;
  const points = [{ x: player.x, y: player.y }];
  let x = player.x;
  let y = player.y;
  let hitMonster = false;

  for (let dist = 0; dist < maxDistance; dist += step) {
    x += dx * step;
    y += dy * step;
    if (pointInWall(x, y)) break;
    points.push({ x, y });
    if (monsterStunTime <= 0 && Math.hypot(x - monster.x, y - monster.y) < 22) {
      hitMonster = true;
      break;
    }
  }

  return {
    points,
    hitMonster,
    hasAmmo: ammo > 0,
  };
}

function drawAimPreview() {
  const preview = getAimPreview();
  if (!preview || preview.points.length < 2) return;

  const color = !preview.hasAmmo
    ? 'rgba(150, 80, 80, 0.65)'
    : preview.hitMonster
      ? 'rgba(255, 120, 80, 0.92)'
      : 'rgba(255, 210, 120, 0.82)';

  ctx.save();
  ctx.lineWidth = preview.hitMonster ? 3.5 : 2.5;
  ctx.setLineDash([10, 8]);
  ctx.strokeStyle = color;
  if (currentLocationId !== LOCATION_FOREST_VILLAGE) {
    ctx.shadowBlur = 14;
    ctx.shadowColor = color;
  }
  ctx.beginPath();
  ctx.moveTo(preview.points[0].x - cam.x, preview.points[0].y - cam.y);
  for (let i = 1; i < preview.points.length; i++) {
    ctx.lineTo(preview.points[i].x - cam.x, preview.points[i].y - cam.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  const end = preview.points[preview.points.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(end.x - cam.x, end.y - cam.y, preview.hitMonster ? 6 : 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawJason(sx, sy) {
  const t = Date.now() / 380;
  const bob = Math.sin(t) * 2;
  const lp  = Math.sin(t * 1.3);
  const BH  = 76;
  const top = sy - BH + bob;

  ctx.save();

  // — Shadow on ground —
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.beginPath();
  ctx.ellipse(sx, sy + 2, 13, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // — Boots —
  const lOff = lp * 7;
  ctx.fillStyle = '#0e0e0a';
  ctx.fillRect(sx - 10, top + BH - 10 - lOff, 9, 10);
  ctx.fillRect(sx + 2,  top + BH - 10 + lOff, 9, 10);
  // Boot highlight
  ctx.fillStyle = '#1c1c16';
  ctx.fillRect(sx - 9, top + BH - 9 - lOff, 2, 7);
  ctx.fillRect(sx + 3, top + BH - 9 + lOff, 2, 7);

  // — Legs (dark cargo pants) —
  ctx.fillStyle = '#161612';
  ctx.fillRect(sx - 9,  top + BH - 30 - lOff, 8, 22);
  ctx.fillRect(sx + 2,  top + BH - 30 + lOff, 8, 22);
  // Pants crease
  ctx.fillStyle = '#0e0e0a';
  ctx.fillRect(sx - 5,  top + BH - 26 - lOff, 1, 14);
  ctx.fillRect(sx + 5,  top + BH - 26 + lOff, 1, 14);

  // — Belt —
  ctx.fillStyle = '#3a2808';
  ctx.fillRect(sx - 12, top + BH - 32, 24, 4);
  ctx.fillStyle = '#7a6020';
  ctx.fillRect(sx - 2, top + BH - 32, 5, 4); // buckle

  // — Torso (dark green jacket) —
  ctx.fillStyle = '#1a2814';
  ctx.fillRect(sx - 12, top + 14, 24, 24);
  // Jacket details
  ctx.fillStyle = '#121e0e';
  ctx.fillRect(sx - 11, top + 18, 5,  6); // left pocket
  ctx.fillRect(sx + 6,  top + 18, 5,  6); // right pocket
  ctx.fillRect(sx - 12, top + 14, 24, 3); // collar line
  // Jacket centre seam
  ctx.fillStyle = '#0e1a0a';
  ctx.fillRect(sx - 1, top + 14, 2, 24);
  // Jacket highlight (left side lit)
  ctx.fillStyle = '#22341a';
  ctx.fillRect(sx - 12, top + 15, 3, 22);

  // — Arms —
  const aOff = lp * 6;
  ctx.fillStyle = '#1a2814';
  ctx.fillRect(sx - 20, top + 16 + aOff,  8, 22); // left arm
  ctx.fillRect(sx + 12, top + 16 - aOff,  8, 22); // right arm
  // Sleeves highlight
  ctx.fillStyle = '#22341a';
  ctx.fillRect(sx - 20, top + 17 + aOff, 2, 20);
  ctx.fillRect(sx + 12, top + 17 - aOff, 2, 20);
  // Gloves
  ctx.fillStyle = '#0e0a06';
  ctx.fillRect(sx - 20, top + 36 + aOff, 8, 6);
  ctx.fillRect(sx + 12, top + 36 - aOff, 8, 6);

  // — Machete (right hand) —
  const mOff = -aOff;
  ctx.fillStyle = '#8a8880'; // blade
  ctx.fillRect(sx + 20, top + 38 - mOff, 4, 24);
  ctx.fillStyle = '#bcbcb0'; // edge highlight
  ctx.fillRect(sx + 21, top + 39 - mOff, 1, 22);
  ctx.fillStyle = '#3a2210'; // handle
  ctx.fillRect(sx + 18, top + 35 - mOff, 7, 5);
  ctx.fillStyle = '#6a4820'; // guard
  ctx.fillRect(sx + 16, top + 35 - mOff, 10, 2);

  // — Neck —
  ctx.fillStyle = '#1a1408';
  ctx.fillRect(sx - 4, top + 6, 8, 10);

  // — Head / Hockey mask —
  // Base mask (off-white, slightly yellowed)
  ctx.fillStyle = '#d4ccb4';
  ctx.fillRect(sx - 9, top - 1, 18, 18);
  // Mask top curve (darker)
  ctx.fillStyle = '#bab4a0';
  ctx.fillRect(sx - 9, top - 1, 18, 3);
  // Black eye holes
  ctx.fillStyle = '#080606';
  ctx.fillRect(sx - 7, top + 2, 5, 5);
  ctx.fillRect(sx + 3, top + 2, 5, 5);
  // Eye hole inner red glow
  const eyeGlow = 0.6 + 0.4 * Math.sin(t * 1.8);
  ctx.fillStyle   = `rgba(120,0,0,${0.4 + 0.2 * eyeGlow})`;
  ctx.fillRect(sx - 6, top + 3, 3, 3);
  ctx.fillRect(sx + 4, top + 3, 3, 3);
  // Nose hole
  ctx.fillStyle = '#180e0e';
  ctx.fillRect(sx - 2, top + 9, 5, 3);
  // Mouth grill (3 horizontal bars)
  ctx.fillStyle = '#180e0e';
  ctx.fillRect(sx - 6, top + 13, 13, 1);
  ctx.fillRect(sx - 7, top + 15, 15, 1);
  ctx.fillRect(sx - 6, top + 17, 13, 1);
  // Vertical cage bars (4 bars)
  for (let bi = 0; bi < 4; bi++) {
    ctx.fillRect(sx - 6 + bi * 4, top + 12, 1, 6);
  }
  // Red diagonal stripes on mask
  ctx.fillStyle = 'rgba(170,10,10,0.82)';
  // Left cheek stripe
  ctx.fillRect(sx - 8, top + 5, 3, 1);
  ctx.fillRect(sx - 7, top + 6, 3, 1);
  ctx.fillRect(sx - 6, top + 7, 3, 1);
  // Right cheek stripe
  ctx.fillRect(sx + 6, top + 5, 3, 1);
  ctx.fillRect(sx + 5, top + 6, 3, 1);
  ctx.fillRect(sx + 4, top + 7, 3, 1);
  // Center red dot
  ctx.fillStyle = 'rgba(160,8,8,0.75)';
  ctx.fillRect(sx - 1, top + 1, 3, 2);

  // — Mask chin strap / dark hood —
  ctx.fillStyle = '#0e0e0a';
  ctx.fillRect(sx - 9, top + 17, 18, 4);

  ctx.restore();
}

function drawBackroomsMonster(sx, sy) {
  const t   = Date.now() / 380;
  const bob = Math.sin(t) * 3;
  const BW = 10;
  const BH = 80;
  const HH = 12;
  const legPhase = Math.sin(t * 1.4);

  ctx.save();
  ctx.shadowBlur  = 18;
  ctx.shadowColor = '#000';

  const by = sy - BH + bob;

  ctx.fillStyle = '#0a0a0a';
  const lOff = legPhase * 5;
  ctx.fillRect(sx - 5,  by + BH - 30 - lOff, 4, 30 + lOff);
  ctx.fillRect(sx + 1,  by + BH - 30 + lOff, 4, 30 - lOff);

  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(sx - BW / 2, by + HH, BW, BH - HH - 28);

  ctx.fillStyle = '#080808';
  const aOff = legPhase * 4;
  ctx.fillRect(sx - BW / 2 - 12, by + HH + 4 + aOff,  4, BH * 0.42);
  ctx.fillRect(sx + BW / 2 +  8, by + HH + 4 - aOff,  4, BH * 0.42);

  ctx.fillStyle = '#111';
  ctx.fillRect(sx - BW / 2, by, BW, HH);

  const eyeGlow = 0.75 + 0.25 * Math.sin(t * 2.1);
  ctx.shadowBlur  = 8;
  ctx.shadowColor = '#ff0000';
  ctx.fillStyle   = `rgba(255,20,0,${eyeGlow})`;
  ctx.fillRect(sx - 3, by + 3, 2, 3);
  ctx.fillRect(sx + 1, by + 3, 2, 3);

  ctx.restore();
}

function drawMonster() {
  const sx = Math.round(monster.x - cam.x);
  const sy = Math.round(monster.y - cam.y);
  if (sx < -80 || sx > canvas.width + 80 || sy < -80 || sy > canvas.height + 80) return;

  const BH = currentLocationId === LOCATION_FOREST_VILLAGE ? 76 : 80;

  if (currentLocationId === LOCATION_FOREST_VILLAGE) {
    drawJason(sx, sy);
  } else {
    drawBackroomsMonster(sx, sy);
  }

  // Stun effect — blue ring + spinning stars above head
  if (monsterStunTime > 0) {
    const stunPulse = 0.5 + 0.5 * Math.sin(Date.now() / 90);
    ctx.save();
    ctx.shadowBlur  = 18;
    ctx.shadowColor = '#44aaff';
    ctx.strokeStyle = `rgba(120,200,255,${0.6 + stunPulse * 0.4})`;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(sx, sy - BH / 2, BH / 2 + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Stars orbiting above head
    const t = Date.now() / 380;
    const by = sy - BH + Math.sin(t) * 3;
    const angle = Date.now() / 250;
    const stars = ['★', '★', '★'];
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let si = 0; si < stars.length; si++) {
      const a = angle + (si * Math.PI * 2) / stars.length;
      const ox = Math.cos(a) * 14;
      const oy = Math.sin(a) * 6 - 4;
      ctx.fillStyle = '#ffff44';
      ctx.fillText(stars[si], sx + ox, by - 10 + oy);
    }
    ctx.restore();
  }
}

function drawFearEffects() {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) return;
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
    document.getElementById('hudLevel').textContent = currentLocationName;
    return;
  }
  const secs = Math.ceil(speedBoostLeft);
  document.getElementById('hudLevel').textContent = `${currentLocationName}  BOOST x1.7 ${secs}s`;
}

function drawVignette() {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) return;
  const W = canvas.width, H = canvas.height;
  const grad = ctx.createRadialGradient(W/2, H/2, H*0.2, W/2, H/2, H*0.85);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.75)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawFlicker() {
  if (currentLocationId === LOCATION_FOREST_VILLAGE) return;
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
  ctx.fillText(currentLocationName, canvas.width/2, canvas.height/2 + 4);
  ctx.fillText(`Time: ${mm}:${ss}`, canvas.width/2, canvas.height/2 + 20);
  ctx.restore();
}

function rebuildMinimapBase() {
  const mw = 90;
  const mh = 90;
  const scx = mw / COLS;
  const scy = mh / ROWS;
  minimapBaseCanvas = document.createElement('canvas');
  minimapBaseCanvas.width = mw;
  minimapBaseCanvas.height = mh;
  const mc = minimapBaseCanvas.getContext('2d');

  mc.globalAlpha = 0.7;
  mc.fillStyle = '#1a1508';
  mc.fillRect(0, 0, mw, mh);

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const bits = maze[cellIndex(cx, cy)];
      if (bits <= 0) continue;
      if (currentLocationId === LOCATION_FOREST_VILLAGE && isRiverCell(cx, cy) && !isBridgeCell(cx, cy)) mc.fillStyle = '#23556a';
      else if (currentLocationId === LOCATION_FOREST_VILLAGE && isBridgeCell(cx, cy)) mc.fillStyle = '#7b6643';
      else if (isSafeCell(cx, cy)) mc.fillStyle = '#3f7c78';
      else if (currentLocationId === LOCATION_FOREST_VILLAGE && isHouseCell(cx, cy)) mc.fillStyle = '#705032';
      else if (currentLocationId === LOCATION_FOREST_VILLAGE && isPathCell(cx, cy)) mc.fillStyle = '#4e432b';
      else mc.fillStyle = currentLocationId === LOCATION_FOREST_VILLAGE ? '#203425' : '#8a7a3e';
      mc.fillRect(cx * scx, cy * scy, scx, scy);
    }
  }

  mc.fillStyle = '#3fc83f';
  mc.fillRect((COLS - 2) * scx - 1, (ROWS - 2) * scy - 1, scx + 2, scy + 2);
  mc.strokeStyle = '#c8b96a';
  mc.lineWidth = 1;
  mc.strokeRect(0, 0, mw, mh);
  mc.globalAlpha = 1;
}

// Mini-map
function drawMinimap() {
  const mw = 90, mh = 90;
  const mx = canvas.width - mw - 10;
  const my = 30;
  const scx = mw / COLS;
  const scy = mh / ROWS;

  ctx.save();
  if (minimapBaseCanvas) {
    ctx.drawImage(minimapBaseCanvas, mx, my);
  } else {
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#1a1508';
    ctx.fillRect(mx, my, mw, mh);
  }

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
    for (const [uid, playerData] of Object.entries(online.remoteVisuals)) {
      if (uid === online.localUid || playerData.alive === false) continue;
      ctx.fillStyle = playerData.color || colorForPlayer(uid);
      const rdx = ((playerData.displayX ?? playerData.targetX ?? 0) / CELL) * scx;
      const rdy = ((playerData.displayY ?? playerData.targetY ?? 0) / CELL) * scy;
      ctx.beginPath();
      ctx.arc(mx + rdx, my + rdy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

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
  ctx.fillStyle = currentLocationId === LOCATION_FOREST_VILLAGE ? '#09110b' : '#1a1508';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // World layer — translated by shake so HUD/effects stay fixed
  ctx.save();
  ctx.translate(Math.round(shakeX), Math.round(shakeY));
  drawMaze();
  drawSafeRooms();
  drawVillageHouses();
  drawVillageProps();
  drawAlmondWaters();
  drawWeapons();
  drawAimPreview();
  drawExit();
  drawBullets();
  drawMonster();
  drawRemotePlayers();
  drawPlayer();
  ctx.restore();

  // Screen-space effects (no shake)
  drawForestAtmosphere();
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
  online.roomLocationId = '';
  online.hostUid = '';
  online.players = {};
  online.monsterSnapshot = null;
  online.sharedPickedWaters = {};
  online.winState = null;
  online.safeFlags = {};
  online.remoteVisuals = {};
  online.lastSentSnapshot = null;
  cleanupRoomListeners();
  initializeWorld(hashString(`solo:${Date.now()}`), selectedCreateLocationId);
  restartGame({ resetSharedState: true });
  setOverlayVisible(false);
  window.history.replaceState({}, '', getRoomUrl(''));
}

async function bootstrapMultiplayerUi() {
  setSelectedCreateLocation(selectedCreateLocationId);

  for (const button of locationOptionButtons) {
    button.addEventListener('click', () => {
      setSelectedCreateLocation(button.dataset.locationOption);
    });
  }

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
    await joinRoom(roomId, { create: true, locationId: selectedCreateLocationId });
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
