const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const RPC = require('discord-rpc');
const WebSocket = require('ws');

const USER_ID = fs.readFileSync(path.join(__dirname, '..', 'id'), 'utf-8').trim();
const CLIENT_ID = '1126057621254852678';
const LANYARD_URL = 'wss://api.lanyard.rest/socket';

const rpc = new RPC.Client({ transport: 'ipc' });

let spotify = null;
let lyrics = [];
let lineIndex = 0;
let lastSent = null;
let lastSentIndex = -1;
let fetchId = 0;
let fetching = false;
let appStartTime = 0;
let lastSpotifyKey = '';
let tray = null;

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function makeIcon(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) raw.push(r, g, b);
  }
  const compressed = zlib.deflateSync(Buffer.from(raw));
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function ensureRgbaPng(buf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.slice(0, 8).compare(sig) !== 0) return buf;
  let offset = 8;
  let width, height, colorType;
  let palette = null;
  let transparency = null;
  let rawData = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString();
    const data = buf.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') rawData.push(data);
  }
  if (colorType !== 3 || !palette) return buf;
  const pixels = zlib.inflateSync(Buffer.concat(rawData));
  const rowSize = 1 + width;
  const indices = Buffer.alloc(height * width);
  for (let y = 0; y < height; y++) {
    const filterType = pixels[y * rowSize];
    for (let x = 0; x < width; x++) {
      const raw = pixels[y * rowSize + 1 + x];
      const left = x > 0 ? indices[y * width + x - 1] : 0;
      const up = y > 0 ? indices[(y - 1) * width + x] : 0;
      const upLeft = x > 0 && y > 0 ? indices[(y - 1) * width + x - 1] : 0;
      let val;
      switch (filterType) {
        case 0: val = raw; break;
        case 1: val = (raw + left) & 0xFF; break;
        case 2: val = (raw + up) & 0xFF; break;
        case 3: val = (raw + Math.floor((left + up) / 2)) & 0xFF; break;
        case 4: {
          const p = left + up - upLeft;
          const pL = Math.abs(p - left), pU = Math.abs(p - up), pUL = Math.abs(p - upLeft);
          val = (raw + (pL <= pU && pL <= pUL ? left : pU <= pUL ? up : upLeft)) & 0xFF;
          break;
        }
        default: val = raw;
      }
      indices[y * width + x] = val;
    }
  }
  const outRaw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    outRaw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const idx = indices[y * width + x];
      const off = y * (1 + width * 4) + 1 + x * 4;
      outRaw[off] = palette[idx * 3] || 0;
      outRaw[off + 1] = palette[idx * 3 + 1] || 0;
      outRaw[off + 2] = palette[idx * 3 + 2] || 0;
      outRaw[off + 3] = transparency?.[idx] ?? 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(outRaw)), pngChunk('IEND', Buffer.alloc(0))]);
}

function toIco(pngBuf) {
  const width = pngBuf.readUInt32BE(16);
  const height = pngBuf.readUInt32BE(20);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(width >= 256 ? 0 : width, 0);
  entry.writeUInt8(height >= 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
  entry.writeUInt16LE(0, 4); entry.writeUInt16LE(0, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

let trayProcess = null;

function updateTrayStatus(text) {
  if (!trayProcess) return;
  try {
    const msg = JSON.stringify({ type: 'update-status', text: text.substring(0, 128) });
    if (process.platform === 'linux') {
      trayProcess.stdin.write(msg + '\n');
    } else {
      trayProcess.sendAction({ type: 'update-item', item: { title: text.substring(0, 128), tooltip: '', checked: false, enabled: false }, seq_id: 0 });
    }
  } catch {}
}

function initTray() {
  try {
    if (process.platform === 'linux') {
      const { spawn } = require('child_process');
      const customIcon = path.join(__dirname, '..', 'icon.png');
      const iconPath = fs.existsSync(customIcon) ? customIcon : path.join(os.tmpdir(), 'spotify-lyrics-rpc-icon.png');
      if (!fs.existsSync(customIcon)) try { fs.writeFileSync(iconPath, makeIcon(32, 29, 185, 84)); } catch {}
      trayProcess = spawn('python3', [path.join(__dirname, 'tray.py'), iconPath], { stdio: ['pipe', 'pipe', 'inherit'] });
      trayProcess.on('exit', () => process.exit(0));
      trayProcess.on('error', err => log('[tray] error:', err.message));
      const rl = require('readline').createInterface({ input: trayProcess.stdout });
      rl.on('line', line => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') log('[tray] initialized');
          if (msg.type === 'clicked' && msg.item === 'exit') { trayProcess.kill(); process.exit(0); }
        } catch {}
      });
    } else {
      if (!process.env.GDK_BACKEND) process.env.GDK_BACKEND = 'x11';
      const SysTray = require('systray2').default;
      const customIcon = path.join(__dirname, '..', 'icon.png');
      let iconBase64;
      if (fs.existsSync(customIcon)) {
        iconBase64 = toIco(ensureRgbaPng(fs.readFileSync(customIcon))).toString('base64');
      } else {
        iconBase64 = toIco(makeIcon(32, 29, 185, 84)).toString('base64');
      }
      trayProcess = new SysTray({
        menu: {
          icon: iconBase64, title: 'Spotify Lyrics RPC', tooltip: 'Spotify Lyrics RPC',
          items: [
            { title: 'Starting...', tooltip: '', checked: false, enabled: false },
            { title: '-', tooltip: '', checked: false, enabled: false },
            { title: 'Exit', tooltip: 'Quit the app', checked: false, enabled: true },
          ],
        }, debug: false, copyDir: true,
      });
      trayProcess.onClick(action => { if (action.seq_id === 2) { trayProcess.kill(); process.exit(0); } });
      log('[tray] initialized');
    }
  } catch (err) {
    log('[tray] init failed:', err.message);
  }
}

const CACHE_PATH = path.join(__dirname, '..', 'lyrics-cache.json');
let lyricCache = {};
try { lyricCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); } catch {}

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

