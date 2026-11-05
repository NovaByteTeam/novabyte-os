const path = require('path');
const fs = require('fs');

// nw.App.startPath = real exe directory (log file lives here)
// __dirname        = inside package.nw (bin files live here)
const appDir = (typeof nw !== 'undefined' && nw.App && nw.App.startPath)
  ? nw.App.startPath
  : __dirname;

const hasCert = fs.existsSync(path.join(__dirname, 'cert.key')) &&
  fs.existsSync(path.join(__dirname, 'cert.crt'));
const protocol = hasCert ? 'https' : 'http';
const port = process.env.PORT || 3002;
const appUrl = `${protocol}://localhost:3002`;

const logStream = fs.createWriteStream(path.join(appDir, 'server.log'), { flags: 'a' });
function log(msg) {
  logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

log(`Starting NovaByte — appDir: ${appDir} | __dirname: ${__dirname}`);
log(`App URL: ${appUrl}`);

// ── Window management ──────────────────────────────────────────────────────
let opened = false;
let win = null;

function shutdown() {
  log('Shutting down.');
  nw.App.quit();
}

function openWindow() {
  if (opened) return;
  opened = true;
  log('Opening window → ' + appUrl);
  nw.Window.open(appUrl, { title: 'NovaByte V3', width: 1280, height: 720, show: true, position: 'center' }, function (w) {
    win = w;
    win.show();
    win.focus();
    win.on('close', shutdown);
  });
}

// ── Load server ────────────────────────────────────────────────────────────
process.chdir(__dirname);
log('Loading server...');
process.on('uncaughtException', (e) => {
  log('UNCAUGHT EXCEPTION: ' + e.message + '\n' + e.stack);
});
process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION: ' + String(reason));
});
try {
  require(path.join(__dirname, 'server.js'));
  log('server.js loaded OK');
} catch (e) {
  log('Server load error: ' + e.message);
}

// ── Poll until server responds ─────────────────────────────────────────────
const http = require('http');
const https = require('https');
const httpClient = protocol === 'https' ? https : http;
let pollAttempts = 0;
const MAX_POLL = 30;

function pollServer() {
  pollAttempts++;
  const req = httpClient.get(appUrl, { rejectUnauthorized: false }, (res) => {
    log(`Server ready (HTTP ${res.statusCode}) after ${pollAttempts} poll(s)`);
    openWindow();
  });
  req.on('error', () => {
    if (pollAttempts < MAX_POLL) setTimeout(pollServer, 300);
    else { log('Server did not respond after max polls — opening anyway'); openWindow(); }
  });
  req.setTimeout(500, () => req.destroy());
}

setTimeout(pollServer, 300);

// ── App lifecycle ──────────────────────────────────────────────────────────
nw.App.on('quit', shutdown);

nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: "F11",
  active: () => { if (win) win.toggleFullscreen(); }
}));