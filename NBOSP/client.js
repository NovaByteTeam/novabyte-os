const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Increase Node.js heap size to prevent OOM crashes during heavy indexing
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --max-old-space-size=4096';

// Detect protocol same way server.js does
const hasCert = fs.existsSync(path.join(__dirname, 'cert.key')) &&
  fs.existsSync(path.join(__dirname, 'cert.crt'));
const protocol = hasCert ? 'https' : 'http';
const port = process.env.PORT || 3003;
const appUrl = `${protocol}://localhost:${port}`;

// Spawn server — on Windows NW.js is a GUI app so stdout isn't a real terminal.
// Write server logs to server.log so you can tail it if needed.
const logStream = fs.createWriteStream(path.join(__dirname, 'server.log'), { flags: 'a' });
const server = spawn('node', ['--max-old-space-size=4096', '--expose-gc', path.join(__dirname, 'server.js')], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

// Handle server crashes silently
server.on('exit', () => {
  // Server process ended
});

server.on('error', () => {
  // Server error occurred
});

// On Windows, nw.exe is a GUI subsystem binary with no real console attached.
// Try \\.\CONOUT$ to write to the parent console if available.
// Fallback: logs always land in server.log regardless.
let _conout = null;
if (process.platform === 'win32' && process.env.NW_SHOW_CONSOLE === 'true') {
  try {
    _conout = fs.createWriteStream('\\\\.\\CONOUT$', { flags: 'a' });
    _conout.on('error', () => { _conout = null; });
  } catch (_) { _conout = null; }
}

// Tee helper: write a chunk to the log file AND the terminal (if one is attached)
function tee(chunk, isErr) {
  logStream.write(chunk);
  if (_conout) {
    try { _conout.write(chunk); } catch (_) { }
  } else {
    try { (isErr ? process.stderr : process.stdout).write(chunk); } catch (_) { }
  }
}

// Open window once server is ready (detects "Address" in log) or after 3s fallback
let opened = false;
let win = null;
function openWindow() {
  if (opened) return;
  opened = true;
  nw.Window.open(appUrl, { title: 'NovaByte', width: 1280, height: 720 }, function (window) {
    win = window;
    // Prevent window from closing
    win.on('close', function () {
      server.kill();
      this.close(true); // true = bypass close event, actually close
      nw.App.quit();
    });
  });
}
server.stdout.on('data', d => { tee(d, false); if (d.toString().includes('Address')) openWindow(); });
server.stderr.on('data', d => tee(d, true));
// 8s timeout — gives server time to start on slow machines or first npm install
setTimeout(openWindow, 8000);

nw.App.on('quit', () => {
  server.kill();
  nw.App.quit();
});

// Register F11 to toggle fullscreen
nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: "F11",
  active: function () {
    if (win) win.toggleFullscreen();
  }
}));

// Register F12 to toggle devtools
nw.App.registerGlobalHotKey(new nw.Shortcut({
  key: "F12",
  active: function () {
    if (win) {
      win.showDevTools();
    }
  }
}));