rpc.on('ready', () => {
  log('[rpc] connected');
  initTray();
  connectLanyard();
});

rpc.login({ clientId: CLIENT_ID }).catch(err => {
  log('[rpc] login failed:', err.message);
});

function connectLanyard() {
  const ws = new WebSocket(LANYARD_URL);
  ws.on('open', () => {
    ws.send(JSON.stringify({ op: 2, d: { subscribe_to_id: USER_ID } }));
    log('[lanyard] connected');
  });
  ws.on('message', raw => {
    const { op, t, d } = JSON.parse(raw);
    if (op !== 0) return;
    if (t === 'INIT_STATE' && d.spotify) handleSpotify(d.spotify);
    if (t === 'PRESENCE_UPDATE') {
      if (d.spotify) handleSpotify(d.spotify);
      else handleSpotify(null);
    }
    if (t === 'SPOTIFY_UPDATE') handleSpotify(d);
  });
  ws.on('close', () => setTimeout(connectLanyard, 3000));
  ws.on('error', () => {});
}

function handleSpotify(s) {
  if (!s || !s.song) {
    if (spotify) log('[spotify] stopped');
    updateTrayStatus('Idle');
    lastSpotifyKey = '';
    spotify = null;
    lyrics = [];
    lineIndex = 0;
    lastSent = null;
    lastSentIndex = -1;
    rpc.clearActivity().catch(() => {});
    return;
  }

  const spotifyKey = `${s.song}|${s.artist}|${s.timestamps?.start}`;
  if (spotifyKey === lastSpotifyKey) return;
  lastSpotifyKey = spotifyKey;

  log(`[spotify] "${s.song}" — ${s.artist}`);
  updateTrayStatus(`♪ ${s.song} — ${s.artist}`);
  spotify = s;
  lyrics = [];
  lineIndex = 0;
  lastSent = null;
  lastSentIndex = -1;
  appStartTime = Date.now();
  fetching = true;
  const id = ++fetchId;
  syncTick();
  fetchLyrics(s.song, s.artist, s.album, id);
}

async function fetchLyrics(song, artist, album, id) {
  const cacheKey = `${song}|${artist}|${album}`;
  const cached = lyricCache[cacheKey];
  if (cached !== undefined) {
    log(`[lyrics] fetch #${id} — cache hit`);
    fetching = false;
    if (cached) {
      lyrics = groupLyrics(parseLRC(cached));
      lineIndex = 0;
      lastSent = null;
      lastSentIndex = -1;
      appStartTime = Date.now();
      log(`[lyrics] ${lyrics.length} grouped lines (cached)`);
      syncTick();
    } else {
      lastSent = null;
      lastSentIndex = -1;
      syncTick();
    }
    return;
  }

  const params = new URLSearchParams({ track_name: song, artist_name: artist, album_name: album });
  log(`[lyrics] fetch #${id} — requesting...`);
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://lrclib.net/api/get?${params}`, { signal: controller.signal });
    clearTimeout(t);
    log(`[lyrics] fetch #${id} — ${res.status} ${res.statusText}`);
    if (!res.ok) { lyricCache[cacheKey] = null; saveCache(); fetching = false; lastSent = null; lastSentIndex = -1; syncTick(); return; }
    const data = await res.json();
    if (id !== fetchId) { log(`[lyrics] fetch #${id} — stale, discarding`); return; }
    fetching = false;
    if (data.syncedLyrics) {
      lyricCache[cacheKey] = data.syncedLyrics;
      saveCache();
      lyrics = groupLyrics(parseLRC(data.syncedLyrics));
      lineIndex = 0;
      lastSent = null;
      lastSentIndex = -1;
      appStartTime = Date.now();
      log(`[lyrics] fetch #${id} — ${lyrics.length} grouped lines`);
      syncTick();
    } else {
      lyricCache[cacheKey] = null;
      saveCache();
      lastSent = null;
      lastSentIndex = -1;
      syncTick();
    }
  } catch (err) { log(`[lyrics] fetch #${id} — error: ${err.message}`); fetching = false; lastSent = null; lastSentIndex = -1; syncTick(); }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(lyricCache)); } catch {}
}

function parseLRC(lrc) {
  return lrc.split('\n').map(line => {
    const m = line.match(/\[(\d+):(\d+)\.(\d+)\](.*)/);
    if (!m) return null;
    const time = Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
    return { time, text: m[4].trim() };
  }).filter(Boolean);
}

function groupLyrics(lines, window = 1.0) {
  if (!lines.length) return [];
  const groups = [{ time: lines[0].time, texts: [lines[0].text] }];
  for (let i = 1; i < lines.length; i++) {
    const g = groups[groups.length - 1];
    const gap = lines[i].time - lines[i - 1].time;
    const short = lines[i].text.split(' ').length < 3;
    if ((gap <= window || short) && g.texts.length < 3) {
      const last = g.texts[g.texts.length - 1];
      const dupMatch = last.match(/^(.+) \(x(\d+)\)$/);
      if (dupMatch && dupMatch[1] === lines[i].text) {
        g.texts[g.texts.length - 1] = `${dupMatch[1]} (x${Number(dupMatch[2]) + 1})`;
      } else if (lines[i].text === last) {
        g.texts[g.texts.length - 1] = `${lines[i].text} (x2)`;
      } else {
        g.texts.push(lines[i].text);
      }
    } else {
      groups.push({ time: lines[i].time, texts: [lines[i].text] });
    }
  }
  return groups.map(g => ({ time: g.time, text: g.texts.join(' | ') }));
}

function syncTick() {
  if (!spotify) return;

  const elapsed = (Date.now() - (spotify.timestamps?.start || Date.now())) / 1000;

  if (lyrics.length > 0) {
    if (lineIndex >= lyrics.length) lineIndex = Math.max(0, lyrics.length - 2);
    while (lineIndex < lyrics.length - 2 && lyrics[lineIndex + 2].time <= elapsed) {
      lineIndex += 2;
    }
  }

  const current = lyrics.length > 0 ? lyrics[lineIndex].text : '';
  const preview = lyrics.length > 0 && lineIndex + 1 < lyrics.length ? lyrics[lineIndex + 1].text : null;
  const pairKey = current + '|||' + preview;

  if (pairKey === lastSent && lineIndex === lastSentIndex) return;
  lastSent = pairKey;
  lastSentIndex = lineIndex;
  log(`[rpc] send: "${(current || '♫ ').substring(0, 50)}" | "${(preview || '♫ ').substring(0, 50)}"`);
  updateTrayStatus(spotify ? `♪ ${spotify.song} — ${spotify.artist}` : 'Idle');

  const albumArtId = spotify.album_art_url?.match(/\/image\/(.+)$/)?.[1];

  let details, state;
  if (lyrics.length > 0) {
    details = (current || '♪').substring(0, 128);
    state = (preview || '♫ ').substring(0, 128);
  } else if (fetching) {
    details = 'Fetching lyrics...';
    state = '♫ ';
  } else {
    details = `${spotify.song}`.substring(0, 128);
    state = 'Lyrics not found';
  }

  rpc.setActivity({
    details,
    state,
    largeImageKey: albumArtId ? `spotify:${albumArtId}` : undefined,
    largeImageText: spotify.album || spotify.song,
    startTimestamp: Math.floor((appStartTime || Date.now()) / 1000),
    instance: false,
  }).catch(err => {
    if (err.message && err.message.toLowerCase().includes('rate')) {
      log(`[rpc] RATE LIMITED: ${err.message}`);
    } else {
      log(`[rpc] error: ${err.message}`);
    }
  });
}

setInterval(syncTick, 200);
log('[boot] ready');
